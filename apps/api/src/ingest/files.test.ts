import { describe, expect, it } from 'vitest';
import { classifyPath } from './files.js';

describe('classifyPath', () => {
  it.each([
    ['README.md', 'markdown'],
    ['docs/guide.mdx', 'markdown'],
    ['package.json', 'manifest'],
    ['services/api/requirements-dev.txt', 'manifest'],
    ['pom.xml', 'manifest'],
    ['.env.example', 'env'],
    ['docs/openapi.yaml', 'openapi'],
    ['swagger.json', 'openapi'],
    ['src/app.ts', 'source'],
    ['lib/core.py', 'source'],
    ['src/main/java/App.java', 'source'],
    ['notes.txt', 'other'],
  ])('%s is %s and included when useful', (path, kind) => {
    expect(classifyPath(path).kind).toBe(kind);
  });

  it.each([
    ['logo.png', 'binary'],
    ['fonts/a.woff2', 'binary'],
    ['package-lock.json', 'lock'],
    ['sub/yarn.lock', 'lock'],
    ['dist/index.js', 'vendor'],
    ['web/node_modules/x/index.js', 'vendor'],
    ['public/app.min.js', 'generated'],
    ['src/types.d.ts', 'generated'],
    ['proto/user_pb2.py', 'generated'],
  ])('%s is skipped as %s', (path, reason) => {
    const result = classifyPath(path);
    expect(result.include).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('assigns source languages', () => {
    expect(classifyPath('a.tsx').language).toBe('typescript');
    expect(classifyPath('a.mjs').language).toBe('javascript');
    expect(classifyPath('a.py').language).toBe('python');
    expect(classifyPath('A.java').language).toBe('java');
  });

  it('does not skip a file just because it is unknown', () => {
    expect(classifyPath('Makefile')).toMatchObject({ include: false, reason: null, kind: 'other' });
  });
});
