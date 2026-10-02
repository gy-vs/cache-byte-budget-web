/**
 * In-memory Vary-aware response cache with an optional entity-byte budget.
 *
 * Keys are the canonical strings produced by vary.ts. Filling is single-flight:
 * concurrent requests that select the same canonical key share one origin
 * fill. A fill result is only stored when its revision still matches the
 * current resource revision, so an origin response for an old revision can
 * never overwrite an entry produced for a newer one.
 *
 * Capacity: budgetBytes (null = unbounded) caps the sum of stored response
 * body bytes — the bytes actually held per variant, so a gzip representation
 * and its identity twin are charged independently. Entries are evicted
 * least-recently-used first and a hit refreshes recency, so no resource or
 * variant is permanently excluded by a fixed order. The budget is enforced at
 * commit time: a fill that resolves after the budget was shrunk must fit the
 * new budget, otherwise it is served but not stored.
 */
import type {CanonicalKey} from './vary';

export type CachedPayload = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type CachedEntry = CachedPayload & {
  resource: string;
  revision: number;
  storedAt: number;
  /** Stored response entity bytes charged against the budget. */
  bytes: number;
};

export type FillOutcome = {
  payload: CachedPayload;
  revision: number;
  /** false when the revision observed during the fill is already stale. */
  fresh: boolean;
};

export type EvictedEntry = {
  canonical: string;
  resource: string;
  revision: number;
  bytes: number;
};

export type CommitInfo = {
  stored: boolean;
  /** Variants dropped to make room for this commit, LRU first. */
  evicted: EvictedEntry[];
  reason?: 'exceeds-budget' | 'stale-revision';
};

export type LookupResult =
  | {kind: 'hit'; entry: CachedEntry}
  | {kind: 'miss'; reason: 'origin-fill' | 'revision-updated' | 'capacity-evicted'};

export type CacheStats = {
  budgetBytes: number | null;
  usedBytes: number;
  entryCount: number;
  resources: Array<{
    resource: string;
    bytes: number;
    /** LRU → MRU. */
    variants: Array<{canonical: string; revision: number; bytes: number; storedAt: number}>;
  }>;
};

type SettledFill = {outcome: FillOutcome; commit: CommitInfo};

/** How many canonical keys remember "evicted for capacity" as their miss cause. */
const EVICTION_MEMORY = 500;

export class VaryCache {
  /** Insertion order doubles as LRU order: hits re-insert at the tail. */
  private entries = new Map<string, CachedEntry>();
  /** resource -> set of canonical strings that currently hold entries. */
  private byResource = new Map<string, Set<string>>();
  /** canonical key -> shared in-flight fill. */
  private inflight = new Map<string, Promise<SettledFill>>();
  /** Resources that have ever received a PUT invalidation (cache-lifetime). */
  private invalidated = new Set<string>();
  /** Canonical keys whose last disappearance was a capacity eviction. */
  private evictedKeys = new Set<string>();
  private budgetBytes: number | null = null;
  private usedBytes = 0;

  lookup(canonicalKey: string, resource: string): LookupResult {
    const entry = this.entries.get(canonicalKey);
    if (entry) {
      // Refresh recency: a hit makes this variant the last eviction candidate.
      this.entries.delete(canonicalKey);
      this.entries.set(canonicalKey, entry);
      return {kind: 'hit', entry};
    }
    // After a PUT the variants of this resource were purged, so the miss is
    // caused by invalidation rather than a cold cache.
    if (this.invalidated.has(resource)) {
      return {kind: 'miss', reason: 'revision-updated'};
    }
    if (this.evictedKeys.has(canonicalKey)) {
      return {kind: 'miss', reason: 'capacity-evicted'};
    }
    return {kind: 'miss', reason: 'origin-fill'};
  }

  /** Removes every stored variant of one resource (called after a PUT). */
  invalidate(resource: string): {removed: number; freedBytes: number} {
    const keys = this.byResource.get(resource);
    let removed = 0;
    let freedBytes = 0;
    if (keys) {
      for (const key of [...keys]) {
        const dropped = this.remove(key);
        if (dropped) {
          removed += 1;
          freedBytes += dropped.bytes;
        }
      }
    }
    this.invalidated.add(resource);
    return {removed, freedBytes};
  }

  /**
   * Updates the byte budget and immediately evicts LRU variants until the
   * stored bytes fit. Returns what was dropped so callers can report which
   * existing variants are no longer retained.
   */
  setBudget(budgetBytes: number | null): EvictedEntry[] {
    this.budgetBytes = budgetBytes;
    return this.evictToFit(0);
  }

  /**
   * Runs the producer once per canonical key; concurrent callers join the same
   * fill. The result is stored only when fresh, and only if it fits the budget
   * in effect at commit time. Joining callers see the same commit outcome
   * (stored or not, and what was evicted) via the returned commit info.
   */
  async fill(
    key: CanonicalKey,
    resource: string,
    currentRevision: number,
    produce: () => Promise<FillOutcome>,
  ): Promise<SettledFill & {reason: 'origin-fill' | 'concurrent-fill-joined'}> {
    const canonical = key.canonical;
    const existing = this.inflight.get(canonical);
    if (existing) {
      return {...(await existing), reason: 'concurrent-fill-joined'};
    }

    const promise = produce()
      .then((outcome): SettledFill => {
        // Commit guard: never store a response generated for an old revision.
        if (outcome.fresh && outcome.revision === currentRevision) {
          return {
            outcome,
            commit: this.store(canonical, resource, outcome.revision, outcome.payload),
          };
        }
        return {outcome, commit: {stored: false, evicted: [], reason: 'stale-revision'}};
      })
      .finally(() => {
        this.inflight.delete(canonical);
      });

    this.inflight.set(canonical, promise);
    return {...(await promise), reason: 'origin-fill'};
  }

  /**
   * Stores an entry, still refusing stale revisions. A payload larger than the
   * whole budget is never stored (and evicts nothing); otherwise LRU variants
   * are dropped until the new entry fits.
   */
  private store(
    canonical: string,
    resource: string,
    revision: number,
    payload: CachedPayload,
  ): CommitInfo {
    const held = this.entries.get(canonical);
    if (held && held.revision > revision) {
      return {stored: false, evicted: [], reason: 'stale-revision'};
    }
    if (held) this.remove(canonical);

    const bytes = payload.body.length;
    if (this.budgetBytes !== null && bytes > this.budgetBytes) {
      return {stored: false, evicted: [], reason: 'exceeds-budget'};
    }

    const evicted = this.evictToFit(bytes);
    this.entries.set(canonical, {
      ...payload,
      resource,
      revision,
      storedAt: Date.now(),
      bytes,
    });
    this.usedBytes += bytes;
    let set = this.byResource.get(resource);
    if (!set) {
      set = new Set();
      this.byResource.set(resource, set);
    }
    set.add(canonical);
    this.evictedKeys.delete(canonical);
    return {stored: true, evicted};
  }

  /** Deletes one entry, keeping usage and the per-resource index consistent. */
  private remove(canonical: string): EvictedEntry | null {
    const entry = this.entries.get(canonical);
    if (!entry) return null;
    this.entries.delete(canonical);
    this.usedBytes -= entry.bytes;
    const set = this.byResource.get(entry.resource);
    if (set) {
      set.delete(canonical);
      if (set.size === 0) this.byResource.delete(entry.resource);
    }
    return {
      canonical,
      resource: entry.resource,
      revision: entry.revision,
      bytes: entry.bytes,
    };
  }

  /** Evicts least-recently-used entries until `incoming` more bytes fit. */
  private evictToFit(incoming: number): EvictedEntry[] {
    const evicted: EvictedEntry[] = [];
    if (this.budgetBytes === null) return evicted;
    while (this.usedBytes + incoming > this.budgetBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const dropped = this.remove(oldest.value);
      if (!dropped) break;
      this.rememberEviction(dropped.canonical);
      evicted.push(dropped);
    }
    return evicted;
  }

  private rememberEviction(canonical: string) {
    this.evictedKeys.delete(canonical);
    this.evictedKeys.add(canonical);
    // Bound the tombstone memory: only the most recent evictions are recalled.
    while (this.evictedKeys.size > EVICTION_MEMORY) {
      const oldest = this.evictedKeys.keys().next();
      if (oldest.done) break;
      this.evictedKeys.delete(oldest.value);
    }
  }

  /** Server-side source of truth for usage and per-variant occupancy. */
  stats(): CacheStats {
    const resources = new Map<string, CacheStats['resources'][number]>();
    for (const [canonical, entry] of this.entries) {
      let group = resources.get(entry.resource);
      if (!group) {
        group = {resource: entry.resource, bytes: 0, variants: []};
        resources.set(entry.resource, group);
      }
      group.bytes += entry.bytes;
      group.variants.push({
        canonical,
        revision: entry.revision,
        bytes: entry.bytes,
        storedAt: entry.storedAt,
      });
    }
    return {
      budgetBytes: this.budgetBytes,
      usedBytes: this.usedBytes,
      entryCount: this.entries.size,
      resources: [...resources.values()],
    };
  }

  get size() {
    return this.entries.size;
  }
}
