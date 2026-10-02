import express from 'express';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {
  buildCanonicalKey,
  collectRawHeaders,
  parseVary,
  type CanonicalKey,
} from './vary';
import {VaryCache, type CachedPayload, type CommitResult} from './cache';

type RecordRow = {
  id: string;
  name: string;
  revision: number;
  content: string;
  vary: string;
  updatedAt: string;
};

const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary cache simulations',
    revision: 3,
    content: 'cache simulations: alpha\nstate: active',
    // Mergeable field plus a custom non-mergeable field.
    vary: 'Accept-Encoding, X-Locale',
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: 'Secondary cache simulations',
    revision: 5,
    content: 'cache simulations: beta\nstate: review',
    vary: 'Accept-Language',
    updatedAt: new Date(1000).toISOString(),
  },
];

/** Builds the actual representation for one row under the selected key. */
function buildPayload(row: RecordRow, key: CanonicalKey): CachedPayload {
  const body = JSON.stringify(row);
  const wantsGzip =
    key.varyFields.includes('accept-encoding') &&
    key.components.some((c) => c.field === 'accept-encoding' && c.values.includes('gzip'));

  if (wantsGzip) {
    return {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        etag: String(row.revision),
      },
      body: gzipSync(Buffer.from(body)),
    };
  }
  return {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      etag: String(row.revision),
    },
    body: Buffer.from(body),
  };
}

/** Simulated origin latency; overridable with ?fillDelay= for deterministic tests. */
function fillDelayMs(req: express.Request): number {
  const raw = req.query.fillDelay;
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function writeKeyHeaders(
  res: express.Response,
  key: CanonicalKey,
  status: 'HIT' | 'MISS' | 'BYPASS',
  reason: string,
) {
  res.set('X-Cache-Status', status);
  res.set('X-Cache-Reason', reason);
  // Base64 keeps arbitrary request-header values header-safe; the client only
  // decodes and renders this — it never reconstructs a key itself.
  res.set('X-Cache-Key', Buffer.from(JSON.stringify(key), 'utf8').toString('base64'));
  if (!key.bypass && key.varyFields.length > 0) {
    res.set('Vary', key.varyFields.join(', '));
  }
}

/**
 * Reports how a fill committed: whether the payload was retained, why not,
 * and which entries were evicted to make room. Joined waiters receive the
 * same commit as the fill leader, so their responses carry it too.
 */
function writeRetentionHeaders(
  res: express.Response,
  commit: CommitResult | null,
  payloadBytes: number,
) {
  const stored = commit?.stored ?? false;
  res.set('X-Cache-Retained', stored ? 'true' : 'false');
  if (!stored) {
    // A null commit means the revision guard refused the store outright.
    res.set('X-Cache-Retained-Reason', commit?.reason ?? 'revision-guard');
  }
  res.set('X-Cache-Entry-Bytes', String(commit?.bytes ?? payloadBytes));
  const evicted = commit?.evicted ?? [];
  res.set('X-Cache-Evicted', String(evicted.length));
  res.set(
    'X-Cache-Evicted-Bytes',
    String(evicted.reduce((sum, entry) => sum + entry.bytes, 0)),
  );
}

export function createApp() {
  const app = express();
  // Each app/workbench instance owns an isolated cache.
  const cache = new VaryCache();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'http-cache', count: rows.length}),
  );

  app.get('/api/experiments', (_req, res) =>
    res.json(rows.map(({content, ...row}) => row)),
  );

  app.get('/api/experiments/:id', async (req, res, next) => {
    try {
      const resource = `/api/experiments/${req.params.id}`;
      const currentRow = () => rows.find((value) => value.id === req.params.id);
      const initial = currentRow();
      if (!initial) return res.status(404).json({error: 'not_found'});

      const vary = parseVary(initial.vary);
      const key = buildCanonicalKey({
        resource,
        vary,
        headers: collectRawHeaders(req.rawHeaders),
      });

      // Vary: * — the origin forbids reuse under any key.
      if (key.bypass) {
        const row = currentRow();
        if (!row) return res.status(404).json({error: 'not_found'});
        res.set('Vary', '*');
        writeKeyHeaders(res, key, 'BYPASS', 'vary-star');
        const payload = buildPayload(row, key);
        res.status(payload.status);
        res.set(payload.headers);
        return res.send(payload.body);
      }

      const found = cache.lookup(key.canonical, resource);
      if (found.kind === 'hit') {
        const {entry} = found;
        writeKeyHeaders(res, key, 'HIT', 'stored-response');
        res.set('X-Cache-Entry-Bytes', String(entry.bytes));
        res.status(entry.status);
        res.set(entry.headers);
        return res.send(entry.body);
      }

      const missCause = found.reason;
      const invalidated = missCause === 'revision-updated';

      // One origin fill per canonical key; concurrent equivalent requests join.
      const produce = async () => {
        const row = currentRow();
        if (!row) {
          return {
            payload: {
              status: 404,
              headers: {'content-type': 'application/json; charset=utf-8'},
              body: Buffer.from(JSON.stringify({error: 'not_found'})),
            } satisfies CachedPayload,
            revision: -1,
            fresh: false,
          };
        }
        const snapshotRevision = row.revision;
        await new Promise((resolve) => setTimeout(resolve, fillDelayMs(req)));
        const latest = currentRow();
        const revision = latest ? latest.revision : snapshotRevision;
        const fresh = !!latest && revision === snapshotRevision;
        return {payload: buildPayload(latest ?? row, key), revision, fresh};
      };

      let result = await cache.fill(key, resource, initial.revision, produce);

      // A fill that observed a moving revision must never be served or stored.
      // The inflight slot is released by then, so rebuild against the now-current row.
      let revisionMoved = false;
      if (!result.outcome.fresh) {
        const rebuilt = currentRow();
        if (!rebuilt) return res.status(404).json({error: 'not_found'});
        revisionMoved = true;
        result = await cache.fill(key, resource, rebuilt.revision, produce);
      }

      const {payload} = result.outcome;
      if (!result.outcome.fresh) {
        // Extremely defensive: still do not serve stale bytes.
        const row = currentRow();
        if (!row) return res.status(404).json({error: 'not_found'});
        const direct = buildPayload(row, key);
        writeKeyHeaders(res, key, 'MISS', 'revision-updated');
        res.set('X-Cache-Miss-Cause', missCause);
        writeRetentionHeaders(res, null, direct.body.length);
        res.status(direct.status);
        res.set(direct.headers);
        return res.send(direct.body);
      }

      const reason = invalidated || revisionMoved
        ? 'revision-updated'
        : result.reason === 'concurrent-fill-joined'
          ? 'concurrent-fill-joined'
          : 'origin-fill';
      writeKeyHeaders(res, key, 'MISS', reason);
      res.set('X-Cache-Miss-Cause', missCause);
      writeRetentionHeaders(res, result.commit, payload.body.length);
      res.status(payload.status);
      res.set(payload.headers);
      return res.send(payload.body);
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/experiments/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) {
      return res.status(409).json({error: 'revision_conflict', current: row});
    }
    row.content = String(req.body.content ?? row.content);
    if (typeof req.body.vary === 'string') row.vary = req.body.vary;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();

    // Every stored variant under this resource is now stale.
    const resource = `/api/experiments/${row.id}`;
    const {removed, freedBytes} = cache.invalidate(resource);
    res.set('X-Cache-Invalidated', String(removed));
    res.set('X-Cache-Invalidated-Bytes', String(freedBytes));
    return res.json(row);
  });

  /**
   * Authoritative cache state: budget, total stored entity bytes, and the
   * per-variant / per-resource breakdown. Clients reconcile against this
   * instead of estimating usage themselves.
   */
  app.get('/api/cache/stats', (_req, res) => res.json(cache.stats()));

  /**
   * Sets the stored-entity-byte budget of the running cache (`null` clears
   * it). Shrinking evicts least-recently-used entries immediately; the
   * response lists what stopped being retained plus the resulting stats.
   */
  app.put('/api/cache/budget', (req, res) => {
    const raw: unknown = req.body?.budgetBytes;
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)) {
      return res.status(400).json({error: 'invalid_budget'});
    }
    const {evicted} = cache.setBudget(raw);
    res.set('X-Cache-Evicted', String(evicted.length));
    return res.json({evicted, ...cache.stats()});
  });

  app.post('/api/experiments/:id/analyze', async (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({
      id: row.id,
      revision: row.revision,
      lines: String(req.body.content ?? row.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () =>
    console.log('server http://127.0.0.1:4174'),
  );
}
