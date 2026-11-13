import type {
  AuthApproach,
  DbEngine,
  Evidence,
  LicenseInfo,
  Requirements,
  Runtime,
} from '@repointelligence/shared';
import { lineOf, type Facts } from '../docs/facts.js';
import type { Manifest } from '../ingest/types.js';
import {
  AUTH_PACKAGES,
  FRAMEWORKS,
  GENERIC_DATABASE_ENV,
  NATIVE_PACKAGES,
  ORMS,
  SERVICES,
  frameworkKey,
} from './catalog.js';
import type { Detected, RepoSignals } from './types.js';

const MAX_MANIFEST_READS = 8;
const MAX_WORKFLOW_READS = 2;
const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MIGRATION = /(^|\/)migrations?\/[^/]+\.(sql|py|ts|js|rb|go|java)$/;
/** Script commands that need a POSIX shell. */
const SHELL_ONLY =
  /(^|[;&|]\s*)(rm -rf|cp |mv |chmod |export \w+=|sh |bash |\.\/[\w./-]+\.sh)|\$\(/;

const RUNTIME_OF: Record<Manifest['ecosystem'], Runtime> = {
  npm: 'node',
  pypi: 'python',
  maven: 'java',
  go: 'go',
};
const ENGINE_LINE: Record<Runtime, RegExp> = {
  node: /"node"\s*:/,
  python: /requires-python|^\s*python\s*=/,
  java: /maven\.compiler|java\.version|<release>/,
  go: /^go\s+\d/,
};
const DOCKER_IMAGE: Record<Runtime, RegExp> = {
  node: /^FROM\s+(?:[\w./-]+\/)?node:(\d+(?:\.\d+)?)/im,
  python: /^FROM\s+(?:[\w./-]+\/)?python:(\d+\.\d+)/im,
  java: /^FROM\s+(?:[\w./-]+\/)?(?:eclipse-temurin|openjdk|amazoncorretto):(\d+)/im,
  go: /^FROM\s+(?:[\w./-]+\/)?golang:(\d+\.\d+)/im,
};

const file = (path: string, line: number | null, text: string): Evidence => ({
  source: 'file',
  path,
  line,
  text,
});
const depth = (path: string): number => path.split('/').length;
const usable = (m: Manifest) => m.dependencies.filter((d) => d.scope !== 'dev');

/** Reads what the repository needs to run. Everything returned points at where it was found. */
export async function detect(facts: Facts, license: LicenseInfo): Promise<Detected> {
  const manifests = [...facts.data.manifests].sort((a, b) => depth(a.path) - depth(b.path));
  const texts = new Map<string, string>();
  for (const m of manifests.slice(0, MAX_MANIFEST_READS)) {
    const text = await facts.read(m.path);
    if (text !== null) texts.set(m.path, text);
  }
  const root = (name: string): string | undefined => facts.paths.find((p) => p === name);
  const dockerfilePath = root('Dockerfile');
  const composePath = facts.paths.find((p) => COMPOSE.test(p));
  const [dockerfile, compose, nvmrc, pythonVersion] = await Promise.all([
    dockerfilePath ? facts.read(dockerfilePath) : null,
    composePath ? facts.read(composePath) : null,
    root('.nvmrc') ? facts.read('.nvmrc') : null,
    root('.python-version') ? facts.read('.python-version') : null,
  ]);

  const dependencyEvidence = (manifest: Manifest, name: string): Evidence => {
    const text = texts.get(manifest.path);
    const spec = manifest.dependencies.find((d) => d.name === name)?.spec ?? '';
    return file(manifest.path, text ? lineOf(text, name) : null, `${name} ${spec}`.trim());
  };
  const findPackage = (packages: string[], runtimeOnly = true) => {
    for (const m of manifests) {
      const hit = (runtimeOnly ? usable(m) : m.dependencies).find((d) => packages.includes(d.name.toLowerCase()));
      if (hit) return { manifest: m, dependency: hit, evidence: dependencyEvidence(m, hit.name) };
    }
    return null;
  }; // prettier-ignore

  // ---- runtimes ------------------------------------------------------------------------------------
  const runtimes: Requirements['runtimes'] = [];
  const pins: Partial<Record<Runtime, { range: string; evidence: Evidence }>> = {};
  const pin = (runtime: Runtime, version: string | undefined, evidence: Evidence) => {
    if (!version || pins[runtime]) return;
    pins[runtime] = { range: `${version.replace(/^v/, '')}.x`, evidence };
  };
  pin(
    'node',
    /^v?(\d+(?:\.\d+)?)/.exec(nvmrc?.trim() ?? '')?.[1],
    file('.nvmrc', 1, `.nvmrc pins ${nvmrc?.trim() ?? ''}`),
  );
  pin(
    'python',
    /^(\d+\.\d+)/.exec(pythonVersion?.trim() ?? '')?.[1],
    file('.python-version', 1, `.python-version pins ${pythonVersion?.trim() ?? ''}`),
  );
  if (dockerfile && dockerfilePath) {
    for (const runtime of Object.keys(DOCKER_IMAGE) as Runtime[]) {
      const m = DOCKER_IMAGE[runtime].exec(dockerfile);
      if (m) pin(runtime, m[1], file(dockerfilePath, lineOf(dockerfile, m[0]), m[0].trim()));
    }
  }
  for (const m of manifests) {
    const runtime = RUNTIME_OF[m.ecosystem];
    if (runtimes.some((r) => r.runtime === runtime)) continue;
    const declared = m.engines[runtime];
    const text = texts.get(m.path);
    if (declared) {
      const line = text ? lineOf(text, ENGINE_LINE[runtime]) : null;
      runtimes.push({ runtime, range: declared, pinned: false, evidence: [file(m.path, line, `${m.path} requires ${runtime} ${declared}`)] });
      continue;
    }
    const pinned = pins[runtime];
    runtimes.push(
      pinned
        ? { runtime, range: pinned.range, pinned: true, evidence: [pinned.evidence] }
        : { runtime, range: '*', pinned: false, evidence: [file(m.path, 1, `${m.path} is a ${m.ecosystem} manifest and declares no ${runtime} version`)] },
    );
  } // prettier-ignore

  // ---- frameworks ----------------------------------------------------------------------------------
  const frameworks: Requirements['frameworks'] = [];
  for (const rule of FRAMEWORKS) {
    const hit = findPackage(rule.packages);
    if (hit)
      frameworks.push({
        name: rule.name,
        version: hit.dependency.spec || null,
        evidence: [hit.evidence],
      });
  }
  for (const item of facts.graph?.stack ?? []) {
    if (item.category !== 'framework') continue;
    if (frameworks.some((f) => frameworkKey(f.name) === frameworkKey(item.name))) continue;
    frameworks.push({ name: item.name, version: item.version, evidence: [{ source: 'graph', path: null, line: null, text: item.evidence }] });
  } // prettier-ignore

  // ---- configuration -------------------------------------------------------------------------------
  const envVars: Requirements['envVars'] = facts.data.envExamples.flatMap((example) =>
    example.vars.map((v) => ({
      name: v.name,
      required: !v.hasDefault,
      description: v.description,
      evidence: file(example.path, v.line, v.hasDefault ? `${v.name} has a default` : `${v.name} has no default`),
    })),
  ); // prettier-ignore

  // ---- services ------------------------------------------------------------------------------------
  const images = compose && composePath
    ? [...compose.matchAll(/^\s*image:\s*["']?([\w./-]+(?::[\w.-]+)?)/gm)].map((m) => ({ image: m[1] ?? '', evidence: file(composePath, lineOf(compose, m[0].trim()), m[0].trim()) }))
    : []; // prettier-ignore
  const services: Requirements['services'] = [];
  for (const rule of SERVICES) {
    const evidence: Evidence[] = [];
    const { env } = rule;
    if (env) evidence.push(...envVars.filter((v) => env.test(v.name)).slice(0, 3).map((v) => v.evidence));
    const dep = rule.packages ? findPackage(rule.packages) : null;
    if (dep) evidence.push(dep.evidence);
    const { images: pattern } = rule;
    if (pattern) evidence.push(...images.filter((i) => pattern.test(i.image.split('/').pop() ?? '')).map((i) => i.evidence));
    if (evidence.length > 0) services.push({ id: rule.id, label: rule.label, kind: rule.kind, evidence });
  } // prettier-ignore

  // ---- database ------------------------------------------------------------------------------------
  const engines = new Set<DbEngine>();
  const databaseEvidence: Evidence[] = [];
  for (const s of services) {
    const engine = SERVICES.find((r) => r.id === s.id)?.engine;
    if (engine) {
      engines.add(engine);
      databaseEvidence.push(...s.evidence.slice(0, 2));
    }
  }
  const orms: string[] = [];
  for (const [id, orm] of Object.entries(ORMS)) {
    const hit = findPackage(orm.packages);
    const inGraph = facts.graph?.models.some((m) => m.orm.toLowerCase() === id) ?? false;
    if (!hit && !inGraph) continue;
    orms.push(orm.label);
    if (hit) databaseEvidence.push(hit.evidence);
    const [only] = orm.engines;
    if (orm.engines.length === 1 && only) engines.add(only);
  }
  const graphModels = facts.graph?.models ?? [];
  const firstModel = graphModels.find((m) => m.kind !== 'migration');
  if (firstModel)
    databaseEvidence.push(
      file(firstModel.path, firstModel.line, `${firstModel.orm} model ${firstModel.name}`),
    );
  const migrationFiles = facts.paths.filter((p) => MIGRATION.test(p));
  const migrations = Math.max(
    graphModels.filter((m) => m.kind === 'migration').length,
    migrationFiles.length,
  );
  if (migrationFiles[0])
    databaseEvidence.push(
      file(migrationFiles[0], null, `${migrationFiles.length} migration files`),
    );
  const generic = envVars.find((v) => GENERIC_DATABASE_ENV.test(v.name));
  if (generic && engines.size === 0) databaseEvidence.push(generic.evidence);

  // ---- auth ----------------------------------------------------------------------------------------
  const auth: Requirements['auth'] = [];
  for (const rule of AUTH_PACKAGES) {
    const hit = findPackage(rule.packages);
    if (hit) auth.push({ approach: rule.approach, label: rule.label, evidence: hit.evidence });
  }
  const approachOf = (text: string): AuthApproach | null =>
    /saml/i.test(text) ? 'saml' : /oauth|oidc|openid/i.test(text) ? 'oauth' : /jwt|bearer/i.test(text) ? 'jwt' : /session|cookie/i.test(text) ? 'session' : null; // prettier-ignore
  for (const d of facts.graph?.auth ?? []) {
    const approach = approachOf(`${d.kind} ${d.label} ${d.evidence}`);
    if (!approach || auth.some((a) => a.approach === approach)) continue;
    auth.push({
      approach,
      label: d.label,
      evidence: file(d.path, d.line === 0 ? null : d.line, d.evidence),
    });
  }

  // ---- signals for the operating system and deployment checks ---------------------------------------
  const shellScripts: Evidence[] = [];
  const nativePackages: Evidence[] = [];
  for (const m of manifests) {
    const text = texts.get(m.path);
    for (const [name, command] of Object.entries(m.scripts)) {
      if (SHELL_ONLY.test(command)) shellScripts.push(file(m.path, text ? lineOf(text, `"${name}"`) : null, `script "${name}": ${command.slice(0, 120)}`));
    }
    for (const d of m.dependencies) {
      if (NATIVE_PACKAGES.has(d.name.toLowerCase())) nativePackages.push(dependencyEvidence(m, d.name));
    }
  } // prettier-ignore
  let ciSystems: RepoSignals['ciSystems'] = null;
  const systems = new Set<string>();
  for (const path of facts.paths.filter((p) => WORKFLOW.test(p)).slice(0, MAX_WORKFLOW_READS)) {
    const text = await facts.read(path);
    if (!text) continue;
    for (const os of text.match(/\b(ubuntu|windows|macos)(?=-)/g) ?? []) systems.add(os);
    const line = lineOf(text, /runs-on:/);
    if (systems.size > 0 && !ciSystems)
      ciSystems = { systems: [], evidence: file(path, line, `CI in ${path}`) };
  }
  if (ciSystems) {
    ciSystems.systems = [...systems].sort();
    ciSystems.evidence.text = `CI runs on ${ciSystems.systems.join(', ')}`;
  } // prettier-ignore
  const serverFramework = FRAMEWORKS.filter((f) => f.role !== 'ui').find((f) =>
    frameworks.some((x) => x.name === f.name),
  );
  const serverEvidence = serverFramework ? frameworks.find((f) => f.name === serverFramework.name)?.evidence[0] : undefined; // prettier-ignore

  const shellFiles = facts.paths.filter((p) => p.endsWith('.sh'));
  const firstLine = (text: string | null, pattern: RegExp) => (text ? lineOf(text, pattern) : null);
  return {
    requirements: {
      runtimes,
      frameworks,
      dependencyCount: manifests.reduce((n, m) => n + usable(m).length, 0),
      envVars,
      services,
      database: { engines: [...engines], orms, models: graphModels.filter((m) => m.kind !== 'migration').length, migrations, evidence: databaseEvidence },
      auth,
      license,
    },
    signals: {
      dockerfile: dockerfilePath ? file(dockerfilePath, firstLine(dockerfile, /^FROM/im), 'The repository ships a Dockerfile') : null,
      compose: composePath ? file(composePath, firstLine(compose, /services:/), `${composePath} defines ${images.length} service images`) : null,
      shellScripts,
      shellFiles: shellFiles[0] ? file(shellFiles[0], null, `${shellFiles.length} shell scripts, for example ${shellFiles[0]}`) : null,
      windowsFiles: facts.paths.filter((p) => /\.(bat|cmd|ps1)$/i.test(p)).length,
      nativePackages,
      ciSystems,
      server: serverEvidence ?? null,
      hasGraph: facts.graph !== null,
    },
    manifests,
    dependencyEvidence,
  }; // prettier-ignore
}
