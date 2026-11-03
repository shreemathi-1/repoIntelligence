import type { MissingDocs } from '@repointelligence/shared';
import type { Facts } from './facts.js';

const DOC_SUGGEST = {
  README: 'readme',
  CONTRIBUTING: 'contributing',
  CHANGELOG: 'changelog',
} as const;

/** Gaps in the repository's own documentation, each with the generator that would fill it. */
export function findMissingDocs(facts: Facts): MissingDocs {
  const items: MissingDocs['items'] = [];
  for (const d of facts.data.missingDocuments.filter((x) => !x.present)) {
    items.push({
      kind: 'document',
      label: `No ${d.name} file`,
      path: null,
      line: null,
      suggest: d.name in DOC_SUGGEST ? DOC_SUGGEST[d.name as keyof typeof DOC_SUGGEST] : null,
    });
  }
  const docText = facts.data.docs.map((d) => d.sections.map((s) => s.text).join('\n')).join('\n');
  const hasDoc = (pattern: RegExp) => facts.data.docs.some((d) => pattern.test(d.path));
  if (!hasDoc(/(^|\/)(setup|install|getting[-_ ]started)/i) && !/install|getting started|setup/i.test(docText)) {
    items.push({ kind: 'document', label: 'No installation or setup instructions', path: null, line: null, suggest: 'setup' });
  }
  if (facts.data.envExamples.length === 0 && facts.data.findings.some((f) => f.rule === 'env-undocumented')) {
    items.push({ kind: 'document', label: 'No .env example although the code reads settings', path: null, line: null, suggest: 'env' });
  }
  for (const f of facts.data.findings.filter((x) => x.rule === 'env-undocumented').slice(0, 30)) {
    items.push({ kind: 'env', label: `${f.evidence} is not documented`, path: f.path, line: f.line, suggest: 'env' });
  }
  for (const f of facts.data.findings.filter((x) => x.rule === 'doc-script-missing').slice(0, 20)) {
    items.push({ kind: 'script', label: f.message, path: f.path, line: f.line, suggest: 'setup' });
  }
  const routes = facts.graph?.routes ?? [];
  if (routes.length > 0) {
    const documented = (route: string) =>
      docText.includes(route) || facts.data.openApi.some((o) => o.endpoints.some((e) => e.path.replace(/\{(\w+)\}/g, ':$1') === route));
    for (const r of routes.filter((x) => !documented(x.route)).slice(0, 30)) {
      items.push({ kind: 'route', label: `${r.method} ${r.route} is not documented`, path: r.path, line: r.line || null, suggest: 'api' });
    }
  }
  const exported = facts.data.symbols.filter((s) => s.exported && ['function', 'class', 'method'].includes(s.kind));
  for (const s of exported.filter((x) => !x.doc).slice(0, 40)) {
    items.push({ kind: 'symbol', label: `${s.qualifiedName} has no doc comment`, path: s.path, line: s.startLine, suggest: 'docstrings' });
  }
  return {
    fullName: facts.fullName,
    sha: facts.sha,
    items,
    symbolCoverage: exported.length > 0 ? exported.filter((s) => s.doc).length / exported.length : null,
  };
} // prettier-ignore
