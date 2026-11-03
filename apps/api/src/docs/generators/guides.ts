import { DOC_TARGETS } from '@repointelligence/shared';
import {
  CONTRIB_FILES,
  DEPLOY_FILES,
  around,
  cite,
  excerpt,
  lineOf,
  table,
  type Excerpt,
  type Facts,
} from '../facts.js';
import { section, type DocPlan, type PlannedSection } from '../plan.js';

const RUNTIME: Record<string, string> = {
  npm: 'Node.js',
  pypi: 'Python',
  maven: 'Java',
  go: 'Go',
};

interface Step {
  command: string;
  why: string;
  source: string;
}

/** Install commands from lockfiles and manifests, each tied to the file that implies it. */
export function installSteps(facts: Facts): Step[] {
  const has = (p: string) => facts.paths.includes(p);
  const steps: Step[] = [];
  const add = (command: string, why: string, path: string) => {
    steps.push({ command, why, source: cite({ path, startLine: 1 }) });
  };
  if (has('package-lock.json')) add('npm ci', 'install the locked Node.js dependencies', 'package-lock.json');
  else if (has('pnpm-lock.yaml')) add('pnpm install --frozen-lockfile', 'install Node.js dependencies', 'pnpm-lock.yaml');
  else if (has('yarn.lock')) add('yarn install --frozen-lockfile', 'install Node.js dependencies', 'yarn.lock');
  else if (has('package.json')) add('npm install', 'install Node.js dependencies', 'package.json');
  if (has('poetry.lock')) add('poetry install', 'install Python dependencies', 'poetry.lock');
  else if (has('uv.lock')) add('uv sync', 'install Python dependencies', 'uv.lock');
  else if (has('requirements.txt')) add('pip install -r requirements.txt', 'install Python dependencies', 'requirements.txt');
  else if (has('pyproject.toml')) add('pip install -e .', 'install the Python package', 'pyproject.toml');
  if (has('pom.xml')) add('mvn -B package', 'build with Maven', 'pom.xml');
  else if (has('gradlew')) add('./gradlew build', 'build with Gradle', 'gradlew');
  if (has('go.mod')) add('go mod download', 'fetch Go modules', 'go.mod');
  const env = facts.data.envExamples[0];
  if (env) add(`cp ${env.path} ${env.path.replace(/\.example$|\.sample$|\.template$/, '')}`, 'create your local settings, then fill in the values', env.path);
  return steps;
} // prettier-ignore

/** Each package script as a row with the manifest line that defines it. */
async function scriptRows(facts: Facts, filter?: RegExp): Promise<string[][]> {
  const rows: string[][] = [];
  for (const m of facts.data.manifests.filter((x) => x.ecosystem === 'npm')) {
    const text = await facts.read(m.path);
    for (const [name, command] of Object.entries(m.scripts)) {
      if (filter && !filter.test(name)) continue;
      const line = text ? lineOf(text, `"${name}":`) : null;
      rows.push([
        `\`npm run ${name}\``,
        `\`${command}\``,
        line ? cite({ path: m.path, startLine: line }) : `\`${m.path}\``,
      ]);
    }
  }
  return rows;
}

async function prerequisites(facts: Facts): Promise<string[]> {
  const out: string[] = [];
  for (const m of facts.data.manifests) {
    const text = await facts.read(m.path);
    const engines = Object.entries(m.engines);
    if (engines.length === 0) {
      const runtime = RUNTIME[m.ecosystem];
      if (runtime) out.push(`- ${runtime} (from \`${m.path}\`)`);
      continue;
    }
    for (const [engine, range] of engines) {
      const line = text ? (lineOf(text, `"${engine}"`) ?? lineOf(text, engine)) : null;
      out.push(
        `- ${engine} ${range} ${line ? cite({ path: m.path, startLine: line }) : `(\`${m.path}\`)`}`,
      );
    }
  }
  return [...new Set(out)];
}

/** README sections that already talk about getting started, as material. */
function readmeEvidence(facts: Facts, pattern: RegExp, limit = 3): Excerpt[] {
  return facts.data.chunks
    .filter((c) => c.kind === 'doc' && pattern.test(`${c.heading?.join(' ') ?? ''} ${c.text.slice(0, 200)}`))
    .slice(0, limit)
    .map((c) => ({ path: c.provenance.path, startLine: c.provenance.startLine, endLine: c.provenance.endLine, text: c.text }));
} // prettier-ignore

const stepsMarkdown = (steps: Step[]) =>
  steps.map((s, i) => `${i + 1}. \`${s.command}\`: ${s.why} ${s.source}`).join('\n');

export async function readmeDoc(facts: Facts): Promise<DocPlan> {
  const graph = facts.graph;
  const intro = readmeEvidence(facts, /.*/, 2);
  const entry: Excerpt[] = [];
  for (const e of (graph?.entryPoints ?? []).slice(0, 2)) {
    const text = await facts.read(e.path);
    if (text) entry.push(e.line ? around(e.path, text, e.line, 2, 15) : excerpt(e.path, text, 1, 20));
  }
  const steps = installSteps(facts);
  const scripts = await scriptRows(facts, /^(dev|start|serve|build|test)$/);
  const tops = new Map<string, number>();
  for (const p of facts.paths) {
    if (!p.includes('/')) continue;
    const top = p.split('/')[0] ?? '';
    if (!top.startsWith('.')) tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const license = facts.paths.find((p) => /^licen[cs]e(\..+)?$/i.test(p));
  const sections: PlannedSection[] = [
    section('overview', 'Overview', {
      facts: facts.repo.description ? `_${facts.repo.description}_` : '',
      prose: 'Explain what the project is and who it is for, in one short paragraph, then list up to five main features as bullets.',
      evidence: [...intro, ...entry],
      ...(intro.length + entry.length === 0 && !facts.repo.description && { missing: 'no description, README or entry point was found' }),
    }),
    section('stack', 'Built with', {
      facts: graph?.stack.length
        ? table(['Name', 'Kind', 'Version'], graph.stack.slice(0, 15).map((s) => [s.name, s.category, s.version ?? '']))
        : '',
      ...(!graph && { missing: 'map the architecture to list the stack' }),
    }),
    section('start', 'Getting started', {
      facts: [
        steps.length ? stepsMarkdown(steps) : '',
        scripts.length ? `\n${table(['Command', 'Runs', 'Defined in'], scripts)}` : '',
        `\nSee [the setup guide](${DOC_TARGETS.setup}) for details.`,
      ].join('\n'),
      ...(steps.length === 0 && scripts.length === 0 && { missing: 'no manifest or lockfile was found' }),
    }),
    section('config', 'Configuration', {
      facts: facts.data.envExamples.length
        ? `${facts.data.envExamples.reduce((n, e) => n + e.vars.length, 0)} environment variables, listed in [the configuration guide](${DOC_TARGETS.env}).`
        : '',
      ...(facts.data.envExamples.length === 0 && { missing: 'no .env example was found' }),
    }),
    section('layout', 'Project layout', {
      facts: [...tops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `- \`${d}/\` (${n} files)`).join('\n'),
    }),
    section('license', 'License', {
      facts: license ? `See [${license}](${license}).` : '',
      ...(!license && { missing: 'no license file was found' }),
    }),
  ];
  return { title: facts.repo.fullName.split('/')[1] ?? facts.fullName, sections, notes: [] };
} // prettier-ignore

export async function setupDoc(facts: Facts): Promise<DocPlan> {
  const prereqs = await prerequisites(facts);
  const steps = installSteps(facts);
  const scripts = await scriptRows(facts);
  const evidence = readmeEvidence(facts, /install|setup|set up|getting started|quick ?start|usage|run|develop/i);
  const sections = [
    section('prereq', 'Prerequisites', {
      facts: prereqs.join('\n'),
      ...(prereqs.length === 0 && { missing: 'no manifest declares a runtime' }),
    }),
    section('install', 'Install', {
      facts: stepsMarkdown(steps),
      prose: 'Explain any extra installation steps the material mentions that the list does not cover, such as services to start or tools to install. Leave it empty if there are none.',
      evidence,
      ...(steps.length === 0 && { missing: 'no lockfile or manifest was found' }),
    }),
    section('scripts', 'Commands', {
      facts: scripts.length ? table(['Command', 'Runs', 'Defined in'], scripts) : '',
      ...(scripts.length === 0 && { missing: 'no package scripts were found' }),
    }),
    section('config', 'Configuration', {
      facts: facts.data.envExamples.length ? `Set the variables described in [the configuration guide](${DOC_TARGETS.env}).` : '',
      ...(facts.data.envExamples.length === 0 && { missing: 'no .env example was found' }),
    }),
  ];
  return { title: 'Installation and setup', sections, notes: [] };
} // prettier-ignore

export async function contributingDoc(facts: Facts): Promise<DocPlan> {
  const found = facts.paths.filter((p) => CONTRIB_FILES.test(p)).slice(0, 12);
  const workflows = facts.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const evidence: Excerpt[] = [];
  for (const p of [...found.filter((x) => !/licen[cs]e/i.test(x)), ...workflows].slice(0, 6)) {
    const text = await facts.read(p);
    if (text) evidence.push(excerpt(p, text, 1, 30));
  }
  const checks = await scriptRows(facts, /lint|test|format|typecheck|check|build/);
  const sections = [
    section('setup', 'Setting up', {
      facts: `Follow [the setup guide](${DOC_TARGETS.setup}).`,
    }),
    section('checks', 'Before you open a pull request', {
      facts: checks.length ? table(['Command', 'Runs', 'Defined in'], checks) : '',
      ...(checks.length === 0 && { missing: 'no lint or test scripts were found' }),
    }),
    section('conventions', 'Conventions', {
      facts: found.map((p) => `- \`${p}\` ${cite({ path: p, startLine: 1 })}`).join('\n'),
      prose: 'Describe the coding and commit conventions these files enforce (formatting, lint rules, commit message format, hooks), briefly.',
      evidence,
      ...(found.length === 0 && { missing: 'no formatter, linter or commit convention files were found' }),
    }),
    section('ci', 'Continuous integration', {
      facts: workflows.map((p) => `- \`${p}\` ${cite({ path: p, startLine: 1 })}`).join('\n'),
      prose: 'Say what the CI workflows check on each push or pull request.',
      evidence: evidence.filter((e) => workflows.includes(e.path)),
      ...(workflows.length === 0 && { missing: 'no CI workflows were found' }),
    }),
  ];
  return { title: 'Contributing', sections, notes: [] };
} // prettier-ignore

export async function troubleshootingDoc(facts: Facts): Promise<DocPlan> {
  const items: string[] = [];
  const evidence: Excerpt[] = [];
  for (const f of facts.data.findings) {
    const at = cite({ path: f.path, startLine: f.line ?? 1 });
    if (f.rule === 'doc-script-missing') items.push(`- **\`${f.evidence}\` fails with "missing script".** ${f.message}. ${at}`);
    else if (f.rule === 'env-undocumented') items.push(`- **Startup or a feature fails because a setting is missing.** \`${f.evidence}\` is read here ${at} but is not in the example settings.`);
    else if (f.rule === 'broken-link') items.push(`- **A link in the docs is broken.** ${f.message} ${at}`);
  }
  for (const e of facts.data.envExamples) {
    const text = await facts.read(e.path);
    if (text) evidence.push(excerpt(e.path, text, 1, 40));
    for (const v of e.vars.filter((x) => !x.hasDefault).slice(0, 8)) {
      items.push(`- **\`${v.name}\` is empty.** It has no default in the example ${cite({ path: e.path, startLine: v.line })}; set it before starting.`);
    }
  }
  for (const line of await prerequisites(facts)) {
    if (/\d/.test(line)) items.push(`- **Install or start fails on an older runtime.** Required: ${line.slice(2)}`);
  }
  const sections = [
    section('common', 'Common problems', {
      facts: items.slice(0, 25).join('\n'),
      prose: 'Write a short introduction, then for the most likely problems in the material, add a "Symptom / Fix" pair each. Only problems the material supports.',
      evidence: [...evidence, ...readmeEvidence(facts, /troubleshoot|faq|known issue|error|problem/i, 2)],
      ...(items.length === 0 && { missing: 'no known problems were detected' }),
    }),
  ];
  return { title: 'Troubleshooting', sections, notes: [] };
} // prettier-ignore

const DEPLOY_KIND = (path: string): string =>
  path.includes('Dockerfile') ? 'Container image'
    : path.includes('compose') ? 'Docker Compose'
      : /workflows|gitlab-ci/.test(path) ? 'CI/CD pipeline'
        : path.includes('Procfile') ? 'Process file (Heroku-style)'
          : /k8s|kubernetes|helm/.test(path) ? 'Kubernetes'
            : path.includes('Makefile') ? 'Make targets'
              : 'Platform configuration'; // prettier-ignore

export async function deploymentDoc(facts: Facts): Promise<DocPlan> {
  const files = facts.paths.filter((p) => DEPLOY_FILES.test(p)).slice(0, 8);
  const sections: PlannedSection[] = [];
  for (const path of files) {
    const text = await facts.read(path);
    if (!text) continue;
    const keyLines: string[] = [];
    if (path.includes('Dockerfile')) {
      for (const directive of ['FROM', 'EXPOSE', 'CMD', 'ENTRYPOINT']) {
        const line = lineOf(text, new RegExp(`^\\s*${directive}\\b`, 'i'));
        if (line) keyLines.push(`- \`${(text.split('\n')[line - 1] ?? '').trim()}\` ${cite({ path, startLine: line })}`);
      }
    }
    sections.push(
      section(`file-${sections.length}`, `${DEPLOY_KIND(path)}: \`${path}\``, {
        facts: keyLines.join('\n') || `Defined in ${cite({ path, startLine: 1, endLine: Math.min(text.split('\n').length, 40) })}.`,
        prose: 'Explain what this file builds or deploys, where it runs, and what it needs (ports, secrets, services), in 2-5 sentences or bullets.',
        evidence: [excerpt(path, text, 1, 60)],
      }),
    );
  }
  const start = await scriptRows(facts, /^(start|serve|build)$/);
  sections.push(
    section('run', 'Running in production', {
      facts: [
        start.length ? table(['Command', 'Runs', 'Defined in'], start) : '',
        facts.data.envExamples.length ? `\nProvide the variables from [the configuration guide](${DOC_TARGETS.env}) as secrets on the platform.` : '',
      ].join('\n'),
      ...(start.length === 0 && files.length === 0 && { missing: 'no start command was found' }),
    }),
  );
  return {
    title: 'Deployment',
    sections: files.length ? sections : [section('none', 'Deployment files', { missing: 'no Dockerfile, CI workflow or platform configuration was found' }), ...sections],
    notes: [],
  };
} // prettier-ignore
