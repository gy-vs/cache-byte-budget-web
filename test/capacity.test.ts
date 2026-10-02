import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Express} from 'express';
import {createApp} from '../src/server/index';
import {
  evictionsHeader,
  jsonBody,
  keyHeader,
  rawRequest,
  storedBytes,
} from './http';

const ALPHA = '/api/experiments/alpha';
const BETA = '/api/experiments/beta';

type CacheState = {
  budgetBytes: number | null;
  usedBytes: number;
  entryCount: number;
  resources: Array<{
    resource: string;
    bytes: number;
    variants: Array<{canonical: string; revision: number; bytes: number; storedAt: number}>;
  }>;
};

/** Server-side cache truth — tests never estimate usage client-side. */
async function cacheState(app: Express): Promise<CacheState> {
  const res = await request(app).get('/api/cache').expect(200);
  return res.body as CacheState;
}

async function setBudget(app: Express, budgetBytes: number | null) {
  const res = await request(app).put('/api/cache/budget').send({budgetBytes}).expect(200);
  return res.body as {
    budgetBytes: number | null;
    usedBytes: number;
    evicted: Array<{canonical: string; resource: string; revision: number; bytes: number}>;
    evictedBytes: number;
  };
}

const locale = (value: string): Array<[string, string]> => [['x-locale', value]];
const gzipLocale = (value: string): Array<[string, string]> => [
  ['accept-encoding', 'gzip'],
  ['x-locale', value],
];
const language = (value: string): Array<[string, string]> => [['accept-language', value]];

describe('cache capacity budget', () => {
  it('rejects malformed budgets', async () => {
    const app = createApp();
    await request(app).put('/api/cache/budget').send({budgetBytes: -1}).expect(400);
    await request(app).put('/api/cache/budget').send({budgetBytes: 1.5}).expect(400);
    await request(app).put('/api/cache/budget').send({budgetBytes: 'lots'}).expect(400);
  });

  it('accounts real stored bytes per variant, gzip differing from identity', async () => {
    const app = createApp();
    const identity = await rawRequest(app, ALPHA, {headers: locale('sized')});
    const gz = await rawRequest(app, ALPHA, {headers: gzipLocale('sized')});
    expect(identity.headers['x-cache-stored']).toBe('true');
    expect(gz.headers['x-cache-stored']).toBe('true');

    const identityBytes = storedBytes(identity);
    const gzipBytes = storedBytes(gz);
    // Same source text, different stored representations.
    expect(gzipBytes).not.toBe(identityBytes);

    const state = await cacheState(app);
    expect(state.budgetBytes).toBeNull();
    expect(state.entryCount).toBe(2);
    expect(state.usedBytes).toBe(identityBytes + gzipBytes);
    const group = state.resources.find((r) => r.resource === ALPHA);
    expect(group?.bytes).toBe(identityBytes + gzipBytes);
    expect(group?.variants.map((v) => v.bytes).sort((a, b) => a - b)).toEqual(
      [identityBytes, gzipBytes].sort((a, b) => a - b),
    );
  });

  it('evicts the least-recently-used variant when a fill would exceed the budget', async () => {
    const app = createApp();
    const one = await rawRequest(app, ALPHA, {headers: locale('one')});
    const bytes = storedBytes(one);
    await setBudget(app, bytes * 2);

    await rawRequest(app, ALPHA, {headers: locale('two')});
    const three = await rawRequest(app, ALPHA, {headers: locale('three')});
    // 'three' needed room: exactly the oldest variant ('one') was dropped.
    expect(three.headers['x-cache-stored']).toBe('true');
    expect(evictionsHeader(three).map((e) => e.canonical)).toEqual([keyHeader(one).canonical]);

    const state = await cacheState(app);
    expect(state.usedBytes).toBe(bytes * 2);
    expect(state.entryCount).toBe(2);

    // The evicted variant misses with the capacity cause; its refill evicts
    // the now-oldest 'two'.
    const oneAgain = await rawRequest(app, ALPHA, {headers: locale('one')});
    expect(oneAgain.headers['x-cache-status']).toBe('MISS');
    expect(oneAgain.headers['x-cache-reason']).toBe('capacity-evicted');
    const threeAgain = await rawRequest(app, ALPHA, {headers: locale('three')});
    expect(threeAgain.headers['x-cache-status']).toBe('HIT');
    const twoAgain = await rawRequest(app, ALPHA, {headers: locale('two')});
    expect(twoAgain.headers['x-cache-status']).toBe('MISS');
    expect(twoAgain.headers['x-cache-reason']).toBe('capacity-evicted');
  });

  it('treats a hit as use, so the untouched variant is evicted first', async () => {
    const app = createApp();
    const a = await rawRequest(app, ALPHA, {headers: locale('a')});
    const bytes = storedBytes(a);
    await setBudget(app, bytes * 2);
    const b = await rawRequest(app, ALPHA, {headers: locale('b')});

    const aHit = await rawRequest(app, ALPHA, {headers: locale('a')});
    expect(aHit.headers['x-cache-status']).toBe('HIT');

    const c = await rawRequest(app, ALPHA, {headers: locale('c')});
    // 'a' was just used, so 'b' is the eviction candidate.
    expect(evictionsHeader(c).map((e) => e.canonical)).toEqual([keyHeader(b).canonical]);
    expect((await rawRequest(app, ALPHA, {headers: locale('a')})).headers['x-cache-status']).toBe(
      'HIT',
    );
    const bAgain = await rawRequest(app, ALPHA, {headers: locale('b')});
    expect(bAgain.headers['x-cache-status']).toBe('MISS');
    expect(bAgain.headers['x-cache-reason']).toBe('capacity-evicted');
  });

  it('evicts by recency across resources, so a refilled variant is retained', async () => {
    const app = createApp();
    const a1 = await rawRequest(app, ALPHA, {headers: locale('fair-1')});
    const b1 = await rawRequest(app, BETA, {headers: language('en')});
    await setBudget(app, storedBytes(a1) + storedBytes(b1));

    // A second alpha variant evicts the oldest entry overall (alpha fair-1).
    const a2 = await rawRequest(app, ALPHA, {headers: locale('fair-2')});
    expect(evictionsHeader(a2).map((e) => e.canonical)).toEqual([keyHeader(a1).canonical]);
    // Using beta makes the alpha variant the oldest.
    expect((await rawRequest(app, BETA, {headers: language('en')})).headers['x-cache-status']).toBe(
      'HIT',
    );

    // Refilling fair-1 evicts alpha fair-2 (now oldest), not "the other
    // resource by rule": the refilled variant itself is retained.
    const a1Again = await rawRequest(app, ALPHA, {headers: locale('fair-1')});
    expect(a1Again.headers['x-cache-status']).toBe('MISS');
    expect(evictionsHeader(a1Again).map((e) => e.canonical)).toEqual([keyHeader(a2).canonical]);
    expect((await rawRequest(app, ALPHA, {headers: locale('fair-1')})).headers['x-cache-status']).toBe(
      'HIT',
    );
    expect((await rawRequest(app, BETA, {headers: language('en')})).headers['x-cache-status']).toBe(
      'HIT',
    );

    const state = await cacheState(app);
    expect(state.usedBytes).toBe(storedBytes(a1) + storedBytes(b1));
  });

  it('serves an over-budget response without storing it, so later requests never false-hit', async () => {
    const app = createApp();
    const probe = await rawRequest(app, ALPHA, {headers: locale('measure')});
    const bytes = storedBytes(probe);
    await setBudget(app, bytes - 1);

    const first = await rawRequest(app, ALPHA, {headers: locale('heavy')});
    expect(first.status).toBe(200);
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(first.headers['x-cache-reason']).toBe('origin-fill');
    expect(first.headers['x-cache-stored']).toBe('false');
    expect(first.headers['x-cache-not-stored-reason']).toBe('exceeds-budget');
    expect(jsonBody(first).id).toBe('alpha');

    // The same request must not become a hit: nothing was retained.
    const second = await rawRequest(app, ALPHA, {headers: locale('heavy')});
    expect(second.headers['x-cache-status']).toBe('MISS');
    expect(second.headers['x-cache-stored']).toBe('false');

    const state = await cacheState(app);
    expect(state.usedBytes).toBe(0);
    expect(state.entryCount).toBe(0);
  });

  it('shrinking the budget evicts existing variants and reports exactly which', async () => {
    const app = createApp();
    const s1 = await rawRequest(app, ALPHA, {headers: locale('s1')});
    const s2 = await rawRequest(app, ALPHA, {headers: locale('s2')});
    const b1 = await rawRequest(app, BETA, {headers: language('en')});
    const alphaBytes = storedBytes(s1);
    const betaBytes = storedBytes(b1);

    const budget = Math.max(alphaBytes, betaBytes);
    const result = await setBudget(app, budget);
    // LRU order was s1, s2, b1: both alpha variants are dropped, beta stays.
    expect(result.budgetBytes).toBe(budget);
    expect(result.usedBytes).toBe(betaBytes);
    expect(result.evictedBytes).toBe(alphaBytes * 2);
    expect(result.evicted.map((e) => e.canonical)).toEqual([
      keyHeader(s1).canonical,
      keyHeader(s2).canonical,
    ]);

    const state = await cacheState(app);
    expect(state.entryCount).toBe(1);
    expect(state.resources[0].resource).toBe(BETA);

    expect((await rawRequest(app, BETA, {headers: language('en')})).headers['x-cache-status']).toBe(
      'HIT',
    );
    const s1Again = await rawRequest(app, ALPHA, {headers: locale('s1')});
    expect(s1Again.headers['x-cache-status']).toBe('MISS');
    expect(s1Again.headers['x-cache-reason']).toBe('capacity-evicted');
  });

  it('enforces at commit time a budget that shrank while a fill was in flight', async () => {
    const app = createApp();
    const probe = await rawRequest(app, ALPHA, {headers: locale('measure')});
    const bytes = storedBytes(probe);

    const slow = rawRequest(app, `${ALPHA}?fillDelay=120`, {headers: locale('slow')});
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The budget drops below the in-flight payload before it commits.
    const shrink = await setBudget(app, bytes - 1);
    expect(shrink.evicted.map((e) => e.canonical)).toEqual([keyHeader(probe).canonical]);

    const settled = await slow;
    expect(settled.headers['x-cache-status']).toBe('MISS');
    expect(settled.headers['x-cache-stored']).toBe('false');
    expect(settled.headers['x-cache-not-stored-reason']).toBe('exceeds-budget');
    expect(jsonBody(settled).id).toBe('alpha');

    const state = await cacheState(app);
    expect(state.usedBytes).toBe(0);
    expect(state.entryCount).toBe(0);
    const after = await rawRequest(app, ALPHA, {headers: locale('slow')});
    expect(after.headers['x-cache-status']).toBe('MISS');
  });

  it('single-flights fills under a budget and shares the retention outcome with joiners', async () => {
    const app = createApp();
    const probe = await rawRequest(app, ALPHA, {headers: locale('join-probe')});
    const bytes = storedBytes(probe);
    await setBudget(app, bytes); // room for exactly one variant

    const headers = locale('joined');
    const [a, b] = await Promise.all([
      rawRequest(app, `${ALPHA}?fillDelay=80`, {headers}),
      rawRequest(app, `${ALPHA}?fillDelay=80`, {headers}),
    ]);
    const reasons = [a.headers['x-cache-reason'], b.headers['x-cache-reason']].sort();
    expect(reasons).toEqual(['concurrent-fill-joined', 'origin-fill']);
    // Joiners observe the same commit: retained, probe evicted for room.
    for (const res of [a, b]) {
      expect(res.headers['x-cache-stored']).toBe('true');
      expect(evictionsHeader(res).map((e) => e.canonical)).toEqual([keyHeader(probe).canonical]);
    }

    const state = await cacheState(app);
    expect(state.entryCount).toBe(1);
    expect(state.usedBytes).toBe(bytes);
    expect((await rawRequest(app, ALPHA, {headers})).headers['x-cache-status']).toBe('HIT');
  });

  it('lets joiners of an over-budget fill be served without a later false hit', async () => {
    const app = createApp();
    const probe = await rawRequest(app, ALPHA, {headers: locale('join2-probe')});
    await setBudget(app, storedBytes(probe) - 1);

    const headers = locale('joined2');
    const [a, b] = await Promise.all([
      rawRequest(app, `${ALPHA}?fillDelay=80`, {headers}),
      rawRequest(app, `${ALPHA}?fillDelay=80`, {headers}),
    ]);
    const reasons = [a.headers['x-cache-reason'], b.headers['x-cache-reason']].sort();
    expect(reasons).toEqual(['concurrent-fill-joined', 'origin-fill']);
    for (const res of [a, b]) {
      expect(res.status).toBe(200);
      expect(res.headers['x-cache-stored']).toBe('false');
      expect(res.headers['x-cache-not-stored-reason']).toBe('exceeds-budget');
    }

    const state = await cacheState(app);
    expect(state.entryCount).toBe(0);
    expect((await rawRequest(app, ALPHA, {headers})).headers['x-cache-status']).toBe('MISS');
  });

  it('keeps invalidation counts and the per-resource index consistent after capacity evictions', async () => {
    const app = createApp();
    const i1 = await rawRequest(app, ALPHA, {headers: locale('idx-1')});
    const alphaBytes = storedBytes(i1);
    const b1 = await rawRequest(app, BETA, {headers: language('en')});
    const betaBytes = storedBytes(b1);
    await setBudget(app, alphaBytes * 2 + betaBytes);

    await rawRequest(app, ALPHA, {headers: locale('idx-2')});
    const i3 = await rawRequest(app, ALPHA, {headers: locale('idx-3')});
    // idx-1 no longer fits and was capacity-evicted; idx-2/idx-3 and beta remain.
    expect(evictionsHeader(i3).map((e) => e.canonical)).toEqual([keyHeader(i1).canonical]);

    const put = await rawRequest(app, ALPHA, {
      method: 'PUT',
      body: {revision: jsonBody(i3).revision, content: 'post-eviction update'},
    });
    expect(put.status).toBe(200);
    // Only the two actually-stored alpha variants count — the evicted one must
    // not linger in the resource index.
    expect(put.headers['x-cache-invalidated']).toBe('2');
    expect(put.headers['x-cache-freed-bytes']).toBe(String(alphaBytes * 2));

    const state = await cacheState(app);
    expect(state.entryCount).toBe(1);
    expect(state.usedBytes).toBe(betaBytes);
    expect(state.resources[0].resource).toBe(BETA);

    // The other resource is untouched and still hits.
    expect((await rawRequest(app, BETA, {headers: language('en')})).headers['x-cache-status']).toBe(
      'HIT',
    );
    // Invalidation outranks the capacity tombstone for alpha variants.
    for (const value of ['idx-1', 'idx-2']) {
      const miss = await rawRequest(app, ALPHA, {headers: locale(value)});
      expect(miss.headers['x-cache-reason']).toBe('revision-updated');
    }
  });

  it('still refuses stale-revision writes when a PUT lands during a fill under budget', async () => {
    const app = createApp();
    const probe = await rawRequest(app, ALPHA, {headers: locale('race-probe')});
    const bytes = storedBytes(probe);
    await setBudget(app, bytes);

    const headers = locale('race-budget');
    const slow = rawRequest(app, `${ALPHA}?fillDelay=100`, {headers});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bump = await request(app)
      .put(ALPHA)
      .send({revision: jsonBody(probe).revision, content: 'budget race winner'})
      .expect(200);

    const settled = await slow;
    expect(settled.headers['x-cache-status']).toBe('MISS');
    expect(settled.headers['x-cache-reason']).toBe('revision-updated');
    expect(jsonBody(settled).content).toBe('budget race winner');

    const after = await rawRequest(app, ALPHA, {headers});
    expect(after.headers['x-cache-status']).toBe('HIT');
    expect(jsonBody(after).revision).toBe(bump.body.revision);
    expect(jsonBody(after).content).toBe('budget race winner');

    const state = await cacheState(app);
    expect(state.entryCount).toBe(1);
    expect(state.usedBytes).toBeLessThanOrEqual(bytes);
  });

  it('reports server-side usage that exactly matches the retained variants after interleaving', async () => {
    const app = createApp();
    const p1 = await rawRequest(app, ALPHA, {headers: locale('mix-1')});
    const alphaBytes = storedBytes(p1);
    const p2 = await rawRequest(app, ALPHA, {headers: gzipLocale('mix-1')});
    const gzipBytes = storedBytes(p2);
    await rawRequest(app, BETA, {headers: language('fr')});

    // Shrink below current usage, then fill through the pressure.
    await setBudget(app, alphaBytes + gzipBytes);
    await rawRequest(app, ALPHA, {headers: locale('mix-2')});
    // Back to unbounded, more fills, then purge alpha entirely.
    await setBudget(app, null);
    await rawRequest(app, BETA, {headers: language('de')});
    await rawRequest(app, ALPHA, {
      method: 'PUT',
      body: {revision: jsonBody(p1).revision, content: 'mix final'},
    });

    const state = await cacheState(app);
    expect(state.budgetBytes).toBeNull();
    const variantBytes = state.resources.flatMap((r) => r.variants.map((v) => v.bytes));
    expect(state.usedBytes).toBe(variantBytes.reduce((sum, n) => sum + n, 0));
    expect(state.entryCount).toBe(variantBytes.length);
    // Only beta variants survived the alpha purge.
    expect(state.resources.every((r) => r.resource === BETA)).toBe(true);
    expect(state.entryCount).toBeGreaterThan(0);
  });
});
