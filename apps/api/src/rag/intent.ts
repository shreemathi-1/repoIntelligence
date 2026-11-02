import type { ArchitectureGraph } from '@repointelligence/shared';

export const INTENTS = [
  'function',
  'api',
  'database',
  'config',
  'explain',
  'find',
  'compare',
  'example',
  'general',
] as const;
export type Intent = (typeof INTENTS)[number];

const RULES: [Intent, RegExp][] = [
  ['api', /\b(endpoint|route|api|request|response|rest|graphql|controller|handler|http|get|post|put|delete)\b/i],
  ['database', /\b(database|db|schema|model|table|collection|migration|query|orm|mongo|sql|prisma|entity)\b/i],
  ['config', /\b(config|configuration|env|environment|variable|setting|flag|option|\.env|secret|credential)\b/i],
  ['explain', /\b(explain|walk me through|line by line|what does this (code|function|file) do|how does .* work)\b/i],
  ['compare', /\b(compare|difference|differ|versus|vs\.?|better|instead of)\b/i],
  ['example', /\b(example|sample|snippet|how (do|can|would) i (use|call|run)|usage)\b/i],
  ['find', /\b(where|which file|locate|find|defined|declared|implemented)\b/i],
  ['function', /\b(function|method|class|hook|component|service|util|helper|module|parameter|argument|return)\b/i],
]; // prettier-ignore

export function classifyIntent(question: string): Intent {
  for (const [intent, rule] of RULES) if (rule.test(question)) return intent;
  return 'general';
}

const STOP = new Set(
  'a an the is are was were be been of in on at to for from by with and or not no do does did how what which where who why when this that these those it its into about as can could would should i you we they me my your our their there here than then also just like use using used'.split(
    ' ',
  ),
);

/** Lowercase search terms, with camelCase and snake_case split so `getUser` matches "user". */
export function termsOf(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./\\:]+/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g);
  return [...new Set((words ?? []).filter((w) => !STOP.has(w)))];
}

/**
 * A deliberately small stemmer: enough that "deleted", "deletes" and "deleteOne" meet, without
 * a dictionary. Only used for matching, never shown.
 */
export function stem(term: string): string {
  let t = term;
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 4 && /(ses|xes|ches|shes)$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  if (t.length > 3 && t.at(-1) === t.at(-2)) t = t.slice(0, -1);
  return t;
}

/**
 * Names from the architecture graph that the question mentions. They are added to the
 * keyword search so "the users endpoint" also pulls in the file that defines /users.
 */
export function boostTerms(
  question: string,
  graph: Pick<ArchitectureGraph, 'routes' | 'models' | 'symbols'> | null,
): string[] {
  if (!graph) return [];
  const asked = new Set(termsOf(question).map(stem));
  const mentions = (label: string) => termsOf(label).some((t) => asked.has(stem(t)));
  const out = new Set<string>();
  const labels = [
    ...graph.routes.map((r) => r.route),
    ...graph.models.map((m) => m.name),
    ...graph.symbols.map((s) => s.name),
  ];
  for (const label of labels) {
    if (mentions(label)) for (const t of termsOf(label)) out.add(t);
  }
  return [...out].slice(0, 12);
}
