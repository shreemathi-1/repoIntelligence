import { describe, expect, it } from 'vitest';
import { checkConsistency, type ConsistencyInput } from './consistency.js';
import { parseMarkdown, resolveDocument, type LinkContext } from './markdown.js';
import { parseOpenApi } from './openapi.js';

function input(
  readme: string,
  over: Partial<ConsistencyInput> = {},
  paths: string[] = ['README.md'],
): ConsistencyInput {
  const ctx: LinkContext = {
    repo: 'a/b',
    sha: 's',
    paths: new Set(paths),
    dirs: new Set(),
    anchors: new Map(),
  };
  const doc = resolveDocument(parseMarkdown(readme, 'README.md'), ctx);
  return {
    docs: [{ doc, text: readme }],
    sources: new Map(),
    manifests: [],
    envExamples: [],
    openApi: [],
    paths: ctx.paths,
    dirs: ctx.dirs,
    ...over,
  };
}

const rules = (findings: ReturnType<typeof checkConsistency>) => findings.map((f) => f.rule);

describe('checkConsistency', () => {
  it('reports broken links and missing images with their line', () => {
    const findings = checkConsistency(
      input('# T\nSee [guide](docs/g.md).\n![logo](img/logo.png)\n'),
    );
    expect(rules(findings)).toEqual(['broken-link', 'missing-asset']);
    expect(findings[0]).toMatchObject({ path: 'README.md', line: 2, severity: 'warning' });
  });

  it('flags documented env vars that nothing mentions, only when source was read', () => {
    const readme = 'Set `API_TOKEN` and `DB_URL`.\n';
    expect(rules(checkConsistency(input(readme)))).toEqual([]);

    const withSource = checkConsistency(
      input(readme, { sources: new Map([['src/a.ts', 'const u = process.env.DB_URL;']]) }),
    );
    expect(withSource.map((f) => f.message)).toEqual([expect.stringContaining('API_TOKEN')]);
    expect(withSource[0]?.rule).toBe('doc-env-unreferenced');
  });

  it('accepts variables listed in an .env example', () => {
    const findings = checkConsistency(
      input('Set `API_TOKEN`.\n', {
        sources: new Map([['a.ts', 'x']]),
        envExamples: [
          {
            path: '.env.example',
            vars: [{ name: 'API_TOKEN', description: null, hasDefault: false, line: 1 }],
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
  });

  it('flags env vars the code reads but nobody documents', () => {
    const findings = checkConsistency(
      input('# Docs\n', {
        sources: new Map([
          ['src/a.ts', 'const k = process.env.SECRET_KEY;\nos.getenv("DOCUMENTED_ONE")'],
        ]),
      }),
    );
    expect(findings.map((f) => `${f.rule}:${f.message.split(' ')[0]}`)).toEqual([
      'env-undocumented:SECRET_KEY',
      'env-undocumented:DOCUMENTED_ONE',
    ]);
    expect(findings[0]).toMatchObject({ severity: 'info', line: 1 });
  });

  it('checks documented npm scripts against package.json', () => {
    const manifests = [
      {
        path: 'package.json',
        ecosystem: 'npm' as const,
        name: null,
        version: null,
        dependencies: [],
        scripts: { build: 'tsc' },
        engines: {},
      },
    ];
    const findings = checkConsistency(
      input('Run `npm run build` then:\n```sh\nnpm run deploy\n```\n', { manifests }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'doc-script-missing', line: 3 });
    expect(findings[0]?.message).toContain('"deploy"');
  });

  it('does not judge scripts when there is no package.json', () => {
    expect(checkConsistency(input('Run `npm run deploy`.\n'))).toEqual([]);
  });

  it('compares documented routes with the OpenAPI description', () => {
    const spec = parseOpenApi(
      'openapi: 3.0.0\ninfo: {title: T, version: "1"}\npaths:\n  /pets/{id}:\n    get: {responses: {}}\n',
      'openapi.yaml',
    );
    const findings = checkConsistency(
      input('Call GET /pets/:id or DELETE /pets/:id.\n', { openApi: spec ? [spec] : [] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'doc-route-not-in-openapi' });
    expect(findings[0]?.message).toContain('DELETE /pets/:id');
  });

  it('flags documented file paths that are missing but not build output', () => {
    const findings = checkConsistency(
      input('Edit `src/config.ts` or `dist/index.js` or `src/real.ts`.\n', {}, [
        'README.md',
        'src/real.ts',
      ]),
    );
    expect(findings.map((f) => f.evidence)).toEqual(['src/config.ts']);
    expect(findings[0]?.severity).toBe('info');
  });
});
