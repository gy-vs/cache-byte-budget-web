import type {Express} from 'express';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';

export type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

/**
 * Issues a raw/1.1 request so repeated header lines are sent verbatim —
 * supertest/superagent would merge them and hide the Vary semantics.
 */
export async function rawRequest(
  app: Express,
  path: string,
  init: {
    method?: string;
    headers?: ReadonlyArray<[string, string]>;
    body?: unknown;
  } = {},
): Promise<RawResponse> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') {
    server.close();
    throw new Error('no address');
  }
  const port = address.port;

  const payload = init.body === undefined ? null : JSON.stringify(init.body);
  const headerMap = new Map<string, string[]>();
  // Field names are case-insensitive on the wire: group case variants so they
  // are emitted as repeated lines of the same header.
  for (const [name, value] of init.headers ?? []) {
    const key = name.toLowerCase();
    const list = headerMap.get(key) ?? [];
    list.push(value);
    headerMap.set(key, list);
  }
  // Force the socket closed so server.close() returns promptly.
  headerMap.set('connection', ['close']);
  if (payload !== null) {
    headerMap.set('content-type', ['application/json']);
    headerMap.set('content-length', [String(Buffer.byteLength(payload))]);
  }

  const raw = await new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        port,
        host: '127.0.0.1',
        path,
        method: init.method ?? 'GET',
        // Array values go on the wire as separate header lines.
        headers: Object.fromEntries(headerMap),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });

  await new Promise((resolve) => server.close(resolve));
  return decode(raw);
}

function decode(res: RawResponse): RawResponse {
  if (res.headers['content-encoding'] === 'gzip') {
    return {...res, body: gunzipSync(res.body)};
  }
  return res;
}

export function jsonBody(res: RawResponse) {
  return JSON.parse(res.body.toString('utf8')) as {
    id: string;
    revision: number;
    content: string;
    vary: string;
  };
}

export function keyHeader(res: RawResponse) {
  const encoded = res.headers['x-cache-key'] as string;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    resource: string;
    varyFields: string[];
    components: Array<{field: string; present: boolean; mergeable: boolean; values: string[]}>;
    canonical: string;
    bypass: boolean;
  };
}

export type EvictedInfo = {
  canonical: string;
  resource: string;
  revision: number;
  bytes: number;
};

export function evictionsHeader(res: RawResponse): EvictedInfo[] {
  const encoded = res.headers['x-cache-evictions'] as string | undefined;
  if (!encoded) return [];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as EvictedInfo[];
}

/**
 * The stored entity bytes of the variant this response came from: the cache
 * charges exactly the response body bytes it holds, which on a fill equal the
 * wire Content-Length (gzip variants included).
 */
export function storedBytes(res: RawResponse): number {
  return Number(res.headers['content-length']);
}
