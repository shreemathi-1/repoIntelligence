import type { BeginnerScore, RepoCard } from '@repointelligence/shared';

const DAY_MS = 86_400_000;
export const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 } as const;

/**
 * Trending estimate. GitHub exposes no star history, so we rank on what is observable:
 * - repositories created inside the window are scored by stars per day alive (their whole
 *   star count was earned in the window, so this is a real velocity);
 * - older repositories pushed inside the window are scored by log-stars, damped by how long
 *   ago the last push was, because we cannot see how many stars they gained.
 */
export function trendingScore(
  card: Pick<RepoCard, 'stars' | 'createdAt' | 'pushedAt'>,
  windowDays: number,
  now: number,
): number {
  const windowMs = windowDays * DAY_MS;
  const created = card.createdAt ? Date.parse(card.createdAt) : Number.NaN;
  if (Number.isFinite(created) && now - created <= windowMs) {
    const ageDays = Math.max((now - created) / DAY_MS, 0.5);
    return Math.round((card.stars / ageDays) * 100) / 100;
  }
  const pushed = card.pushedAt ? Date.parse(card.pushedAt) : Number.NaN;
  if (!Number.isFinite(pushed) || now - pushed > windowMs) return 0;
  const freshness = 1 - (now - pushed) / windowMs;
  return Math.round(Math.log10(card.stars + 1) * (0.5 + 0.5 * freshness) * 100) / 100;
}

const WORD = /[a-z][a-z0-9]{2,}/g;
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'into',
  'are',
  'you',
]);

function words(text: string | null): Set<string> {
  return new Set((text?.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/** 0..1 from shared topics (60%), same language (25%) and description keywords (15%). */
export function similarity(base: RepoCard, other: RepoCard): number {
  const topics = jaccard(new Set(base.topics), new Set(other.topics));
  const language = base.language !== null && base.language === other.language ? 1 : 0;
  const text = jaccard(words(base.description), words(other.description));
  return Math.round((0.6 * topics + 0.25 * language + 0.15 * text) * 100) / 100;
}

export type SignalStatus = 'present' | 'absent' | 'unavailable';

export interface BeginnerInput {
  hasReadme: SignalStatus;
  hasContributing: SignalStatus;
  hasTests: SignalStatus;
  goodFirstIssues: number | null;
  hasLicense: boolean;
  pushedAt: string | null;
  sizeKb: number | null;
  now: number;
}

const SMALL_REPO_KB = 50_000;
const ACTIVE_DAYS = 180;

/**
 * Weighted checklist over observable signals. Signals we could not observe are left out of
 * the score and lower the confidence; they never count as absent.
 */
export function beginnerScore(input: BeginnerInput): BeginnerScore {
  const pushed = input.pushedAt ? Date.parse(input.pushedAt) : Number.NaN;
  const signals: BeginnerScore['signals'] = [
    {
      id: 'readme',
      label: 'README',
      weight: 3,
      status: input.hasReadme,
      evidence: 'A README file in the repository root',
    },
    {
      id: 'contributing',
      label: 'Contributing guide',
      weight: 2,
      status: input.hasContributing,
      evidence: 'A CONTRIBUTING file in the repository root',
    },
    {
      id: 'tests',
      label: 'Tests',
      weight: 3,
      status: input.hasTests,
      evidence: 'A top-level test directory (tests, test, __tests__, spec)',
    },
    {
      id: 'good-first-issues',
      label: 'Good first issues',
      weight: 3,
      status:
        input.goodFirstIssues === null
          ? 'unavailable'
          : input.goodFirstIssues > 0
            ? 'present'
            : 'absent',
      evidence:
        input.goodFirstIssues === null
          ? 'Open issues labelled "good first issue" could not be counted'
          : `${input.goodFirstIssues} open issue(s) labelled "good first issue"`,
    },
    {
      id: 'license',
      label: 'License',
      weight: 1,
      status: input.hasLicense ? 'present' : 'absent',
      evidence: 'A license detected by GitHub',
    },
    {
      id: 'active',
      label: 'Recently active',
      weight: 2,
      status: !Number.isFinite(pushed)
        ? 'unavailable'
        : input.now - pushed <= ACTIVE_DAYS * DAY_MS
          ? 'present'
          : 'absent',
      evidence: `Pushed within the last ${ACTIVE_DAYS} days`,
    },
    {
      id: 'size',
      label: 'Manageable size',
      weight: 2,
      status:
        input.sizeKb === null
          ? 'unavailable'
          : input.sizeKb <= SMALL_REPO_KB
            ? 'present'
            : 'absent',
      evidence: `Repository size under ${SMALL_REPO_KB / 1000} MB`,
    },
  ];

  const total = signals.reduce((sum, s) => sum + s.weight, 0);
  const observed = signals.filter((s) => s.status !== 'unavailable');
  const observedWeight = observed.reduce((sum, s) => sum + s.weight, 0);
  const presentWeight = observed
    .filter((s) => s.status === 'present')
    .reduce((sum, s) => sum + s.weight, 0);

  return {
    score: observedWeight === 0 ? null : Math.round((presentWeight / observedWeight) * 100),
    confidence: Math.round((observedWeight / total) * 100) / 100,
    signals,
  };
}

const TEST_DIR = /^(tests?|__tests__|specs?)$/i;

/** Reads the root directory listing of a repository for README, CONTRIBUTING and tests. */
export function inspectRootListing(entries: { name: string; type: string }[]): {
  hasReadme: SignalStatus;
  hasContributing: SignalStatus;
  hasTests: SignalStatus;
} {
  const names = entries.map((e) => e.name);
  const dirs = entries.filter((e) => e.type === 'dir').map((e) => e.name);
  const hasContributing = names.some((n) => /^contributing(\.|$)/i.test(n))
    ? 'present'
    : // A guide may live in .github, which we have not opened, so we cannot call it absent.
      dirs.includes('.github')
      ? 'unavailable'
      : 'absent';
  return {
    hasReadme: names.some((n) => /^readme(\.|$)/i.test(n)) ? 'present' : 'absent',
    hasContributing,
    hasTests: dirs.some((d) => TEST_DIR.test(d)) ? 'present' : 'absent',
  };
}
