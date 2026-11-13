import semver from 'semver';

export type VersionScheme = 'node' | 'npm' | 'python' | 'pypi' | 'java' | 'maven' | 'go';

const full = (v: string): string => {
  const [major = '0', minor = '0', patch = '0'] = v.split('.');
  return `${major}.${minor}.${patch}`;
};

/** One PEP 440 clause such as `>=3.10`, `~=3.10.2` or `==3.11.*`; null when it cannot be expressed. */
function pythonClause(clause: string): string | null {
  const m = /^(~=|==|!=|>=|<=|>|<|\^|~)?\s*v?(\d+(?:\.\d+){0,2})(\.\*)?$/.exec(clause.trim());
  if (!m?.[2]) return null;
  const [, op = '==', v, wildcard] = m;
  const parts = v.split('.').map(Number);
  const [major = 0, minor = 0] = parts;
  if (wildcard) return op === '==' ? `${v}.x` : null;
  switch (op) {
    case '==':
      return parts.length === 3 ? full(v) : `${v}.x`;
    case '~=':
      // Compatible release: the last given segment may grow.
      return parts.length === 3
        ? `>=${full(v)} <${major}.${minor + 1}.0`
        : `>=${full(v)} <${major + 1}.0.0`;
    case '!=':
      return null;
    case '^':
    case '~':
      return `${op}${full(v)}`;
    default:
      return `${op}${full(v)}`;
  }
}

/**
 * The spec as a semver range, or null when it is not understood. Callers must treat null as
 * "unknown", never as compatible.
 */
export function toRange(scheme: VersionScheme, spec: string): string | null {
  const text = spec.trim();
  if (text === '' || text === '*') return '*';
  switch (scheme) {
    case 'node':
    case 'npm':
      // Tags, URLs and workspace links are not versions.
      return /^[\dv^~<>=*x|\s.-]/i.test(text) ? semver.validRange(text) : null;
    case 'python':
    case 'pypi': {
      const clauses = text.split(',').map(pythonClause);
      if (clauses.some((c) => c === null)) return null;
      return semver.validRange(clauses.join(' '));
    }
    case 'go': {
      // The `go` directive is a minimum; a module version (`v1.9.1`) allows anything in its major.
      const v = semver.coerce(text);
      if (!v) return null;
      return /^\d+\.\d+(\.\d+)?$/.test(text) ? `>=${v.version}` : `^${v.version}`;
    }
    case 'java': {
      // `1.8` is Java 8; releases are minimums.
      const m = /^(?:1\.)?(\d+)$/.exec(text);
      return m?.[1] ? `>=${m[1]}.0.0` : null;
    }
    case 'maven': {
      const v = semver.coerce(text);
      return v && /^\d/.test(text) ? v.version : null;
    }
  }
} // prettier-ignore

/** Whether a concrete version such as `22` or `3.12.1` falls in the spec. null when unknown. */
export function satisfies(scheme: VersionScheme, version: string, spec: string): boolean | null {
  const range = toRange(scheme, spec);
  const concrete = semver.coerce(scheme === 'java' ? version.replace(/^1\./, '') : version);
  if (range === null || !concrete) return null;
  return semver.satisfies(concrete, range);
}

/** Whether two specs can be met by one version. null when either is not understood. */
export function overlaps(scheme: VersionScheme, a: string, b: string): boolean | null {
  const ra = toRange(scheme, a);
  const rb = toRange(scheme, b);
  if (ra === null || rb === null) return null;
  return semver.intersects(ra, rb);
}

/** The lowest major version a spec allows; null when unknown or unbounded. */
export function majorOf(scheme: VersionScheme, spec: string): number | null {
  const range = toRange(scheme, spec);
  if (range === null || range === '*') return null;
  return semver.minVersion(range)?.major ?? null;
}
