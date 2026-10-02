import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {entryBytes, jsonBody, keyHeader, rawRequest, type StatsBody} from './http';

const alpha = (locale: string, extra: Array<[string, string]> = []) =>
  [['x-locale', locale], ...extra] as Array<[string, string]>;
const beta = (language: string) =>
  [['accept-language', language]] as Array<[string, string]>;

async function statsOf(app: ReturnType<typeof createApp>): Promise<StatsBody> {
  const res = await rawRequest(app, '/api/cache/stats');
  return JSON.parse(res.body.toString('utf8')) as StatsBody;
}

/** Every stored byte must be derivable from the stats breakdown alone. */
function expectConsistent(stats: StatsBody) {
  const entrySum = stats.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const resourceSum = stats.resources.reduce((sum, resource) => sum + resource.bytes, 0);
  const variantSum = stats.resources.reduce((sum, resource) => sum + resource.variants, 0);
  expect(stats.usedBytes).toBe(entrySum);
  expect(stats.usedBytes).toBe(resourceSum);
  expect(stats.entryCount).toBe(stats.entries.length);
  expect(stats.entryCount).toBe(variantSum);
  if (stats.budgetBytes !== null) {
    expect(stats.usedBytes).toBeLessThanOrEqual(stats.budgetBytes);
  }
}

describe('capacity budget over HTTP', () => {
  it('charges stored bytes, evicts LRU on fill, and retains re-filled variants', async () => {
    const app = createApp();
    const a = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(a.headers['x-cache-status']).toBe('MISS');
    const size = entryBytes(a);
    expect(size).toBeGreaterThan(0);
    const b = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});

    // Budget fits exactly the two variants stored so far.
    const budgeted = await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: size * 2},
    });
    expect(budgeted.status).toBe(200);
    expect(budgeted.headers['x-cache-evicted']).toBe('0');

    // Filling a third variant must evict the least recently used one (a).
    const c = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')});
    expect(c.headers['x-cache-status']).toBe('MISS');
    expect(c.headers['x-cache-retained']).toBe('true');
    expect(c.headers['x-cache-evicted']).toBe('1');
    expect(c.headers['x-cache-evicted-bytes']).toBe(String(size));

    let stats = await statsOf(app);
    expect(stats.usedBytes).toBe(size * 2);
    // Most recently used first: c, then b.
    expect(stats.entries.map((entry) => entry.canonical)).toEqual([
      keyHeader(c).canonical,
      keyHeader(b).canonical,
    ]);
    expectConsistent(stats);

    // The evicted variant explains its miss as a capacity eviction...
    const evictedA = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(evictedA.headers['x-cache-status']).toBe('MISS');
    expect(evictedA.headers['x-cache-miss-cause']).toBe('evicted-capacity');
    // ...and re-filling it is retained (it evicts b, the new LRU) — variants
    // are not permanently excluded once evicted.
    expect(evictedA.headers['x-cache-retained']).toBe('true');
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    const bAgain = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    expect(bAgain.headers['x-cache-status']).toBe('MISS');
    expect(bAgain.headers['x-cache-miss-cause']).toBe('evicted-capacity');

    stats = await statsOf(app);
    expect(stats.usedBytes).toBe(size * 2);
    expectConsistent(stats);
  });

  it('a hit refreshes recency and protects the variant from eviction', async () => {
    const app = createApp();
    const first = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    const size = entryBytes(first);
    await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: size * 2}});

    // Touch a so b becomes the least recently used.
    const hitA = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(hitA.headers['x-cache-status']).toBe('HIT');

    await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')});
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    const b = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    expect(b.headers['x-cache-status']).toBe('MISS');
    expect(b.headers['x-cache-miss-cause']).toBe('evicted-capacity');
  });

  it('evicts across resources by recency, never by a fixed resource order', async () => {
    const app = createApp();
    const alphaA = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    const betaX = await rawRequest(app, '/api/experiments/beta', {headers: beta('en')});
    const budget = entryBytes(alphaA) + entryBytes(betaX);
    const applied = await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: budget},
    });
    expect(applied.headers['x-cache-evicted']).toBe('0');

    // A new alpha variant evicts the older alpha variant; beta is untouched.
    const alphaB = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    expect(alphaB.headers['x-cache-evicted']).toBe('1');
    expect(
      (await rawRequest(app, '/api/experiments/beta', {headers: beta('en')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');

    // The evicted alpha variant can be re-filled and retained afterwards.
    const refilled = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(refilled.headers['x-cache-miss-cause']).toBe('evicted-capacity');
    expect(refilled.headers['x-cache-retained']).toBe('true');
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    expect(
      (await rawRequest(app, '/api/experiments/beta', {headers: beta('en')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');

    const stats = await statsOf(app);
    expect(stats.entryCount).toBe(2);
    expectConsistent(stats);
  });

  it('serves an over-budget response without retaining it or faking later hits', async () => {
    const app = createApp();
    const probe = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('probe')});
    const size = entryBytes(probe);
    // Smaller than any single response: even one variant cannot be retained.
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: size - 1}});

    const first = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('big')});
    expect(first.status).toBe(200);
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(first.headers['x-cache-retained']).toBe('false');
    expect(first.headers['x-cache-retained-reason']).toBe('exceeds-budget');
    expect(jsonBody(first).id).toBe('alpha');

    // The next request must not report a hit, and says why nothing is stored.
    const second = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('big')});
    expect(second.headers['x-cache-status']).toBe('MISS');
    expect(second.headers['x-cache-miss-cause']).toBe('exceeds-budget');
    expect(second.headers['x-cache-retained']).toBe('false');

    // The variant evicted by the shrink keeps its own, distinct cause.
    const evicted = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('probe')});
    expect(evicted.headers['x-cache-miss-cause']).toBe('evicted-capacity');

    const stats = await statsOf(app);
    expect(stats.entryCount).toBe(0);
    expect(stats.usedBytes).toBe(0);
  });

  it('shrinking the budget evicts immediately and reports what was dropped', async () => {
    const app = createApp();
    const a = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    const size = entryBytes(a);
    const b = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    const c = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')});

    const shrunk = await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: size},
    });
    expect(shrunk.status).toBe(200);
    const body = JSON.parse(shrunk.body.toString('utf8')) as StatsBody & {
      evicted: Array<{canonical: string; resource: string; bytes: number}>;
    };
    // Only the most recently used variant survives; the two oldest are dropped.
    expect(body.evicted.map((entry) => entry.canonical)).toEqual([
      keyHeader(a).canonical,
      keyHeader(b).canonical,
    ]);
    expect(body.usedBytes).toBe(size);
    expect(body.entries.map((entry) => entry.canonical)).toEqual([keyHeader(c).canonical]);
    expectConsistent(body);

    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('c')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    const dropped = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(dropped.headers['x-cache-miss-cause']).toBe('evicted-capacity');
  });

  it('a resource PUT supersedes earlier capacity causes for its variants', async () => {
    const app = createApp();
    const a = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    const size = entryBytes(a);
    const b = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});
    // Room for one: a is evicted for capacity.
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: size}});

    await request(app)
      .put('/api/experiments/alpha')
      .send({revision: jsonBody(b).revision, content: 'invalidation wins'})
      .expect(200);

    for (const locale of ['a', 'b']) {
      const res = await rawRequest(app, '/api/experiments/alpha', {headers: alpha(locale)});
      expect(res.headers['x-cache-status']).toBe('MISS');
      expect(res.headers['x-cache-miss-cause']).toBe('revision-updated');
      expect(jsonBody(res).content).toBe('invalidation wins');
    }
  });

  it('applies a budget change that lands while a fill is in flight', async () => {
    const app = createApp();
    const slow = rawRequest(app, '/api/experiments/alpha?fillDelay=150', {
      headers: alpha('slow'),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Shrink below any single response while the origin fill is running.
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: 1}});

    const settled = await slow;
    expect(settled.status).toBe(200);
    expect(settled.headers['x-cache-status']).toBe('MISS');
    // The fill must not slip its bytes past the budget that is now in effect.
    expect(settled.headers['x-cache-retained']).toBe('false');
    expect(settled.headers['x-cache-retained-reason']).toBe('exceeds-budget');

    const after = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('slow')});
    expect(after.headers['x-cache-status']).toBe('MISS');
    expect(after.headers['x-cache-miss-cause']).toBe('exceeds-budget');
    expect((await statsOf(app)).usedBytes).toBe(0);

    // Raising the budget again lets the very same variant be retained.
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: null}});
    await rawRequest(app, '/api/experiments/alpha', {headers: alpha('slow')});
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('slow')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
  });

  it('lets every waiter of a shared fill see whether it was retained', async () => {
    const app = createApp();
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: 1}});

    const headers = alpha('joined');
    const [leader, joiner] = await Promise.all([
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers}),
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers}),
    ]);
    expect(leader.headers['x-cache-status']).toBe('MISS');
    expect(joiner.headers['x-cache-status']).toBe('MISS');
    expect(
      [leader.headers['x-cache-reason'], joiner.headers['x-cache-reason']].sort(),
    ).toEqual(['concurrent-fill-joined', 'origin-fill']);
    // Both the origin-fill leader and the joined waiter learn the outcome.
    for (const res of [leader, joiner]) {
      expect(res.headers['x-cache-retained']).toBe('false');
      expect(res.headers['x-cache-retained-reason']).toBe('exceeds-budget');
    }
    expect((await statsOf(app)).entryCount).toBe(0);

    // With room, the shared fill is retained once and both waiters see it.
    const probe = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('sizing')});
    await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: entryBytes(probe) * 10},
    });
    const roomy = alpha('roomy');
    const [okLeader, okJoiner] = await Promise.all([
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers: roomy}),
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers: roomy}),
    ]);
    expect(okLeader.headers['x-cache-retained']).toBe('true');
    expect(okJoiner.headers['x-cache-retained']).toBe('true');
    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: roomy})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
  });

  it('keeps per-resource invalidation exact after capacity evictions', async () => {
    const app = createApp();
    const alphaA = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    const betaX = await rawRequest(app, '/api/experiments/beta', {headers: beta('en')});
    const budget = entryBytes(alphaA) + entryBytes(betaX);
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: budget}});

    // Evicts alpha/a (LRU); beta's variant stays stored.
    await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')});

    const put = await rawRequest(app, '/api/experiments/beta', {
      method: 'PUT',
      body: {revision: jsonBody(betaX).revision, content: 'beta moved on'},
    });
    // Exactly the one stored beta variant is invalidated — the evicted alpha
    // variant must not leak into beta's count or index.
    expect(put.headers['x-cache-invalidated']).toBe('1');
    expect(put.headers['x-cache-invalidated-bytes']).toBe(String(entryBytes(betaX)));

    const stats = await statsOf(app);
    expect(stats.resources).toEqual([
      {resource: '/api/experiments/alpha', variants: 1, bytes: entryBytes(alphaA)},
    ]);
    expectConsistent(stats);

    expect(
      (await rawRequest(app, '/api/experiments/alpha', {headers: alpha('b')})).headers[
        'x-cache-status'
      ],
    ).toBe('HIT');
    const betaAfter = await rawRequest(app, '/api/experiments/beta', {headers: beta('en')});
    expect(betaAfter.headers['x-cache-status']).toBe('MISS');
    expect(betaAfter.headers['x-cache-miss-cause']).toBe('revision-updated');
    const alphaAAfter = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('a')});
    expect(alphaAAfter.headers['x-cache-miss-cause']).toBe('evicted-capacity');
  });

  it('still blocks stale-revision fills under a budget and accounts only live bytes', async () => {
    const app = createApp();
    const sizing = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('sizing')});
    await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: entryBytes(sizing) * 10},
    });

    const headers = alpha('race');
    const slow = rawRequest(app, '/api/experiments/alpha?fillDelay=100', {headers});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bump = await request(app)
      .put('/api/experiments/alpha')
      .send({revision: jsonBody(sizing).revision, content: 'raced content wins'})
      .expect(200);

    const settled = await slow;
    expect(settled.headers['x-cache-status']).toBe('MISS');
    expect(settled.headers['x-cache-reason']).toBe('revision-updated');
    expect(jsonBody(settled).content).toBe('raced content wins');

    const after = await rawRequest(app, '/api/experiments/alpha', {headers});
    expect(after.headers['x-cache-status']).toBe('HIT');
    expect(jsonBody(after).revision).toBe(bump.body.revision);

    // Only the live entry is charged: the stale fill left no bytes behind,
    // and the PUT purged the sizing variant.
    const stats = await statsOf(app);
    expect(stats.entryCount).toBe(1);
    expect(stats.entries[0].revision).toBe(bump.body.revision);
    expectConsistent(stats);
  });

  it('charges gzip and identity variants their real, different stored bytes', async () => {
    const app = createApp();
    const identity = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('enc')});
    const gz = await rawRequest(app, '/api/experiments/alpha', {
      headers: alpha('enc', [['accept-encoding', 'gzip']]),
    });
    const identityBytes = entryBytes(identity);
    const gzipBytes = entryBytes(gz);
    expect(identity.headers['x-cache-retained']).toBe('true');
    expect(gz.headers['x-cache-retained']).toBe('true');
    // Same source text, different stored representations and costs.
    expect(gzipBytes).not.toBe(identityBytes);

    const stats = await statsOf(app);
    expect(stats.usedBytes).toBe(identityBytes + gzipBytes);
    const byEncoding = new Map(stats.entries.map((entry) => [entry.contentEncoding, entry.bytes]));
    expect(byEncoding.get('identity')).toBe(identityBytes);
    expect(byEncoding.get('gzip')).toBe(gzipBytes);
    expectConsistent(stats);
  });

  it('reconciles final usage from server stats after interleaved operations', async () => {
    const app = createApp();
    const sizing = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('s0')});
    const size = entryBytes(sizing);

    await rawRequest(app, '/api/experiments/alpha', {headers: alpha('s1')});
    await rawRequest(app, '/api/experiments/beta', {headers: beta('en')});
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: size * 2}});
    const s2 = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('s2')});
    await request(app)
      .put('/api/experiments/alpha')
      .send({revision: jsonBody(s2).revision, content: 'post-mix revision'})
      .expect(200);
    const s3a = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('s3')});
    expect(s3a.headers['x-cache-miss-cause']).toBe('revision-updated');
    const s3b = await rawRequest(app, '/api/experiments/alpha', {headers: alpha('s3')});
    expect(s3b.headers['x-cache-status']).toBe('HIT');
    await rawRequest(app, '/api/cache/budget', {method: 'PUT', body: {budgetBytes: size * 3}});

    const stats = await statsOf(app);
    expect(stats.budgetBytes).toBe(size * 3);
    expectConsistent(stats);
  });

  it('validates budget updates', async () => {
    const app = createApp();
    for (const bad of [-1, 1.5, '100', {}]) {
      const res = await rawRequest(app, '/api/cache/budget', {
        method: 'PUT',
        body: {budgetBytes: bad},
      });
      expect(res.status).toBe(400);
    }
    const cleared = await rawRequest(app, '/api/cache/budget', {
      method: 'PUT',
      body: {budgetBytes: null},
    });
    expect(cleared.status).toBe(200);
    const stats = await statsOf(app);
    expect(stats.budgetBytes).toBeNull();
  });
});
