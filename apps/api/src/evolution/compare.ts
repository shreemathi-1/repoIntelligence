import {
  COMMIT_GROUPS,
  FILE_STATUSES,
  type CommitGroup,
  type CommitItem,
  type CompareFacts,
  type DependencyChanges,
  type ReleaseItem,
} from '@repointelligence/shared';
import { parseCommit } from '../docs/generators/changelog.js';
import type { RawCommit, RawCompare, RawRelease } from './github-history.js';
import { DAY_MS, median, round1 } from './weeks.js';

const TOP_FILES = 20;
const TOP_DIRECTORIES = 15;
/** GitHub lists at most this many files in a comparison. */
export const COMPARE_FILE_LIMIT = 300;

/** Conventional Commits groups, with merges and housekeeping kept apart from real changes. */
export function toCommitItem(raw: RawCommit): CommitItem {
  const header = raw.message.split('\n')[0] ?? '';
  const entry = parseCommit(raw.sha, raw.message);
  const group: CommitGroup = entry ? entry.group : header.startsWith('Merge ') ? 'merge' : 'chore';
  return {
    sha: raw.sha,
    subject: entry?.subject ?? header,
    author: raw.name,
    login: raw.login,
    date: raw.date,
    group,
    pr: entry?.pr ?? null,
    url: raw.url,
  };
}

/** `src/api/routes.ts` belongs to `src/api`; a top-level file belongs to `(root)`. */
export function directoryOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '(root)';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

type FileStatus = (typeof FILE_STATUSES)[number];
const statusOf = (s: string): FileStatus =>
  (FILE_STATUSES as readonly string[]).includes(s) ? (s as FileStatus) : 'other';

export function summarizeCompare(
  raw: RawCompare,
  base: string,
  head: string,
  dependencies: DependencyChanges,
): CompareFacts {
  const commits = raw.commits.map(toCommitItem);
  const groups = Object.fromEntries(COMMIT_GROUPS.map((g) => [g, 0])) as Record<CommitGroup, number>;
  for (const c of commits) groups[c.group] += 1;
  const byStatus = Object.fromEntries(FILE_STATUSES.map((s) => [s, 0])) as Record<FileStatus, number>;
  const dirs = new Map<string, { files: number; additions: number; deletions: number }>();
  for (const f of raw.files) {
    byStatus[statusOf(f.status)] += 1;
    const key = directoryOf(f.filename);
    const d = dirs.get(key) ?? { files: 0, additions: 0, deletions: 0 };
    dirs.set(key, { files: d.files + 1, additions: d.additions + f.additions, deletions: d.deletions + f.deletions });
  }
  const changes = (x: { additions: number; deletions: number }) => x.additions + x.deletions;
  return {
    base,
    head,
    status: raw.status,
    aheadBy: raw.ahead_by,
    behindBy: raw.behind_by,
    totalCommits: raw.total_commits,
    commits,
    authors: new Set(commits.map((c) => c.login ?? c.author ?? c.sha)).size,
    groups,
    files: {
      total: raw.files.length,
      truncated: raw.files.length >= COMPARE_FILE_LIMIT,
      additions: raw.files.reduce((s, f) => s + f.additions, 0),
      deletions: raw.files.reduce((s, f) => s + f.deletions, 0),
      byStatus,
      top: [...raw.files].sort((a, b) => changes(b) - changes(a)).slice(0, TOP_FILES)
        .map((f) => ({ path: f.filename, status: statusOf(f.status), additions: f.additions, deletions: f.deletions })),
      directories: [...dirs.entries()].map(([path, d]) => ({ path, ...d }))
        .sort((a, b) => changes(b) - changes(a)).slice(0, TOP_DIRECTORIES),
    },
    dependencies,
  };
} // prettier-ignore

/** Published releases newest first, with the gap to the one before each. Drafts are left out. */
export function releaseItems(raw: RawRelease[]): ReleaseItem[] {
  const published = raw
    .filter((r) => !r.draft)
    .map((r) => ({ r, at: r.published_at ?? r.created_at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return published.map(({ r, at }, i) => {
    const previous = published[i + 1];
    return {
      tag: r.tag_name,
      name: r.name,
      publishedAt: at,
      prerelease: r.prerelease,
      url: r.html_url,
      daysSincePrevious: previous ? round1((Date.parse(at) - Date.parse(previous.at)) / DAY_MS) : null,
    };
  });
} // prettier-ignore

/** Tags have no dates, so their cadence is unknown rather than zero. */
export function tagItems(tags: { name: string }[]): ReleaseItem[] {
  return tags.map((t) => ({
    tag: t.name,
    name: null,
    publishedAt: null,
    prerelease: false,
    url: null,
    daysSincePrevious: null,
  }));
}

export function releaseCadence(
  items: ReleaseItem[],
  since: number,
): { inWindow: number | null; medianDaysBetween: number | null } {
  const dated = items.filter((i) => i.publishedAt !== null);
  if (dated.length === 0) return { inWindow: null, medianDaysBetween: null };
  const gaps = items.flatMap((i) => (i.daysSincePrevious === null ? [] : [i.daysSincePrevious]));
  const m = median(gaps);
  return {
    inWindow: dated.filter((i) => Date.parse(i.publishedAt ?? '') >= since).length,
    medianDaysBetween: m === null ? null : round1(m),
  };
}
