import { describe, expect, it } from 'vitest';
import {
  missingDocuments,
  parseMarkdown,
  resolveDocument,
  resolveLink,
  slugify,
  type LinkContext,
} from './markdown.js';

const ctx = (paths: string[], anchors: Record<string, string[]> = {}): LinkContext => ({
  repo: 'acme/tool',
  sha: 'abc123',
  paths: new Set(paths),
  dirs: new Set(
    paths.flatMap((p) =>
      p
        .split('/')
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join('/')),
    ),
  ),
  anchors: new Map(Object.entries(anchors).map(([k, v]) => [k, new Set(v)])),
});

const DOC = [
  '---',
  'title: ignored',
  '---',
  '# Tool',
  'Intro with [guide](docs/guide.md) and `[not a link](nowhere.md)`.',
  '',
  '## Install',
  '```sh',
  '# Not a heading',
  'npm i [x](y.md)',
  '```',
  '',
  '| Name | Type |',
  '| ---- | ---- |',
  '| a    | int  |',
  '',
  '## Usage',
  'See [Install](#install) and [missing](docs/nope.md).',
  '[![build](badge.svg)](https://ci.example.com)',
  '<img src="assets/logo.png" alt="logo">',
  'Setext Title',
  '------------',
].join('\n');

describe('parseMarkdown', () => {
  const doc = parseMarkdown(DOC, 'README.md');

  it('splits into sections with heading trails and skips front matter', () => {
    expect(doc.title).toBe('Tool');
    expect(doc.isReadme).toBe(true);
    expect(doc.sections.map((s) => s.heading)).toEqual([
      'Tool',
      'Install',
      'Usage',
      'Setext Title',
    ]);
    expect(doc.sections[1]?.trail).toEqual(['Tool', 'Install']);
    expect(doc.sections[1]?.slug).toBe('install');
  });

  it('does not treat "#" inside code fences as headings and keeps the block verbatim', () => {
    const install = doc.sections[1];
    expect(install?.codeBlocks).toEqual([
      { lang: 'sh', code: '# Not a heading\nnpm i [x](y.md)', startLine: 8 },
    ]);
    expect(install?.text).toContain('```sh');
  });

  it('keeps tables as rows and in the section text', () => {
    const install = doc.sections[1];
    expect(install?.tables[0]?.rows).toEqual([
      ['Name', 'Type'],
      ['a', 'int'],
    ]);
    expect(install?.text).toContain('| a    | int  |');
  });

  it('ignores links in code, and finds badge links and html images', () => {
    const hrefs = doc.rawLinks.map((l) => l.href);
    expect(hrefs).toContain('docs/guide.md');
    expect(hrefs).toContain('https://ci.example.com');
    expect(hrefs).not.toContain('nowhere.md');
    expect(hrefs).not.toContain('y.md');
    expect(doc.rawImages.map((i) => i.src).sort()).toEqual(['assets/logo.png', 'badge.svg']);
  });

  it('numbers duplicate heading anchors like GitHub does', () => {
    const dup = parseMarkdown('# A\n## Notes\n## Notes\n', 'x.md');
    expect(dup.sections.map((s) => s.slug)).toEqual(['a', 'notes', 'notes-1']);
  });

  it('resolves reference-style links', () => {
    const ref = parseMarkdown('See [the guide][g].\n\n[g]: docs/guide.md', 'README.md');
    expect(ref.rawLinks).toEqual([{ text: 'the guide', href: 'docs/guide.md', line: 1 }]);
  });
});

describe('resolveDocument', () => {
  const tree = ctx(['README.md', 'docs/guide.md', 'assets/logo.png'], {
    'README.md': ['tool', 'install', 'usage'],
  });
  const resolved = resolveDocument(parseMarkdown(DOC, 'README.md'), tree);
  const byHref = (href: string) => resolved.links.find((l) => l.href === href);

  it('marks existing files ok and missing ones broken, with a reason', () => {
    expect(byHref('docs/guide.md')).toMatchObject({
      kind: 'internal',
      status: 'ok',
      target: 'docs/guide.md',
    });
    expect(byHref('docs/nope.md')).toMatchObject({
      status: 'broken',
      reason: 'file not found in this commit',
    });
  });

  it('checks same-document anchors', () => {
    expect(byHref('#install')?.status).toBe('ok');
  });

  it('leaves external links unchecked instead of calling them fine', () => {
    expect(byHref('https://ci.example.com')).toMatchObject({
      kind: 'external',
      status: 'unchecked',
    });
  });

  it('resolves assets to raw URLs at the pinned commit and flags missing ones', () => {
    const logo = resolved.assets.find((a) => a.src === 'assets/logo.png');
    expect(logo).toMatchObject({
      exists: true,
      rawUrl: 'https://raw.githubusercontent.com/acme/tool/abc123/assets/logo.png',
    });
    expect(resolved.assets.find((a) => a.src === 'badge.svg')).toMatchObject({
      exists: false,
      rawUrl: null,
    });
  });
});

describe('resolveLink', () => {
  const tree = ctx(['README.md', 'docs/guide.md', 'docs/img/a.png', 'src/index.ts'], {
    'docs/guide.md': ['setup'],
  });

  it.each([
    ['../src/index.ts', 'docs/guide.md', 'ok'],
    ['/src/index.ts', 'docs/guide.md', 'ok'],
    ['img/a.png', 'docs/guide.md', 'ok'],
    ['img', 'docs/guide.md', 'ok'],
    ['../../outside.md', 'docs/guide.md', 'broken'],
    ['guide.md#setup', 'docs/other.md', 'ok'],
    ['guide.md#missing', 'docs/other.md', 'broken'],
    ['docs/guide%2Emd', 'README.md', 'ok'],
    ['guide.md?plain=1', 'docs/other.md', 'ok'],
  ])('%s from %s is %s', (href, from, status) => {
    expect(resolveLink(href, from, tree).status).toBe(status);
  });

  it('classifies mailto and unknown schemes', () => {
    expect(resolveLink('mailto:a@b.c', 'README.md', tree).kind).toBe('mailto');
    expect(resolveLink('javascript:alert(1)', 'README.md', tree)).toMatchObject({
      status: 'unchecked',
      reason: 'unsupported scheme',
    });
  });
});

describe('helpers', () => {
  it('slugifies headings the way GitHub does', () => {
    expect(slugify('Getting Started!')).toBe('getting-started');
    expect(slugify('`npm run` & more')).toBe('npm-run--more');
    expect(slugify('[Link](x) text')).toBe('link-text');
  });

  it('reports which community files are missing', () => {
    const result = missingDocuments(['README.md', 'LICENSE', 'src']);
    expect(result.filter((d) => !d.present).map((d) => d.name)).toEqual([
      'CONTRIBUTING',
      'CODE_OF_CONDUCT',
      'SECURITY',
      'CHANGELOG',
    ]);
  });
});
