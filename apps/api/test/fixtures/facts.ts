import type { Facts } from '../../src/docs/facts.js';
import { parseEnvExample, parseManifest } from '../../src/ingest/manifests.js';
import type { Chunk, CodeSymbol } from '../../src/ingest/types.js';
import { ORDERS_SERVICE } from './docs.js';
import { fixtureGraph } from './graph.js';

export const FACTS_SHA = 'a'.repeat(40);

/** The orders service as plain text files. */
export const ordersFiles: Record<string, string> = Object.fromEntries(
  Object.entries(ORDERS_SERVICE).map(([path, content]) => [path, content.toString()]),
);

/** The slice of an ingestion that generators read, built from plain files. */
export function factsOf(
  files: Record<string, string>,
  graph: Facts['graph'] = fixtureGraph(),
  extra: { symbols?: CodeSymbol[]; chunks?: Chunk[]; findings?: Facts['data']['findings'] } = {},
): Facts {
  const manifests = Object.entries(files).flatMap(([path, text]) => parseManifest(text, path) ?? []);
  const envExamples = Object.entries(files)
    .filter(([path]) => path.endsWith('.env.example'))
    .map(([path, text]) => ({ path, vars: parseEnvExample(text) }));
  return {
    fullName: 'acme/orders', owner: 'acme', name: 'orders', sha: FACTS_SHA, private: false,
    repo: { fullName: 'acme/orders', description: 'Orders service', private: false, defaultBranch: 'main', language: 'TypeScript', stars: 1, htmlUrl: 'https://github.com/acme/orders' },
    data: { repo: 'acme/orders', sha: FACTS_SHA, ref: 'main', generatedAt: '', docs: [], openApi: [], manifests, envExamples, symbols: extra.symbols ?? [], findings: extra.findings ?? [], missingDocuments: [], chunks: extra.chunks ?? [] },
    graph,
    paths: Object.keys(files),
    read: (path) => Promise.resolve(files[path] ?? null),
  };
} // prettier-ignore
