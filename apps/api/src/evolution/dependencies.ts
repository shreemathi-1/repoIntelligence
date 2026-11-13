import type { DependencyChanges, ManifestChange } from '@repointelligence/shared';
import { baseName, isManifestName } from '../ingest/files.js';
import { parseManifest } from '../ingest/manifests.js';
import type { Manifest } from '../ingest/types.js';
import type { RawCompare } from './github-history.js';

/** Each changed manifest costs two file reads, so only this many are compared per request. */
export const MAX_MANIFESTS = 6;

type Change = ManifestChange['changed'][number];

/** The first `major.minor.patch` in a version spec such as `^1.2.3`, `>=2.0` or `==3.1.4`. */
export function versionOf(spec: string): [number, number, number] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function classifyChange(from: string, to: string): Pick<Change, 'change' | 'direction'> {
  const a = versionOf(from);
  const b = versionOf(to);
  if (!a || !b) return { change: 'other', direction: 'unknown' };
  const levels = ['major', 'minor', 'patch'] as const;
  for (const [i, level] of levels.entries()) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return { change: level, direction: y > x ? 'upgrade' : 'downgrade' };
  }
  // Same numbers, different range operator (for example `^1.2.0` to `~1.2.0`).
  return { change: 'other', direction: 'unknown' };
}

export function diffManifests(
  path: string,
  before: Manifest | null,
  after: Manifest | null,
): ManifestChange {
  const old = new Map((before?.dependencies ?? []).map((d) => [d.name, d] as const));
  const now = new Map((after?.dependencies ?? []).map((d) => [d.name, d] as const));
  const plain = (d: { name: string; spec: string; scope: string }) => ({ name: d.name, spec: d.spec, scope: d.scope });
  const changed: Change[] = [];
  for (const [name, d] of now) {
    const was = old.get(name);
    if (was && was.spec !== d.spec) {
      changed.push({ name, scope: d.scope, from: was.spec, to: d.spec, ...classifyChange(was.spec, d.spec) });
    }
  }
  return {
    path,
    ecosystem: (after ?? before)?.ecosystem ?? 'unknown',
    added: [...now.values()].filter((d) => !old.has(d.name)).map(plain),
    removed: [...old.values()].filter((d) => !now.has(d.name)).map(plain),
    changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
  };
} // prettier-ignore

/** Reads a file at a ref; null when it does not exist there. */
export type ReadAt = (path: string, ref: string) => Promise<string | null>;

/**
 * Dependency changes between two refs, from the manifests the comparison touched. Lockfiles are
 * not read; the declared ranges are what a maintainer changed on purpose.
 */
export async function dependencyChanges(
  compare: RawCompare,
  base: string,
  head: string,
  read: ReadAt,
): Promise<DependencyChanges> {
  const touched = compare.files.filter((f) => isManifestName(baseName(f.filename)));
  const picked = touched.slice(0, MAX_MANIFESTS);
  const skipped = touched.slice(MAX_MANIFESTS).map((f) => f.filename);
  const manifests: ManifestChange[] = [];
  for (const f of picked) {
    const beforePath = f.previous_filename ?? f.filename;
    const [beforeText, afterText] = await Promise.all([
      f.status === 'added' ? null : read(beforePath, base),
      f.status === 'removed' ? null : read(f.filename, head),
    ]);
    const before = beforeText === null ? null : parseManifest(beforeText, beforePath);
    const after = afterText === null ? null : parseManifest(afterText, f.filename);
    if (!before && !after) {
      skipped.push(f.filename);
      continue;
    }
    const change = diffManifests(f.filename, before, after);
    if (change.added.length || change.removed.length || change.changed.length)
      manifests.push(change);
  }
  return { status: 'ok', reason: null, manifests, skipped };
}
