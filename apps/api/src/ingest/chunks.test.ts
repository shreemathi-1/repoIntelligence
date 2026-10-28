import { describe, expect, it } from 'vitest';
import {
  chunkEnv,
  chunkManifest,
  chunkMarkdown,
  chunkOpenApi,
  chunkSource,
  chunkSymbols,
  splitToBudget,
} from './chunker.js';
import { dedupeChunks } from './dedupe.js';
import { parseMarkdown, resolveDocument, type LinkContext } from './markdown.js';
import { parseOpenApi } from './openapi.js';
import { extractJsTs, extractPython } from './symbols.js';
import { estimateTokens, packChunks } from './tokens.js';
import type { Chunk } from './types.js';

const ctx = { repo: 'acme/tool', sha: 'abc123' };
const empty: LinkContext = {
  repo: 'acme/tool',
  sha: 'abc123',
  paths: new Set(),
  dirs: new Set(),
  anchors: new Map(),
};
const mdDoc = (text: string, path = 'README.md') =>
  resolveDocument(parseMarkdown(text, path), empty);

describe('estimateTokens', () => {
  it('is about a quarter of the characters, with a margin, and zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(400))).toBe(110);
  });
});

describe('chunkMarkdown', () => {
  it('makes one chunk per section with provenance and heading trail, skipping empty headings', () => {
    const doc = mdDoc('# Tool\n\nIntro.\n\n## Empty\n\n## Install\nRun it.\n');
    const chunks = chunkMarkdown(doc, ctx);
    expect(chunks.map((c) => c.heading)).toEqual([['Tool'], ['Tool', 'Install']]);
    expect(chunks[1]?.provenance).toEqual({
      repo: 'acme/tool',
      sha: 'abc123',
      path: 'README.md',
      startLine: 7,
      endLine: 8,
    });
    expect(chunks.every((c) => c.kind === 'doc' && c.id.length === 16)).toBe(true);
  });

  it('never cuts a code block or table when splitting a long section', () => {
    const code = [
      '```js',
      ...Array.from({ length: 6 }, (_, i) => `const line${i} = ${i};`),
      '```',
    ].join('\n');
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    const filler = (n: string) => `${n} ${'word '.repeat(60)}`.trim();
    const section = ['# Doc', filler('one'), '', code, '', filler('two'), '', table].join('\n');
    const chunks = chunkMarkdown(mdDoc(section), { ...ctx, budget: 100 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      const fences = chunk.text.split('\n').filter((l) => l.startsWith('```')).length;
      expect(fences % 2).toBe(0);
      expect(chunk.text.includes('| a | b |')).toBe(chunk.text.includes('| 1 | 2 |'));
    }
  });
});

describe('splitToBudget', () => {
  it('returns short text whole, and cuts one oversized block by lines with correct line numbers', () => {
    expect(splitToBudget('short', 10, 100)).toEqual([
      { text: 'short', startLine: 10, endLine: 10 },
    ]);
    const long = Array.from(
      { length: 40 },
      (_, i) => `line number ${i} with some padding text`,
    ).join('\n');
    const pieces = splitToBudget(long, 5, 60);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces[0]?.startLine).toBe(5);
    expect(pieces.map((p) => p.text).join('\n')).toBe(long);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]?.startLine).toBe((pieces[i - 1]?.endLine ?? 0) + 1);
    }
  });
});

describe('other chunk kinds', () => {
  it('chunks each OpenAPI endpoint', () => {
    const api = parseOpenApi(
      'openapi: 3.0.0\ninfo: {title: T, version: "1"}\npaths:\n  /a:\n    get:\n      summary: Read a\n      responses: {"200": {description: ok}}\n',
      'openapi.yaml',
    );
    const chunks = chunkOpenApi(api ?? (undefined as never), ctx);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('GET /a');
    expect(chunks[0]?.text).toContain('Summary: Read a');
  });

  it('summarises manifests and env examples', () => {
    const chunk = chunkManifest(
      {
        path: 'package.json',
        ecosystem: 'npm',
        name: 'svc',
        version: '1.0.0',
        dependencies: [{ name: 'express', spec: '^5', scope: 'runtime' }],
        scripts: { test: 'vitest' },
        engines: { node: '>=22' },
      },
      ctx,
    );
    expect(chunk.text).toContain('Requires node >=22');
    expect(chunk.text).toContain('express ^5 (runtime)');
    const env = chunkEnv(
      [{ name: 'PORT', description: 'Listen port', hasDefault: true, line: 2 }],
      '.env.example',
      ctx,
    );
    expect(env[0]?.kind).toBe('config');
    expect(chunkEnv([], '.env.example', ctx)).toEqual([]);
  });

  it('makes API chunks only for exported symbols and includes tags', () => {
    const symbols = extractJsTs(
      '/**\n * Adds.\n * @param a first\n */\nexport function add(a: number) {}\nfunction hidden() {}\n',
      'a.ts',
      'typescript',
    );
    const chunks = chunkSymbols(symbols, ctx);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('function add(a: number)');
    expect(chunks[0]?.text).toContain('@param a first');
  });
});

describe('chunkSource', () => {
  const source = [
    'import os',
    '',
    '# Helper',
    'def one():',
    '    return 1',
    '',
    'class Two:',
    '    def m(self):',
    '        return 2',
    '',
  ].join('\n');

  it('splits at top-level symbols, keeping the preceding comment with its symbol', () => {
    const chunks = chunkSource(source, extractPython(source, 'm.py'), 'm.py', ctx);
    expect(chunks.map((c) => c.text.split('\n')[0])).toEqual([
      'import os',
      '# Helper',
      'class Two:',
    ]);
    expect(chunks[1]?.provenance).toMatchObject({ startLine: 3, endLine: 5 });
    expect(chunks.every((c) => c.kind === 'source' && c.language === 'python')).toBe(true);
  });

  it('covers every non-blank line exactly once', () => {
    const chunks = chunkSource(source, extractPython(source, 'm.py'), 'm.py', ctx);
    expect(
      chunks
        .map((c) => c.text)
        .join('\n\n')
        .replace(/\s+/g, ''),
    ).toBe(source.replace(/\s+/g, ''));
  });
});

const chunk = (text: string, kind: Chunk['kind'] = 'doc', path = 'a.md'): Chunk => ({
  id: text.slice(0, 8),
  kind,
  provenance: { repo: 'r', sha: 's', path, startLine: 1, endLine: 1 },
  heading: null,
  language: null,
  text,
  tokens: estimateTokens(text),
});

describe('dedupeChunks', () => {
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');

  it('removes exact duplicates, ignoring case and punctuation, and points at the kept one', () => {
    const a = chunk('Install: run the setup!', 'doc', 'README.md');
    const b = chunk('install run THE setup', 'doc', 'docs/copy.md');
    const { kept, removed } = dedupeChunks([a, b]);
    expect(kept).toEqual([a]);
    expect(removed[0]?.duplicateOf).toBe(a.id);
  });

  it('removes near-duplicates but keeps clearly different text', () => {
    const a = chunk(long, 'doc', 'README.md');
    const near = chunk(`${long} extra`, 'doc', 'docs/b.md');
    const different = chunk(
      Array.from({ length: 50 }, (_, i) => `other${i}`).join(' '),
      'doc',
      'docs/c.md',
    );
    const { kept, removed } = dedupeChunks([a, near, different]);
    expect(kept.map((c) => c.provenance.path)).toEqual(['README.md', 'docs/c.md']);
    expect(removed).toHaveLength(1);
  });

  it('does not treat different kinds as duplicates', () => {
    const { kept } = dedupeChunks([
      chunk('same text here', 'doc'),
      chunk('same text here', 'source'),
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('packChunks', () => {
  const doc = chunk('d'.repeat(400), 'doc', 'README.md');
  const other = chunk('o'.repeat(400), 'doc', 'docs/x.md');
  const src = chunk('s'.repeat(400), 'source', 'src/a.ts');
  const api = chunk('a'.repeat(400), 'openapi', 'openapi.yaml');

  it('puts README first, then other docs, API and source', () => {
    const result = packChunks([src, api, other, doc], 10_000);
    expect(result.chunks.map((c) => c.provenance.path)).toEqual([
      'README.md',
      'docs/x.md',
      'openapi.yaml',
      'src/a.ts',
    ]);
    expect(result.omitted).toBe(0);
  });

  it('stays within the budget and reports what it left out', () => {
    const result = packChunks([src, api, other, doc], 250);
    expect(result.tokens).toBeLessThanOrEqual(250);
    expect(result.chunks.map((c) => c.provenance.path)).toEqual(['README.md', 'docs/x.md']);
    expect(result.omitted).toBe(2);
  });

  it('skips a chunk that does not fit but still takes smaller ones after it', () => {
    const big = chunk('b'.repeat(4000), 'doc', 'README.md');
    const small = chunk('tiny', 'doc', 'docs/s.md');
    expect(packChunks([big, small], 100).chunks).toEqual([small]);
  });
});
