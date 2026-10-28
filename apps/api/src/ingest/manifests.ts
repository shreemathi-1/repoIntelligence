import { parse as parseToml } from 'smol-toml';
import { baseName } from './files.js';
import type { EnvVar, Manifest, ManifestDependency } from './types.js';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function stringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
  );
}

function npmDeps(source: Json): ManifestDependency[] {
  const groups: [string, ManifestDependency['scope']][] = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ];
  return groups.flatMap(([key, scope]) =>
    Object.entries(stringMap(source[key])).map(([name, spec]) => ({ name, spec, scope })),
  );
}

function parsePackageJson(text: string, path: string): Manifest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  return {
    path,
    ecosystem: 'npm',
    name: str(json.name),
    version: str(json.version),
    dependencies: npmDeps(json),
    scripts: stringMap(json.scripts),
    engines: stringMap(json.engines),
  };
}

const REQ_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/;

function parseRequirements(
  text: string,
  path: string,
  scope: ManifestDependency['scope'],
): Manifest {
  const dependencies: ManifestDependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/\s+#.*$/, '')
      .replace(/;.*$/, '')
      .trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = REQ_LINE.exec(line);
    if (m?.[1]) dependencies.push({ name: m[1], spec: (m[2] ?? '').trim() || '*', scope });
  }
  return {
    path,
    ecosystem: 'pypi',
    name: null,
    version: null,
    dependencies,
    scripts: {},
    engines: {},
  };
}

function parsePyproject(text: string, path: string): Manifest | null {
  let toml: Json;
  try {
    toml = parseToml(text);
  } catch {
    return null;
  }
  const dependencies: ManifestDependency[] = [];
  const project = isObject(toml.project) ? toml.project : {};
  const fromList = (list: unknown, scope: ManifestDependency['scope']): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const m = typeof entry === 'string' ? REQ_LINE.exec(entry.replace(/;.*$/, '').trim()) : null;
      if (m?.[1]) dependencies.push({ name: m[1], spec: (m[2] ?? '').trim() || '*', scope });
    }
  };
  fromList(project.dependencies, 'runtime');
  if (isObject(project['optional-dependencies'])) {
    for (const group of Object.values(project['optional-dependencies']))
      fromList(group, 'optional');
  }

  const poetry = isObject(toml.tool) && isObject(toml.tool.poetry) ? toml.tool.poetry : null;
  if (poetry && isObject(poetry.dependencies)) {
    for (const [name, spec] of Object.entries(poetry.dependencies)) {
      if (name.toLowerCase() === 'python') continue;
      dependencies.push({
        name,
        spec: typeof spec === 'string' ? spec : (str((spec as Json).version) ?? '*'),
        scope: 'runtime',
      });
    }
  }

  const engines: Record<string, string> = {};
  const python = str(project['requires-python']);
  if (python) engines.python = python;
  return {
    path,
    ecosystem: 'pypi',
    name: str(project.name) ?? str(poetry?.name),
    version: str(project.version) ?? str(poetry?.version),
    dependencies,
    scripts: stringMap(project.scripts),
    engines,
  };
}

function parsePom(text: string, path: string): Manifest {
  const xml = text.replace(/<!--[\s\S]*?-->/g, '');
  const withoutDeps = xml
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<parent>[\s\S]*?<\/parent>/g, '');
  const tag = (source: string, name: string): string | null =>
    new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(source)?.[1] ?? null;
  const dependencies: ManifestDependency[] = [];
  for (const block of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = block[1] ?? '';
    const group = tag(body, 'groupId');
    const artifact = tag(body, 'artifactId');
    if (!group || !artifact) continue;
    const scope = tag(body, 'scope');
    dependencies.push({
      name: `${group}:${artifact}`,
      spec: tag(body, 'version') ?? '*',
      scope: scope === 'test' ? 'dev' : scope === 'provided' ? 'peer' : 'runtime',
    });
  }
  const engines: Record<string, string> = {};
  const java =
    tag(xml, 'maven.compiler.source') ??
    tag(xml, 'java.version') ??
    tag(xml, 'maven.compiler.release');
  if (java) engines.java = java;
  return {
    path,
    ecosystem: 'maven',
    name: tag(withoutDeps, 'artifactId'),
    version: tag(withoutDeps, 'version'),
    dependencies,
    scripts: {},
    engines,
  };
}

function parseGoMod(text: string, path: string): Manifest {
  const dependencies: ManifestDependency[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === 'require (') inBlock = true;
    else if (inBlock && line === ')') inBlock = false;
    else {
      const m = (inBlock ? /^(\S+)\s+(\S+)/ : /^require\s+(\S+)\s+(\S+)/).exec(line);
      if (m?.[1] && m[2]) dependencies.push({ name: m[1], spec: m[2], scope: 'runtime' });
    }
  }
  const engines: Record<string, string> = {};
  const go = /^go\s+(\S+)/m.exec(text)?.[1];
  if (go) engines.go = go;
  return {
    path,
    ecosystem: 'go',
    name: /^module\s+(\S+)/m.exec(text)?.[1] ?? null,
    version: null,
    dependencies,
    scripts: {},
    engines,
  };
}

/** Parses a dependency manifest by file name. Returns null when the file is unreadable. */
export function parseManifest(text: string, path: string): Manifest | null {
  const name = baseName(path);
  if (name === 'package.json') return parsePackageJson(text, path);
  if (name === 'pyproject.toml') return parsePyproject(text, path);
  if (name === 'pom.xml') return parsePom(text, path);
  if (name === 'go.mod') return parseGoMod(text, path);
  if (/^requirements/i.test(name)) {
    return parseRequirements(text, path, /dev|test|lint/i.test(name) ? 'dev' : 'runtime');
  }
  return null;
}

/** Variables listed in a .env.example, with the comment above each as its description. */
export function parseEnvExample(text: string): EnvVar[] {
  const vars: EnvVar[] = [];
  let comment: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') {
      comment = [];
      return;
    }
    if (line.startsWith('#')) {
      const content = line.replace(/^#+\s?/, '');
      // Banners such as "--- Database ---" are headings, not descriptions of the next variable.
      if (!/^[-=]{2,}/.test(content)) comment.push(content);
      return;
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1]) {
      vars.push({
        name: m[1],
        description: comment.length ? comment.join(' ') : null,
        hasDefault: (m[2] ?? '').trim() !== '',
        line: index + 1,
      });
    }
    comment = [];
  });
  return vars;
}
