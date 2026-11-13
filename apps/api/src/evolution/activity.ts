import type { ActivityFacts } from '@repointelligence/shared';
import type { RawIssue, RawPull, Section } from './github-history.js';
import { WEEK_MS, median, round1, weekStart } from './weeks.js';

type Commits = ActivityFacts['commits'];
type CodeFrequency = ActivityFacts['codeFrequency'];
type Contributors = ActivityFacts['contributors'];
type Pulls = ActivityFacts['pullRequests'];
type Issues = ActivityFacts['issues'];

interface WeekTotal {
  week: number;
  total: number;
  days: number[];
}
interface AuthorStats {
  author: { login: string } | null;
  weeks: { w: number; a: number; d: number; c: number }[];
}

const failed = <T extends { status: string; reason: string | null }>(
  section: Exclude<Section<unknown>, { status: 'ok' }>,
  empty: Omit<T, 'status' | 'reason'>,
): T => ({ ...empty, status: section.status, reason: section.reason }) as T;

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function commitSeries(section: Section<WeekTotal[]>, weeks: number[]): Commits {
  const empty = { points: [], total: null, perWeekAverage: null, changePercent: null, byWeekday: null };
  if (section.status !== 'ok') return failed<Commits>(section, empty);
  // GitHub reports the last 52 weeks; a window week it did not report is unknown, not zero.
  const byWeek = new Map(section.data.map((w) => [weekStart(w.week * 1000), w] as const));
  const points = weeks.map((w) => ({ week: iso(w), commits: byWeek.get(w)?.total ?? null }));
  const known = points.flatMap((p) => (p.commits === null ? [] : [p.commits]));
  const total = known.length ? known.reduce((a, b) => a + b, 0) : null;
  const half = Math.floor(points.length / 2);
  const sum = (ps: typeof points) => ps.reduce((a, p) => a + (p.commits ?? 0), 0);
  const first = sum(points.slice(0, half));
  const second = sum(points.slice(points.length - half));
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const w of weeks) {
    byWeek.get(w)?.days.forEach((n, day) => {
      if (day < 7) byWeekday[day] = (byWeekday[day] ?? 0) + n;
    });
  }
  return {
    status: 'ok',
    reason: null,
    points,
    total,
    perWeekAverage: total === null ? null : round1(total / known.length),
    changePercent: known.length === points.length && first > 0 ? Math.round(((second - first) / first) * 100) : null,
    byWeekday: known.length ? byWeekday : null,
  };
} // prettier-ignore

export function codeFrequencySeries(
  section: Section<[number, number, number][]>,
  weeks: number[],
): CodeFrequency {
  if (section.status !== 'ok') return failed<CodeFrequency>(section, { points: [] });
  const byWeek = new Map(section.data.map(([w, a, d]) => [weekStart(w * 1000), { a, d }] as const));
  return {
    status: 'ok',
    reason: null,
    points: weeks.map((w) => {
      const row = byWeek.get(w);
      return { week: iso(w), additions: row ? row.a : null, deletions: row ? Math.abs(row.d) : null };
    }),
  };
} // prettier-ignore

/** Fewest authors whose commits add up to at least half of all commits; null without commits. */
export function busFactor(commitsByAuthor: number[]): number | null {
  const sorted = commitsByAuthor.filter((c) => c > 0).sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let running = 0;
  for (const [i, c] of sorted.entries()) {
    running += c;
    if (running * 2 >= total) return i + 1;
  }
  return sorted.length;
}

export function contributorSeries(section: Section<AuthorStats[]>, weeks: number[]): Contributors {
  const empty = { points: [], top: [], busFactor: null, previousBusFactor: null, truncated: false };
  if (section.status !== 'ok') return failed<Contributors>(section, empty);
  const authors = section.data;
  const start = weeks[0] ?? 0;
  const span = weeks.length * WEEK_MS;
  const reported = new Set(authors.flatMap((a) => a.weeks.map((w) => weekStart(w.w * 1000))));
  const firstWeek = authors.map((a) => {
    const first = a.weeks.find((w) => w.c > 0);
    return first ? weekStart(first.w * 1000) : null;
  });
  const points = weeks.map((w) => {
    if (!reported.has(w)) return { week: iso(w), active: null, newcomers: null };
    const active = authors.filter((a) => a.weeks.some((x) => weekStart(x.w * 1000) === w && x.c > 0)).length;
    return { week: iso(w), active, newcomers: firstWeek.filter((f) => f === w).length };
  });
  const within = (from: number, to: number) =>
    authors.map((a) => {
      const rows = a.weeks.filter((x) => x.w * 1000 >= from && x.w * 1000 < to);
      return {
        login: a.author?.login ?? 'unknown',
        commits: rows.reduce((s, x) => s + x.c, 0),
        additions: rows.reduce((s, x) => s + x.a, 0),
        deletions: rows.reduce((s, x) => s + x.d, 0),
      };
    });
  const current = within(start, start + span);
  const previous = within(start - span, start);
  return {
    status: 'ok',
    reason: null,
    points,
    top: current.filter((c) => c.commits > 0).sort((a, b) => b.commits - a.commits).slice(0, 10),
    busFactor: busFactor(current.map((c) => c.commits)),
    previousBusFactor: busFactor(previous.map((c) => c.commits)),
    truncated: authors.length >= 100,
  };
} // prettier-ignore

/** Counts events per window week; weeks before the listing's coverage are unknown. */
function bucket(times: (string | null)[], weeks: number[], coveredFrom: number | null): (number | null)[] {
  const counts = new Map<number, number>();
  for (const t of times) {
    if (t === null) continue;
    const w = weekStart(Date.parse(t));
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return weeks.map((w) => (coveredFrom !== null && w < coveredFrom ? null : (counts.get(w) ?? 0)));
} // prettier-ignore

const hoursBetween = (from: string, to: string): number =>
  Math.max(0, (Date.parse(to) - Date.parse(from)) / 3_600_000);

function inWindow(t: string | null, from: number, covered: number | null): t is string {
  if (t === null) return false;
  const ms = Date.parse(t);
  return ms >= from && (covered === null || ms >= covered);
}

export function pullSeries(
  section: Section<{ items: RawPull[]; coveredFrom: string | null }>,
  weeks: number[],
): Pulls {
  const empty = { coverageStart: null, points: [], medianHoursToMerge: null };
  if (section.status !== 'ok') return failed<Pulls>(section, empty);
  const { items, coveredFrom } = section.data;
  const covered = coveredFrom ? Date.parse(coveredFrom) : null;
  const opened = bucket(items.map((p) => p.created_at), weeks, covered);
  const merged = bucket(items.map((p) => p.merged_at), weeks, covered);
  const closed = bucket(items.map((p) => (p.merged_at ? null : p.closed_at)), weeks, covered);
  const from = weeks[0] ?? 0;
  return {
    status: 'ok',
    reason: null,
    coverageStart: coveredFrom,
    points: weeks.map((w, i) => ({ week: iso(w), opened: opened[i] ?? null, merged: merged[i] ?? null, closed: closed[i] ?? null })),
    medianHoursToMerge: nullableRound(median(items.filter((p) => inWindow(p.merged_at, from, covered)).map((p) => hoursBetween(p.created_at, p.merged_at ?? p.created_at)))),
  };
} // prettier-ignore

export function issueSeries(
  section: Section<{ items: RawIssue[]; coveredFrom: string | null }>,
  weeks: number[],
): Issues {
  const empty = { coverageStart: null, points: [], medianHoursToClose: null };
  if (section.status !== 'ok') return failed<Issues>(section, empty);
  const { items, coveredFrom } = section.data;
  const covered = coveredFrom ? Date.parse(coveredFrom) : null;
  const opened = bucket(items.map((i) => i.created_at), weeks, covered);
  const closed = bucket(items.map((i) => i.closed_at), weeks, covered);
  const from = weeks[0] ?? 0;
  return {
    status: 'ok',
    reason: null,
    coverageStart: coveredFrom,
    points: weeks.map((w, i) => ({ week: iso(w), opened: opened[i] ?? null, closed: closed[i] ?? null })),
    medianHoursToClose: nullableRound(median(items.filter((i) => inWindow(i.closed_at, from, covered)).map((i) => hoursBetween(i.created_at, i.closed_at ?? i.created_at)))),
  };
} // prettier-ignore

const nullableRound = (n: number | null): number | null => (n === null ? null : round1(n));
