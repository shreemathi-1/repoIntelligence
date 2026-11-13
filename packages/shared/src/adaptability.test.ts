import { describe, expect, it } from 'vitest';
import { evaluateRequestSchema, stackProfileInputSchema, warningSchema } from './index.js';

describe('stack profile', () => {
  it('fills defaults so a name is enough', () => {
    expect(stackProfileInputSchema.parse({ name: 'API' })).toMatchObject({
      runtimes: {},
      os: ['linux'],
      auth: 'none',
      license: { use: 'internal', copyleft: 'weak' },
      dependencies: [],
    });
  });

  it('rejects loose versions and unknown fields', () => {
    expect(stackProfileInputSchema.safeParse({ name: 'x', runtimes: { node: 'latest' } }).success).toBe(false);
    expect(stackProfileInputSchema.safeParse({ name: 'x', runtimes: { ruby: '3' } }).success).toBe(false);
    expect(stackProfileInputSchema.safeParse({ name: 'x', os: [] }).success).toBe(false);
  }); // prettier-ignore

  it('takes a saved profile id or an inline profile, not both', () => {
    expect(evaluateRequestSchema.safeParse({ profileId: 'a'.repeat(24) }).success).toBe(true);
    expect(evaluateRequestSchema.safeParse({ profile: { name: 'x' } }).success).toBe(true);
    expect(evaluateRequestSchema.safeParse({ profileId: 'a'.repeat(24), profile: { name: 'x' } }).success).toBe(false);
  }); // prettier-ignore
});

describe('warnings', () => {
  it('must carry evidence', () => {
    const warning = { id: 'w', dimension: 'runtime', severity: 'major', message: 'Needs Node 22' };
    expect(warningSchema.safeParse({ ...warning, evidence: [] }).success).toBe(false);
    const evidence = [{ source: 'file', path: 'package.json', line: 5, text: '"node": ">=22"' }];
    expect(warningSchema.safeParse({ ...warning, evidence }).success).toBe(true);
  });
});
