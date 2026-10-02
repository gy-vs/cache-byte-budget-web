/**
 * In-memory Vary-aware response cache with an optional capacity budget.
 *
 * Keys are the canonical strings produced by vary.ts. Filling is single-flight:
 * concurrent requests that select the same canonical key share one origin
 * fill. A fill result is only stored when its revision still matches the
 * current resource revision, so an origin response for an old revision can
 * never overwrite an entry produced for a newer one.
 *
 * Capacity: `budgetBytes` caps the sum of stored entity bytes — the response
 * bodies exactly as stored, so a gzipped variant and its identity twin are
 * charged their real, different sizes. `null` means unbounded. Entries are
 * ordered least-recently-used first: hits and stores refresh recency, and
 * eviction always takes the LRU entry regardless of which resource it belongs
 * to, so no resource is permanently excluded by a fixed order. A payload
 * larger than the whole budget is served to its request but never stored, so
 * later requests cannot see a false hit. The budget is evaluated when a fill
 * commits, therefore a budget change landing while a fill is in flight still
 * applies to that fill's store.
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
  /** Stored entity bytes charged against the budget. */
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
  bytes: number;
};

export type CommitResult = {
  /** True when the fill result was actually stored. */
  stored: boolean;
  /** Why a store attempt was refused. */
  reason?: 'exceeds-budget' | 'stale-revision';
  /** Entity bytes of the payload the fill tried to store. */
  bytes: number;
  /** Entries evicted to make room for this store. */
  evicted: EvictedEntry[];
};

/** Why a lookup found no usable entry. */
export type MissCause = 'cold' | 'revision-updated' | 'evicted-capacity' | 'exceeds-budget';

export type LookupResult =
  | {kind: 'hit'; entry: CachedEntry}
  | {kind: 'miss'; reason: MissCause};

export type CacheStats = {
  budgetBytes: number | null;
  usedBytes: number;
  entryCount: number;
  /** Most recently used first; eviction takes from the end of this list. */
  entries: Array<{
    canonical: string;
    resource: string;
    revision: number;
    bytes: number;
    storedAt: number;
    contentEncoding: string;
  }>;
  resources: Array<{resource: string; variants: number; bytes: number}>;
};

/** Upper bound for the diagnostic absence-cause bookkeeping map. */
const ABSENCE_TRACKING_LIMIT = 500;

export class VaryCache {
  /** canonical -> entry; iteration order is LRU first, MRU last. */
  private entries = new Map<string, CachedEntry>();
  /** resource -> set of canonical strings that currently hold entries. */
  private byResource = new Map<string, Set<string>>();
  /** canonical key -> shared in-flight fill. */
  private inflight = new Map<string, Promise<{outcome: FillOutcome; commit: CommitResult | null}>>();
  /** Resources that have ever received a PUT invalidation (cache-lifetime). */
  private invalidated = new Set<string>();
  /** canonical -> why the representation last seen for it is absent. */
  private absence = new Map<
    string,
    {cause: 'evicted-capacity' | 'exceeds-budget'; resource: string}
  >();
  private budgetBytes: number | null = null;
  private usedBytes = 0;

  lookup(canonicalKey: string, resource: string): LookupResult {
    const entry = this.entries.get(canonicalKey);
    if (entry) {
      // A hit refreshes recency: this entry is now the most recently used.
      this.entries.delete(canonicalKey);
      this.entries.set(canonicalKey, entry);
      return {kind: 'hit', entry};
    }
    // Most specific cause first: a capacity removal recorded for this exact
    // key, then a resource-wide invalidation, otherwise a cold cache.
    const absent = this.absence.get(canonicalKey);
    if (absent) return {kind: 'miss', reason: absent.cause};
    if (this.invalidated.has(resource)) {
      return {kind: 'miss', reason: 'revision-updated'};
    }
    return {kind: 'miss', reason: 'cold'};
  }

  /** Removes every stored variant of one resource (called after a PUT). */
  invalidate(resource: string): {removed: number; freedBytes: number} {
    const keys = this.byResource.get(resource);
    let removed = 0;
    let freedBytes = 0;
    if (keys) {
      for (const key of keys) {
        const entry = this.entries.get(key);
        if (entry) {
          this.entries.delete(key);
          this.usedBytes -= entry.bytes;
          freedBytes += entry.bytes;
          removed += 1;
        }
      }
      this.byResource.delete(resource);
    }
    // The invalidation supersedes any earlier capacity-removal cause recorded
    // for this resource — including variants already evicted before the PUT.
    for (const [key, absent] of this.absence) {
      if (absent.resource === resource) this.absence.delete(key);
    }
    this.invalidated.add(resource);
    return {removed, freedBytes};
  }

  /**
   * Sets the capacity budget in stored entity bytes (`null` = unbounded) and
   * immediately evicts least-recently-used entries until the cache fits.
   * Returns the evicted entries so callers can report what stopped being
   * retained.
   */
  setBudget(budgetBytes: number | null): {evicted: EvictedEntry[]} {
    this.budgetBytes = budgetBytes;
    return {evicted: this.evictToBudget()};
  }

  /**
   * Runs the producer once per canonical key; concurrent callers join the same
   * fill. The result is stored only for the leader, only when fresh, and only
   * if it fits the budget in effect at commit time. Every caller — leader or
   * joiner — receives the same commit result, so waiters can tell whether the
   * shared fill was retained.
   */
  async fill(
    key: CanonicalKey,
    resource: string,
    currentRevision: number,
    produce: () => Promise<FillOutcome>,
  ): Promise<{
    outcome: FillOutcome;
    reason: 'origin-fill' | 'concurrent-fill-joined';
    commit: CommitResult | null;
  }> {
    const canonical = key.canonical;
    const existing = this.inflight.get(canonical);
    if (existing) {
      const shared = await existing;
      return {...shared, reason: 'concurrent-fill-joined'};
    }

    const promise = produce()
      .then((outcome) => {
        // Commit guard: never store a response generated for an old revision.
        // The budget is read inside store(), i.e. at commit time, so a budget
        // change that landed while this fill was in flight is honored.
        let commit: CommitResult | null = null;
        if (outcome.fresh && outcome.revision === currentRevision) {
          commit = this.store(canonical, resource, outcome.revision, outcome.payload);
        }
        return {outcome, commit};
      })
      .finally(() => {
        this.inflight.delete(canonical);
      });

    this.inflight.set(canonical, promise);
    const shared = await promise;
    return {...shared, reason: 'origin-fill'};
  }

  /**
   * Stores an entry, charging its actual stored bytes against the budget and
   * evicting least-recently-used entries until the cache fits again. Refuses
   * payloads that can never fit and responses for superseded revisions.
   */
  private store(
    canonical: string,
    resource: string,
    revision: number,
    payload: CachedPayload,
  ): CommitResult {
    const bytes = payload.body.length;
    const result: CommitResult = {stored: false, bytes, evicted: []};

    if (this.budgetBytes !== null && bytes > this.budgetBytes) {
      // Served to the current request by the caller, but never retained.
      result.reason = 'exceeds-budget';
      this.recordAbsence(canonical, 'exceeds-budget', resource);
      return result;
    }

    const held = this.entries.get(canonical);
    if (held && held.revision > revision) {
      result.reason = 'stale-revision';
      return result;
    }

    if (held) {
      this.usedBytes -= held.bytes;
      this.entries.delete(canonical);
    }
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
    this.absence.delete(canonical);
    result.stored = true;

    // The new entry is the most recently used, so it is evicted last; since
    // it fits the budget on its own, this loop always terminates with it kept.
    result.evicted = this.evictToBudget();
    return result;
  }

  /** Evicts least-recently-used entries until usage is within the budget. */
  private evictToBudget(): EvictedEntry[] {
    const evicted: EvictedEntry[] = [];
    if (this.budgetBytes === null) return evicted;
    while (this.usedBytes > this.budgetBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const canonical = oldest.value;
      const entry = this.entries.get(canonical);
      if (!entry) break;
      this.entries.delete(canonical);
      this.usedBytes -= entry.bytes;
      const set = this.byResource.get(entry.resource);
      if (set) {
        set.delete(canonical);
        if (set.size === 0) this.byResource.delete(entry.resource);
      }
      this.recordAbsence(canonical, 'evicted-capacity', entry.resource);
      evicted.push({canonical, resource: entry.resource, bytes: entry.bytes});
    }
    return evicted;
  }

  private recordAbsence(
    canonical: string,
    cause: 'evicted-capacity' | 'exceeds-budget',
    resource: string,
  ) {
    this.absence.delete(canonical);
    this.absence.set(canonical, {cause, resource});
    // Diagnostic bookkeeping only — keep it bounded.
    while (this.absence.size > ABSENCE_TRACKING_LIMIT) {
      const oldest = this.absence.keys().next();
      if (oldest.done) break;
      this.absence.delete(oldest.value);
    }
  }

  /** Authoritative snapshot for reconciling usage from the server side. */
  stats(): CacheStats {
    const entries = [...this.entries.entries()].reverse().map(([canonical, entry]) => ({
      canonical,
      resource: entry.resource,
      revision: entry.revision,
      bytes: entry.bytes,
      storedAt: entry.storedAt,
      contentEncoding: entry.headers['content-encoding'] ?? 'identity',
    }));
    const byResourceAgg = new Map<string, {resource: string; variants: number; bytes: number}>();
    for (const entry of entries) {
      const agg = byResourceAgg.get(entry.resource) ?? {
        resource: entry.resource,
        variants: 0,
        bytes: 0,
      };
      agg.variants += 1;
      agg.bytes += entry.bytes;
      byResourceAgg.set(entry.resource, agg);
    }
    return {
      budgetBytes: this.budgetBytes,
      usedBytes: this.usedBytes,
      entryCount: this.entries.size,
      entries,
      resources: [...byResourceAgg.values()],
    };
  }

  get size() {
    return this.entries.size;
  }
}
