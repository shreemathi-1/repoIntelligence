import { vi } from 'vitest';
import type { ScanResponse } from '@repointelligence/shared';
import { jsonResponse } from '../github-fixtures.js';

export const WORKER_URL = 'http://worker.test:8000';
export const WORKER_SECRET = 'worker-secret-0123456789';

export type SyncApi = (url: string, init?: RequestInit) => Response | undefined;

export interface FakeWorker {
  /** Answers GitHub and the worker synchronously; `signInWith` plugs this in. */
  api: SyncApi;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  /** How many scans the worker has run. */
  scans: () => number;
  /** How many texts the worker has embedded. */
  embedded: () => number;
}

const DIMENSIONS = 16;

/** A deterministic bag-of-words vector, so texts that share words point the same way. */
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
  }
  return vector;
}

/**
 * A fake worker in front of a fake GitHub. The worker checks the shared secret and that an
 * archive was actually sent, then answers with `scan()`.
 */
export function fakeWorker(
  github: (url: string) => Response | undefined,
  scan: () => ScanResponse | Response,
): FakeWorker {
  let count = 0;
  let embedded = 0;
  const api: SyncApi = (url, init) => {
    if (!url.startsWith(WORKER_URL)) return github(decodeURIComponent(url));
    const headers = new Headers(init?.headers);
    if (headers.get('x-worker-secret') !== WORKER_SECRET) {
      return jsonResponse({ detail: 'Invalid worker secret' }, 401);
    }
    if (url.endsWith('/v1/embed')) {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const texts =
        typeof body === 'object' && body !== null && 'texts' in body && Array.isArray(body.texts)
          ? body.texts.map(String)
          : [];
      embedded += texts.length;
      return jsonResponse({
        model: 'fake-embedder',
        dimensions: DIMENSIONS,
        vectors: texts.map(fakeVector),
      });
    }
    if (!/\/v1\/(scan|graph)/.test(url)) return jsonResponse({ detail: 'not found' }, 404);
    const body = init?.body;
    const size = body instanceof Uint8Array ? body.byteLength : 0;
    if (size === 0) return jsonResponse({ detail: 'archive body is empty' }, 400);
    count += 1;
    const result = scan();
    return result instanceof Response ? result : jsonResponse(result);
  };
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(api(url, init) ?? jsonResponse({ message: 'Not Found' }, 404));
  });
  return { api, fetch: fetchMock, scans: () => count, embedded: () => embedded };
}
