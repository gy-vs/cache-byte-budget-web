/**
 * In-memory Vary-aware response cache.
 *
 * Keys are the canonical strings produced by vary.ts. Filling is single-flight:
 * concurrent requests that select the same canonical key share one origin
 * fill. A fill result is only stored when its revision still matches the
 * current resource revision, so an origin response for an old revision can
 * never overwrite an entry produced for a newer one.
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
};

export type FillOutcome = {
  payload: CachedPayload;
  revision: number;
  /** false when the revision observed during the fill is already stale. */
  fresh: boolean;
};

export type LookupResult =
  | {kind: 'hit'; entry: CachedEntry}
  | {kind: 'miss'; reason: 'origin-fill' | 'revision-updated'};

export class VaryCache {
  private entries = new Map<string, CachedEntry>();
  /** resource -> set of canonical strings that currently hold entries. */
  private byResource = new Map<string, Set<string>>();
  /** canonical key -> shared in-flight fill. */
  private inflight = new Map<string, Promise<FillOutcome>>();
  /** Resources that have ever received a PUT invalidation (cache-lifetime). */
  private invalidated = new Set<string>();

  lookup(canonicalKey: string, resource: string): LookupResult {
    const entry = this.entries.get(canonicalKey);
    if (entry) return {kind: 'hit', entry};
    // After a PUT the variants of this resource were purged, so the miss is
    // caused by invalidation rather than a cold cache.
    if (this.invalidated.has(resource)) {
      return {kind: 'miss', reason: 'revision-updated'};
    }
    return {kind: 'miss', reason: 'origin-fill'};
  }

  /** Removes every stored variant of one resource (called after a PUT). */
  invalidate(resource: string) {
    const keys = this.byResource.get(resource);
    let removed = 0;
    if (keys) {
      for (const key of keys) {
        if (this.entries.delete(key)) removed += 1;
      }
      keys.clear();
    }
    this.invalidated.add(resource);
    return removed;
  }

  /**
   * Runs the producer once per canonical key; concurrent callers join the same
   * fill. The result is stored only for the leader, and only when fresh.
   * Joining callers are told how they were served via the returned reason.
   */
  async fill(
    key: CanonicalKey,
    resource: string,
    currentRevision: number,
    produce: () => Promise<FillOutcome>,
  ): Promise<{outcome: FillOutcome; reason: 'origin-fill' | 'concurrent-fill-joined'}> {
    const canonical = key.canonical;
    const existing = this.inflight.get(canonical);
    if (existing) {
      return {outcome: await existing, reason: 'concurrent-fill-joined'};
    }

    const promise = produce()
      .then((outcome) => {
        // Commit guard: never store a response generated for an old revision.
        if (outcome.fresh && outcome.revision === currentRevision) {
          this.store(canonical, resource, outcome.revision, outcome.payload);
        }
        return outcome;
      })
      .finally(() => {
        this.inflight.delete(canonical);
      });

    this.inflight.set(canonical, promise);
    return {outcome: await promise, reason: 'origin-fill'};
  }

  /**
   * Stores an entry built outside the fill helper, still refusing stale
   * revisions. Used by the server when a joined fill resolved after the
   * resource had moved on and a synchronous rebuild is needed.
   */
  private store(
    canonical: string,
    resource: string,
    revision: number,
    payload: CachedPayload,
  ): boolean {
    const held = this.entries.get(canonical);
    if (held && held.revision > revision) return false;
    this.entries.set(canonical, {
      ...payload,
      resource,
      revision,
      storedAt: Date.now(),
    });
    let set = this.byResource.get(resource);
    if (!set) {
      set = new Set();
      this.byResource.set(resource, set);
    }
    set.add(canonical);
    return true;
  }

  get size() {
    return this.entries.size;
  }
}
