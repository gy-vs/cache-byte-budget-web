import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {jsonBody, keyHeader, rawRequest} from './http';

// Rows live in shared module memory while each app owns its cache. Use a
// separate setup app so restoring row state never pollutes the app under test.
async function resetAlphaVary(vary = 'Accept-Encoding, X-Locale') {
  const setupApp = createApp();
  const current = await request(setupApp).get('/api/experiments/alpha').expect(200);
  if (current.body.vary !== vary) {
    await request(setupApp)
      .put('/api/experiments/alpha')
      .send({revision: current.body.revision, vary, content: current.body.content})
      .expect(200);
  }
}

// Rows are shared module state: restore the default Vary after every test so
// changes cannot leak between tests. The setup app keeps the tested app's
// cache/invalidation state untouched.
afterEach(async () => {
  const setupApp = createApp();
  const alpha = await request(setupApp).get('/api/experiments/alpha').expect(200);
  if (alpha.body.vary !== 'Accept-Encoding, X-Locale') {
    await request(setupApp)
      .put('/api/experiments/alpha')
      .send({
        revision: alpha.body.revision,
        vary: 'Accept-Encoding, X-Locale',
        content: alpha.body.content,
      })
      .expect(200);
  }
});

describe('service baseline', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/alpha').expect(200);
    await request(app)
      .put('/api/experiments/alpha')
      .send({content: 'updated', revision: before.body.revision})
      .expect(200);
    await request(app)
      .put('/api/experiments/alpha')
      .send({content: 'stale', revision: before.body.revision})
      .expect(409);
  });
});

describe('Vary canonical cache key over HTTP', () => {
  it('first request fills, equivalent request hits the same entry', async () => {
    const app = createApp();
    const first = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['x-locale', 'en']],
    });
    const second = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['x-locale', 'en']],
    });
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(first.headers['x-cache-reason']).toBe('origin-fill');
    expect(second.headers['x-cache-status']).toBe('HIT');
    expect(second.headers['x-cache-reason']).toBe('stored-response');
    expect(keyHeader(first).canonical).toBe(keyHeader(second).canonical);
  });

  it('mergeable headers hit across case, token order and repeated lines', async () => {
    const app = createApp();
    // beta varies on Accept-Language (mergeable)
    const first = await rawRequest(app, '/api/experiments/beta', {
      headers: [['accept-language', 'en, fr']],
    });
    const reordered = await rawRequest(app, '/api/experiments/beta', {
      headers: [
        ['Accept-Language', ' fr , EN '],
        ['ACCEPT-LANGUAGE', 'en'],
      ],
    });
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(reordered.headers['x-cache-status']).toBe('HIT');
    expect(keyHeader(first).canonical).toBe(keyHeader(reordered).canonical);
  });

  it('non-mergeable headers keep the value sequence distinct and never cross content', async () => {
    const app = createApp();
    const en = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['accept-encoding', 'gzip'],
        ['x-locale', 'en'],
      ],
    });
    const fr = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['accept-encoding', 'gzip'],
        ['x-locale', 'fr'],
      ],
    });
    const enAgain = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['accept-encoding', 'gzip'],
        ['x-locale', 'en'],
      ],
    });

    expect(en.headers['x-cache-status']).toBe('MISS');
    expect(fr.headers['x-cache-status']).toBe('MISS');
    expect(enAgain.headers['x-cache-status']).toBe('HIT');
    expect(jsonBody(enAgain).content).toBe(jsonBody(en).content);

    // Duplicate line order is a different sequence (no collapse for non-mergeable).
    const enFr = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['x-locale', 'en'],
        ['x-locale', 'fr'],
      ],
    });
    const frEn = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['x-locale', 'fr'],
        ['x-locale', 'en'],
      ],
    });
    expect(enFr.headers['x-cache-status']).toBe('MISS');
    expect(frEn.headers['x-cache-status']).toBe('MISS');
    expect(keyHeader(enFr).canonical).not.toBe(keyHeader(frEn).canonical);
  });

  it('content negotiation variants never leak each others encoding/content', async () => {
    const app = createApp();
    const identity = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['x-locale', 'v']],
    });
    const gz = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['accept-encoding', 'gzip'],
        ['x-locale', 'v'],
      ],
    });
    const identityAgain = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['x-locale', 'v']],
    });
    const gzAgain = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['accept-encoding', 'gzip'],
        ['x-locale', 'v'],
      ],
    });

    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(identityAgain.headers['x-cache-status']).toBe('HIT');
    expect(gzAgain.headers['x-cache-status']).toBe('HIT');
    expect(identityAgain.headers['content-encoding']).toBeUndefined();
    expect(gzAgain.headers['content-encoding']).toBe('gzip');
    expect(jsonBody(identityAgain).content).toBe(jsonBody(gzAgain).content);
  });

  it('distinguishes missing headers from empty header values', async () => {
    const app = createApp();
    const missing = await rawRequest(app, '/api/experiments/alpha');
    const empty = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['x-locale', '']],
    });
    expect(missing.headers['x-cache-status']).toBe('MISS');
    expect(empty.headers['x-cache-status']).toBe('MISS');
    const missingComponent = keyHeader(empty).components.find((c) => c.field === 'x-locale');
    expect(missingComponent).toMatchObject({present: true, values: ['']});
    const keyOfMissing = keyHeader(missing).components.find((c) => c.field === 'x-locale');
    expect(keyOfMissing).toMatchObject({present: false, values: []});
    expect(keyHeader(missing).canonical).not.toBe(keyHeader(empty).canonical);
  });

  it('normalizes Vary selector casing/order and serves structured components', async () => {
    const app = createApp();
    // alpha already varies on accept-encoding + x-locale.
    const a = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['X-LOCALE', 'en'],
        ['ACCEPT-ENCODING', 'GZIP, br'],
      ],
    });
    const b = await rawRequest(app, '/api/experiments/alpha', {
      headers: [
        ['x-locale', 'en'],
        ['accept-encoding', 'br, gzip'],
      ],
    });
    expect(b.headers['x-cache-status']).toBe('HIT');
    const key = keyHeader(a);
    expect(key.varyFields).toEqual(['accept-encoding', 'x-locale']);
    expect(key.components.find((c) => c.field === 'accept-encoding')?.values).toEqual([
      'br',
      'gzip',
    ]);
    expect(key.components.find((c) => c.field === 'x-locale')?.values).toEqual(['en']);
  });

  it('never reuses entries under Vary: *', async () => {
    const app = createApp();
    const current = await request(app).get('/api/experiments/alpha').expect(200);
    await request(app)
      .put('/api/experiments/alpha')
      .send({revision: current.body.revision, vary: '*', content: current.body.content})
      .expect(200);

    const first = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['accept-encoding', 'gzip']],
    });
    const second = await rawRequest(app, '/api/experiments/alpha', {
      headers: [['accept-encoding', 'br']],
    });
    expect(first.headers.vary).toBe('*');
    expect(second.headers.vary).toBe('*');
    expect(first.headers['x-cache-status']).toBe('BYPASS');
    expect(second.headers['x-cache-status']).toBe('BYPASS');
    expect(first.headers['x-cache-reason']).toBe('vary-star');
    expect(second.headers['x-cache-reason']).toBe('vary-star');
  });

  it('invalidates all variants on revision update and never serves old bytes', async () => {
    const app = createApp();
    await resetAlphaVary();
    const gz = [
      ['accept-encoding', 'gzip'],
      ['x-locale', 'en'],
    ] as Array<[string, string]>;
    const identity = [['x-locale', 'en']] as Array<[string, string]>;

    await rawRequest(app, '/api/experiments/alpha', {headers: gz});
    await rawRequest(app, '/api/experiments/alpha', {headers: identity});
    const cached = await rawRequest(app, '/api/experiments/alpha', {headers: gz});
    expect(cached.headers['x-cache-status']).toBe('HIT');
    const rev = jsonBody(cached).revision;

    const put = await rawRequest(app, '/api/experiments/alpha', {
      method: 'PUT',
      body: {revision: rev, content: 'fresh revision content'},
    });
    expect(put.status).toBe(200);
    expect(put.headers['x-cache-invalidated']).toBe('2');

    for (const headers of [gz, identity]) {
      const miss = await rawRequest(app, '/api/experiments/alpha', {headers});
      expect(miss.headers['x-cache-status']).toBe('MISS');
      expect(miss.headers['x-cache-reason']).toBe('revision-updated');
      expect(jsonBody(miss).content).toBe('fresh revision content');
      const hit = await rawRequest(app, '/api/experiments/alpha', {headers});
      expect(hit.headers['x-cache-status']).toBe('HIT');
      expect(jsonBody(hit).content).toBe('fresh revision content');
    }
  });

  it('single-flights concurrent equivalent fills and fills distinct keys independently', async () => {
    const app = createApp();
    await resetAlphaVary();
    const headers = [['x-locale', 'concurrent']] as Array<[string, string]>;

    const [a, b, c] = await Promise.all([
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers}),
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {headers}),
      rawRequest(app, '/api/experiments/alpha?fillDelay=80', {
        headers: [['x-locale', 'other-key']],
      }),
    ]);

    const statuses = [a, b].map((r) => r.headers['x-cache-status']);
    expect(statuses.filter((s) => s === 'MISS')).toHaveLength(2);
    const reasons = [a, b].map((r) => r.headers['x-cache-reason']).sort();
    expect(reasons).toEqual(['concurrent-fill-joined', 'origin-fill']);
    // Equivalent payloads are byte-identical (gzip included), not re-filled.
    expect(a.body.equals(b.body)).toBe(true);
    // A different canonical key runs its own fill.
    expect(c.headers['x-cache-status']).toBe('MISS');
    expect(c.headers['x-cache-reason']).toBe('origin-fill');

    const hit = await rawRequest(app, '/api/experiments/alpha', {headers});
    expect(hit.headers['x-cache-status']).toBe('HIT');
  });

  it('does not let an old-revision in-flight fill overwrite the new revision entry', async () => {
    const app = createApp();
    await resetAlphaVary();
    const headers = [['x-locale', 'race']] as Array<[string, string]>;

    // Start a slow fill against revision N...
    const slow = rawRequest(app, '/api/experiments/alpha?fillDelay=100', {headers});
    // ...and bump the revision while that fill is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await request(app).get('/api/experiments/alpha').expect(200);
    const bump = await request(app)
      .put('/api/experiments/alpha')
      .send({revision: current.body.revision, content: 'newer revision wins'})
      .expect(200);
    expect(bump.body.revision).toBe(current.body.revision + 1);

    const settled = await slow;
    // The stale fill is discarded; a synchronous rebuild serves the new row.
    expect(settled.headers['x-cache-status']).toBe('MISS');
    expect(settled.headers['x-cache-reason']).toBe('revision-updated');
    expect(jsonBody(settled).content).toBe('newer revision wins');

    // The stored entry must be the new revision — never the old fill's bytes.
    const after = await rawRequest(app, '/api/experiments/alpha', {headers});
    expect(after.headers['x-cache-status']).toBe('HIT');
    expect(jsonBody(after).revision).toBe(bump.body.revision);
    expect(jsonBody(after).content).toBe('newer revision wins');
  });
});
