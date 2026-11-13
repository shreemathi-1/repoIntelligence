import {
  stackProfileInputSchema,
  type Evidence,
  type StackProfile,
  type StackProfileInput,
} from '@repointelligence/shared';

export const EMPTY_PROFILE: StackProfileInput = stackProfileInputSchema.parse({ name: 'My stack' });

/** The questionnaire answers of a saved profile, without its id and timestamp. */
export function answersOf(saved: StackProfile): StackProfileInput {
  return stackProfileInputSchema.strip().parse(saved);
}

/** `Express 5.1, React 19` as the framework list; a trailing number is the version. */
export function parseFrameworks(text: string): StackProfileInput['frameworks'] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*?)[\s@]+v?(\d+(?:\.\d+){0,2})$/.exec(part);
      return m?.[1] && m[2] ? { name: m[1].trim(), version: m[2] } : { name: part };
    });
}

export function formatFrameworks(frameworks: StackProfileInput['frameworks']): string {
  return frameworks.map((f) => (f.version ? `${f.name} ${f.version}` : f.name)).join(', ');
}

/** The exact line an evidence record points at, on GitHub at the evaluated commit. */
export function evidenceHref(e: Evidence, fullName: string, sha: string): string | null {
  if (e.source !== 'file' || !e.path) return null;
  const path = e.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${fullName}/blob/${sha}/${path}${e.line ? `#L${e.line}` : ''}`;
}

/** The first problem in a draft, in words a form can show. */
export function profileError(draft: unknown): string | null {
  const parsed = stackProfileInputSchema.safeParse(draft);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return issue
    ? `${issue.path.join('.') || 'profile'}: ${issue.message}`
    : 'The profile is not valid';
}
