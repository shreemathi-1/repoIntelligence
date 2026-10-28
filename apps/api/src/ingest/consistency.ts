import { dirname } from 'node:path/posix';
import { normalizeRoute } from './openapi.js';
import type { EnvVar, Finding, Manifest, MdDocument, OpenApiDoc } from './types.js';

export interface ConsistencyInput {
  docs: { doc: MdDocument; text: string }[];
  /** Source files that were read, by path. */
  sources: Map<string, string>;
  manifests: Manifest[];
  envExamples: { path: string; vars: EnvVar[] }[];
  openApi: OpenApiDoc[];
  paths: Set<string>;
  dirs: Set<string>;
}

const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
// Variables every system has or that tools define, so documenting them proves nothing.
const COMMON_ENV = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'USER',
  'PWD',
  'LANG',
  'CI',
  'PYTHONPATH',
  'JAVA_HOME',
  'LOG_LEVEL',
]);
const EXPLICIT_ENV_READ = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
];
const VENDORISH = new Set(['dist', 'build', 'out', 'node_modules', 'target', 'coverage', '.venv']);

interface CodeSpan {
  text: string;
  line: number;
}

/** Inline code spans and fenced code lines of a Markdown file, with line numbers. */
function codeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) {
      spans.push({ text: line, line: index + 1 });
      return;
    }
    for (const m of line.matchAll(/(`+)(.+?)\1/g))
      spans.push({ text: m[2] ?? '', line: index + 1 });
  });
  return spans;
}

export function checkConsistency(input: ConsistencyInput): Finding[] {
  const findings: Finding[] = [];

  // 1. Links and images that point nowhere.
  for (const { doc } of input.docs) {
    for (const link of doc.links) {
      if (link.status === 'broken') {
        findings.push({
          rule: 'broken-link',
          severity: 'warning',
          message: `Link "${link.href}" is broken: ${link.reason ?? 'target not found'}`,
          path: doc.path,
          line: link.line,
          evidence: `[${link.text}](${link.href})`,
        });
      }
    }
    for (const asset of doc.assets) {
      if (asset.kind === 'internal' && asset.exists === false) {
        findings.push({
          rule: 'missing-asset',
          severity: 'warning',
          message: `Image "${asset.src}" is not in this commit`,
          path: doc.path,
          line: asset.line,
          evidence: asset.src,
        });
      }
    }
  }

  // 2. Environment variables: documented but unused, and used but undocumented.
  const exampleNames = new Set(input.envExamples.flatMap((e) => e.vars.map((v) => v.name)));
  const sourceText = [...input.sources.values()].join('\n');
  const referenced = new Set(sourceText.match(ENV_NAME) ?? []);
  const documented = new Set<string>(exampleNames);

  for (const { doc, text } of input.docs) {
    const reported = new Set<string>();
    for (const span of codeSpans(text)) {
      for (const name of span.text.match(ENV_NAME) ?? []) {
        documented.add(name);
        if (COMMON_ENV.has(name) || reported.has(name) || exampleNames.has(name)) continue;
        // Without any source files read, "never used" would be a guess.
        if (input.sources.size === 0 || referenced.has(name)) continue;
        // Mentioned inside a command line (a shell variable), not a setting of this project.
        if (/^\s*\$|\becho\b/.test(span.text)) continue;
        reported.add(name);
        findings.push({
          rule: 'doc-env-unreferenced',
          severity: 'warning',
          message: `${name} is documented but no scanned source file or .env example mentions it`,
          path: doc.path,
          line: span.line,
          evidence: span.text.trim(),
        });
      }
    }
  }

  const docText = input.docs.map((d) => d.text).join('\n');
  for (const [path, text] of input.sources) {
    const seen = new Set<string>();
    for (const pattern of EXPLICIT_ENV_READ) {
      for (const m of text.matchAll(pattern)) {
        const name = m[1];
        if (!name || seen.has(name) || COMMON_ENV.has(name)) continue;
        seen.add(name);
        if (documented.has(name) || docText.includes(name)) continue;
        findings.push({
          rule: 'env-undocumented',
          severity: 'info',
          message: `${name} is read by the code but not documented or listed in an .env example`,
          path,
          line: text.slice(0, m.index).split('\n').length,
          evidence: m[0],
        });
      }
    }
  }

  // 3. npm scripts that docs tell people to run.
  const npmManifests = input.manifests.filter((m) => m.ecosystem === 'npm');
  if (npmManifests.length > 0) {
    const scripts = new Set(npmManifests.flatMap((m) => Object.keys(m.scripts)));
    for (const { doc, text } of input.docs) {
      for (const span of codeSpans(text)) {
        for (const m of span.text.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
          const script = m[1] ?? '';
          if (!scripts.has(script)) {
            findings.push({
              rule: 'doc-script-missing',
              severity: 'warning',
              message: `Docs say to run "${script}" but no package.json defines that script`,
              path: doc.path,
              line: span.line,
              evidence: m[0],
            });
          }
        }
      }
    }
  }

  // 4. API routes in docs that the OpenAPI description does not have.
  if (input.openApi.length > 0) {
    const known = new Set(
      input.openApi.flatMap((o) => o.endpoints.map((e) => `${e.method} ${normalizeRoute(e.path)}`)),
    );
    for (const { doc, text } of input.docs) {
      text.split(/\r?\n/).forEach((line, index) => {
        for (const m of line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-./{}:]*)/g)) {
          const key = `${m[1]} ${normalizeRoute(m[2] ?? '')}`;
          if (!known.has(key)) {
            findings.push({
              rule: 'doc-route-not-in-openapi',
              severity: 'warning',
              message: `${m[1]} ${m[2]} is documented but missing from the OpenAPI description`,
              path: doc.path,
              line: index + 1,
              evidence: m[0],
            });
          }
        }
      });
    }
  }

  // 5. File paths in docs that do not exist in this commit.
  for (const { doc, text } of input.docs) {
    const reported = new Set<string>();
    for (const span of codeSpans(text)) {
      const candidate = span.text.trim();
      if (!/^\.?\/?[\w.@-]+(\/[\w.@-]+)+\.[A-Za-z0-9]{1,6}$/.test(candidate)) continue;
      const clean = candidate.replace(/^\.\//, '').replace(/^\//, '');
      // Build output and installed packages are not in the repository by design.
      if (VENDORISH.has(clean.split('/')[0] ?? '')) continue;
      const nearby = `${dirname(doc.path) === '.' ? '' : `${dirname(doc.path)}/`}${clean}`;
      if (input.paths.has(clean) || input.paths.has(nearby) || reported.has(clean)) continue;
      reported.add(clean);
      findings.push({
        rule: 'doc-path-missing',
        severity: 'info',
        message: `Docs mention ${clean} but it is not in this commit`,
        path: doc.path,
        line: span.line,
        evidence: candidate,
      });
    }
  }

  return findings;
}
