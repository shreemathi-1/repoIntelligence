import { describe, expect, it } from 'vitest';
import { parseBlockComment, parseDocstring } from './comments.js';
import { parseManifest, parseEnvExample } from './manifests.js';
import { normalizeRoute, parseOpenApi } from './openapi.js';
import { extractJava, extractJsTs, extractPython } from './symbols.js';

describe('doc comments', () => {
  it('parses JSDoc summary, description and tags', () => {
    const doc = parseBlockComment(`/**
     * Adds two numbers. Second sentence here.
     *
     * More detail.
     * @param {number} a - first value
     * @param b second value
     * @returns {number} the sum
     */`);
    expect(doc.summary).toBe('Adds two numbers.');
    expect(doc.description).toContain('More detail.');
    expect(doc.tags).toEqual([
      { tag: 'param', name: 'a', text: 'first value' },
      { tag: 'param', name: 'b', text: 'second value' },
      { tag: 'returns', name: null, text: 'the sum' },
    ]);
  });

  it('parses a Python docstring with Sphinx fields', () => {
    const doc = parseDocstring(
      'Load a file.\n\n    :param path: where to read\n    :returns: the text\n    ',
    );
    expect(doc.summary).toBe('Load a file.');
    expect(doc.tags).toEqual([
      { tag: 'param', name: 'path', text: 'where to read' },
      { tag: 'returns', name: null, text: 'the text' },
    ]);
  });
});

const TS = `
import { x } from './x';

/** Greets someone. */
export function greet(name: string, loud = false): string {
  return name;
}

/**
 * A repository client.
 */
export class Client {
  private secret = 1;

  /** Fetches a thing. */
  async fetch(id: string): Promise<void> {
    if (id) {
      return;
    }
  }

  private hidden(): void {}
}

export interface Options { a: number }
export type Id = string;
export const double = (n: number): number => n * 2;
function internal() {}
`;

describe('extractJsTs', () => {
  const symbols = extractJsTs(TS, 'src/a.ts', 'typescript');
  const get = (name: string) => symbols.find((s) => s.qualifiedName === name);

  it('finds functions, classes, methods, types and arrow functions with signatures', () => {
    expect(symbols.map((s) => s.qualifiedName)).toEqual([
      'greet',
      'Client',
      'Client.fetch',
      'Client.hidden',
      'Options',
      'Id',
      'double',
      'internal',
    ]);
    expect(get('greet')?.signature).toBe('function greet(name: string, loud = false): string');
    expect(get('Client.fetch')?.kind).toBe('method');
    expect(get('double')?.kind).toBe('const');
  });

  it('attaches the JSDoc above and marks undocumented symbols', () => {
    expect(get('greet')?.doc?.summary).toBe('Greets someone.');
    expect(get('Client')?.doc?.summary).toBe('A repository client.');
    expect(get('Id')?.doc).toBeNull();
  });

  it('tracks export state and labels every symbol approximate', () => {
    expect(get('greet')?.exported).toBe(true);
    expect(get('internal')?.exported).toBe(false);
    expect(get('Client.hidden')?.exported).toBe(false);
    expect(new Set(symbols.map((s) => s.approximate))).toEqual(new Set([true]));
  });

  it('reports line ranges', () => {
    expect(get('greet')).toMatchObject({ startLine: 5, endLine: 7 });
  });
});

const PY = `
"""Module docstring."""

def top(a, b=2):
    """Do the thing.

    :param a: first
    """
    return a

class Store(Base):
    '''Holds data.'''

    def get(self, key: str) -> int:
        return 1

    async def _private(self):
        pass

def multi(
    one,
    two,
) -> None:
    pass
`;

describe('extractPython', () => {
  const symbols = extractPython(PY, 'lib/core.py');
  const get = (name: string) => symbols.find((s) => s.qualifiedName === name);

  it('finds functions, classes and methods with qualified names', () => {
    expect(symbols.map((s) => s.qualifiedName)).toEqual([
      'top',
      'Store',
      'Store.get',
      'Store._private',
      'multi',
    ]);
    expect(get('Store.get')?.kind).toBe('method');
    expect(get('Store')?.signature).toBe('class Store(Base)');
  });

  it('reads docstrings and leaves missing ones null', () => {
    expect(get('top')?.doc?.summary).toBe('Do the thing.');
    expect(get('top')?.doc?.tags[0]).toMatchObject({ tag: 'param', name: 'a' });
    expect(get('Store')?.doc?.summary).toBe('Holds data.');
    expect(get('Store.get')?.doc).toBeNull();
  });

  it('joins multi-line signatures and marks underscore names private', () => {
    expect(get('multi')?.signature).toBe('def multi( one, two, ) -> None');
    expect(get('Store._private')?.exported).toBe(false);
    expect(get('top')?.exported).toBe(true);
  });
});

const JAVA = `
package demo;

/**
 * Account service.
 */
public class AccountService {
    /**
     * Finds an account.
     * @param id the id
     * @return the account
     * @throws NotFoundException if missing
     */
    public Account find(long id) throws NotFoundException {
        return null;
    }

    private void helper() {
        System.out.println("x");
        if (true) { }
    }
}

interface Repo {}
`;

describe('extractJava', () => {
  const symbols = extractJava(JAVA, 'src/AccountService.java');

  it('finds types and methods, ignoring statements', () => {
    expect(symbols.map((s) => s.qualifiedName)).toEqual([
      'AccountService',
      'AccountService.find',
      'AccountService.helper',
      'Repo',
    ]);
  });

  it('parses Javadoc tags', () => {
    const find = symbols.find((s) => s.name === 'find');
    expect(find?.doc?.summary).toBe('Finds an account.');
    expect(find?.doc?.tags.map((t) => t.tag)).toEqual(['param', 'return', 'throws']);
    expect(find?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'helper')?.exported).toBe(false);
  });
});

describe('parseOpenApi', () => {
  const yaml = `
openapi: 3.0.3
info: { title: Pets, version: 1.2.0 }
servers:
  - url: https://api.example.com
paths:
  /pets:
    parameters:
      - { name: trace, in: header }
    get:
      summary: List pets
      operationId: listPets
      tags: [pets]
      parameters:
        - { name: limit, in: query, required: true }
      responses: { '200': { description: ok }, '500': { description: err } }
    post:
      responses: { '201': { description: made } }
  /pets/{id}:
    delete:
      description: Remove one
      responses: { '204': { description: gone } }
components:
  schemas:
    Pet: { type: object }
    Error: { type: object }
`;

  it('extracts endpoints, parameters, responses and counts schemas', () => {
    const doc = parseOpenApi(yaml, 'openapi.yaml');
    expect(doc).toMatchObject({
      specVersion: '3.0.3',
      title: 'Pets',
      version: '1.2.0',
      schemaCount: 2,
      servers: ['https://api.example.com'],
    });
    expect(doc?.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /pets',
      'POST /pets',
      'DELETE /pets/{id}',
    ]);
    const list = doc?.endpoints[0];
    expect(list).toMatchObject({
      summary: 'List pets',
      operationId: 'listPets',
      tags: ['pets'],
      responses: ['200', '500'],
    });
    expect(list?.parameters).toEqual([
      { name: 'trace', in: 'header', required: false },
      { name: 'limit', in: 'query', required: true },
    ]);
  });

  it('reads Swagger 2.0 JSON', () => {
    const doc = parseOpenApi(
      JSON.stringify({
        swagger: '2.0',
        host: 'x.io',
        basePath: '/v1',
        paths: { '/a': { get: { responses: {} } } },
        definitions: { A: {} },
      }),
      'swagger.json',
    );
    expect(doc).toMatchObject({ specVersion: '2.0', servers: ['x.io/v1'], schemaCount: 1 });
  });

  it('returns null for text that is not an API description', () => {
    expect(parseOpenApi('just: a config', 'x.yaml')).toBeNull();
    expect(parseOpenApi('{ not json', 'x.json')).toBeNull();
    expect(parseOpenApi('- a\n- b', 'x.yaml')).toBeNull();
  });

  it('normalises route styles for comparison', () => {
    expect(normalizeRoute('/pets/:id/')).toBe(normalizeRoute('/pets/{petId}'));
  });
});

describe('parseManifest', () => {
  it('reads package.json scripts and dependency scopes', () => {
    const m = parseManifest(
      JSON.stringify({
        name: 'svc',
        version: '1.0.0',
        scripts: { test: 'vitest' },
        dependencies: { express: '^5' },
        devDependencies: { vitest: '^2' },
        engines: { node: '>=22' },
      }),
      'package.json',
    );
    expect(m).toMatchObject({
      ecosystem: 'npm',
      name: 'svc',
      scripts: { test: 'vitest' },
      engines: { node: '>=22' },
    });
    expect(m?.dependencies).toEqual([
      { name: 'express', spec: '^5', scope: 'runtime' },
      { name: 'vitest', spec: '^2', scope: 'dev' },
    ]);
  });

  it('reads requirements files, skipping comments and options', () => {
    const m = parseManifest(
      '# c\n-r base.txt\nfastapi>=0.115,<1  # web\nuvicorn[standard]==0.30\nrequests ; python_version<"3.9"\n',
      'requirements.txt',
    );
    expect(m?.dependencies).toEqual([
      { name: 'fastapi', spec: '>=0.115,<1', scope: 'runtime' },
      { name: 'uvicorn', spec: '==0.30', scope: 'runtime' },
      { name: 'requests', spec: '*', scope: 'runtime' },
    ]);
    expect(parseManifest('pytest', 'requirements-dev.txt')?.dependencies[0]?.scope).toBe('dev');
  });

  it('reads pyproject.toml (PEP 621 and Poetry)', () => {
    const pep = parseManifest(
      '[project]\nname="lib"\nversion="0.2"\nrequires-python=">=3.12"\ndependencies=["httpx>=0.27","rich"]\n[project.optional-dependencies]\ndev=["pytest"]\n',
      'pyproject.toml',
    );
    expect(pep).toMatchObject({ name: 'lib', engines: { python: '>=3.12' } });
    expect(pep?.dependencies.map((d) => `${d.name}:${d.scope}`)).toEqual([
      'httpx:runtime',
      'rich:runtime',
      'pytest:optional',
    ]);
    const poetry = parseManifest(
      '[tool.poetry]\nname="p"\n[tool.poetry.dependencies]\npython="^3.12"\nflask={version="^3"}\n',
      'pyproject.toml',
    );
    expect(poetry?.dependencies).toEqual([{ name: 'flask', spec: '^3', scope: 'runtime' }]);
  });

  it('reads pom.xml dependencies and ignores commented ones', () => {
    const pom = `<project><artifactId>app</artifactId><version>1.0</version>
      <parent><artifactId>boot-parent</artifactId><version>3.0</version></parent>
      <properties><java.version>21</java.version></properties>
      <dependencies>
        <dependency><groupId>org.x</groupId><artifactId>core</artifactId><version>2.1</version></dependency>
        <dependency><groupId>junit</groupId><artifactId>junit</artifactId><scope>test</scope></dependency>
        <!-- <dependency><groupId>old</groupId><artifactId>gone</artifactId></dependency> -->
      </dependencies></project>`;
    const m = parseManifest(pom, 'pom.xml');
    expect(m).toMatchObject({
      ecosystem: 'maven',
      name: 'app',
      version: '1.0',
      engines: { java: '21' },
    });
    expect(m?.dependencies).toEqual([
      { name: 'org.x:core', spec: '2.1', scope: 'runtime' },
      { name: 'junit:junit', spec: '*', scope: 'dev' },
    ]);
  });

  it('reads go.mod', () => {
    const m = parseManifest(
      'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/y v0.1.0 // indirect\n)\nrequire github.com/c/d v2.0.0\n',
      'go.mod',
    );
    expect(m).toMatchObject({ name: 'example.com/app', engines: { go: '1.22' } });
    expect(m?.dependencies.map((d) => d.name)).toEqual([
      'github.com/a/b',
      'golang.org/x/y',
      'github.com/c/d',
    ]);
  });

  it('returns null for broken manifests instead of throwing', () => {
    expect(parseManifest('{ nope', 'package.json')).toBeNull();
    expect(parseManifest('[project\n', 'pyproject.toml')).toBeNull();
  });
});

describe('parseEnvExample', () => {
  it('lists variables with the comment above as the description', () => {
    const vars = parseEnvExample(
      '# --- Server ---\n# Port to listen on\nPORT=4000\n\nSECRET=\nexport DEBUG = 1\n',
    );
    expect(vars).toEqual([
      { name: 'PORT', description: 'Port to listen on', hasDefault: true, line: 3 },
      { name: 'SECRET', description: null, hasDefault: false, line: 5 },
      { name: 'DEBUG', description: null, hasDefault: true, line: 6 },
    ]);
  });
});
