import { describe, expect, it } from 'vitest';
import type { Chunk } from '../ingest/types.js';
import { checkCitation, parseCitations, validateAnswer } from './citations.js';
import { boostTerms, classifyIntent, stem, termsOf } from './intent.js';
import { looksSecret, redactSecrets } from './redact.js';
import { cosine, indexChunks, keywordScores } from './retrieve.js';

const chunk = (path: string, startLine: number, endLine: number, text: string): Chunk => ({
  id: `${path}:${startLine}`,
  kind: 'source',
  provenance: { repo: 'acme/tool', sha: 'a'.repeat(40), path, startLine, endLine },
  heading: null,
  language: 'typescript',
  text,
  tokens: Math.ceil(text.length / 4),
});

const evidence = [
  chunk('src/server.ts', 1, 40, 'export function startServer(port: number) { app.listen(port) }'),
  chunk('src/server.ts', 41, 80, 'function shutdown() {}'),
  chunk('README.md', 1, 20, '# Tool\nRun `npm start` to start the server on port 4000.'),
];

describe('citations', () => {
  it('parses single lines and ranges, normalising order and leading ./', () => {
    expect(parseCitations('See [[./src/server.ts:12]] and [[README.md:9-3]].')).toEqual([
      { raw: '[[./src/server.ts:12]]', path: 'src/server.ts', startLine: 12, endLine: 12 },
      { raw: '[[README.md:9-3]]', path: 'README.md', startLine: 3, endLine: 9 },
    ]);
  });

  it('accepts lines inside a shown chunk and clamps a range that spills over', () => {
    expect(checkCitation({ path: 'src/server.ts', startLine: 5, endLine: 10 }, evidence)).toEqual({
      path: 'src/server.ts',
      startLine: 5,
      endLine: 10,
    });
    expect(checkCitation({ path: 'src/server.ts', startLine: 35, endLine: 45 }, evidence)).toEqual({
      path: 'src/server.ts',
      startLine: 35,
      endLine: 40,
    });
  });

  it('rejects unknown files and lines that were never shown', () => {
    expect(checkCitation({ path: 'src/other.ts', startLine: 1, endLine: 2 }, evidence)).toBeNull();
    expect(checkCitation({ path: 'README.md', startLine: 50, endLine: 60 }, evidence)).toBeNull();
  });

  it('labels an answer verified only when every citation holds', () => {
    const good = validateAnswer(
      'The server starts in `startServer` [[src/server.ts:1-3]].',
      evidence,
      { hasEvidence: true },
    );
    expect(good.confidence).toBe('verified');
    expect(good.citations).toEqual([{ path: 'src/server.ts', startLine: 1, endLine: 3 }]);

    const mixed = validateAnswer(
      'Start it with npm start [[README.md:3]]. Config lives in [[src/config.ts:1-9]].',
      evidence,
      { hasEvidence: true },
    );
    expect(mixed.confidence).toBe('inferred');
    expect(mixed.dropped).toBe(1);
    expect(mixed.text).toBe('Start it with npm start [[README.md:3-3]]. Config lives in.');
    expect(mixed.citations).toHaveLength(1);

    const none = validateAnswer('It probably uses Express.', evidence, { hasEvidence: true });
    expect(none.confidence).toBe('inferred');
    expect(none.citations).toEqual([]);
  });

  it('falls back to no evidence when the model says so or nothing was retrieved', () => {
    expect(validateAnswer('NO_EVIDENCE', evidence, { hasEvidence: true })).toMatchObject({
      noEvidence: true,
      confidence: 'insufficient',
    });
    expect(validateAnswer('Some guess [[README.md:1]]', [], { hasEvidence: false })).toMatchObject({
      noEvidence: true,
      citations: [],
    });
  });
});

describe('redaction', () => {
  it('keeps variable names and removes values', () => {
    const text = 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz\npassword: "hunter2hunter2"\nPORT=4000';
    const out = redactSecrets(text);
    expect(out).toContain('API_KEY=[redacted]');
    expect(out).toContain('password: "[redacted]"');
    expect(out).toContain('PORT=4000');
    expect(out).not.toContain('hunter2');
  });

  it('removes known token shapes and URL credentials', () => {
    const text =
      'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 and mongodb://admin:s3cret@host/db and AKIAABCDEFGHIJKLMNOP';
    const out = redactSecrets(text);
    expect(out).not.toMatch(/ghp_|s3cret|AKIA/);
    expect(out).toContain('mongodb://admin:[redacted]@host/db');
    expect(looksSecret(text)).toBe(true);
    expect(looksSecret(out)).toBe(false);
  });
});

describe('intent and terms', () => {
  it('splits identifiers and drops stop words', () => {
    expect(termsOf('How does getUserById work in auth_service?')).toEqual([
      'get',
      'user',
      'id',
      'work',
      'auth',
      'service',
    ]);
  });

  it('classifies common question shapes', () => {
    expect(classifyIntent('Which endpoints does the API expose?')).toBe('api');
    expect(classifyIntent('What database models exist?')).toBe('database');
    expect(classifyIntent('Which environment variables are required?')).toBe('config');
    expect(classifyIntent('Where is the entry point defined?')).toBe('find');
    expect(classifyIntent('Tell me about this project')).toBe('general');
  });

  it('adds graph names the question mentions', () => {
    const graph = {
      routes: [
        { method: 'GET', route: '/users/:id', path: 'src/r.ts', line: 1, framework: 'express', handler: null, middleware: [] },
        { method: 'GET', route: '/health', path: 'src/h.ts', line: 1, framework: 'express', handler: null, middleware: [] },
      ],
      models: [{ name: 'UserSchema', path: 'src/m.ts', line: 1, orm: 'mongoose', kind: 'model' as const }],
      symbols: [],
    }; // prettier-ignore
    expect(boostTerms('How is a user fetched?', graph)).toEqual(['users', 'id', 'user', 'schema']);
    expect(boostTerms('How is a user fetched?', null)).toEqual([]);
  });
});

describe('keyword scoring and cosine', () => {
  it('stems enough for common inflections to meet', () => {
    expect(new Set(['deleted', 'deletes', 'delete', 'deleting'].map(stem))).toEqual(
      new Set(['delet']),
    );
    expect(stem('users')).toBe(stem('user'));
    expect(stem('running')).toBe('run');
    expect(stem('class')).toBe('clas');
    expect(stem('id')).toBe('id');
  });

  it('ranks chunks that mention the terms above one that only shares a path', () => {
    const docs = indexChunks(evidence);
    const ranked = keywordScores('how do I start the server', docs);
    expect(new Set(ranked.slice(0, 2).map((r) => r.index))).toEqual(new Set([0, 2]));
    expect(ranked.at(-1)?.index).toBe(1);
    expect(keywordScores('', docs)).toEqual([]);
  });

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
