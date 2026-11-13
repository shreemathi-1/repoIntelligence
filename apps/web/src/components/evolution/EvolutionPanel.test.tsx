import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvolutionPanel } from './EvolutionPanel';

const base = '/api/v1/repos/acme/tool/evolution';
const AT = '2026-10-01T00:00:00.000Z';
const SUMMARY = 'Adds CSV export and moves to Express 5.';
const envelope = (sources: string[], facts: unknown, notes: string[] = []) => ({ fullName: 'acme/tool', retrievedAt: AT, sources, notes, facts, interpretation: null }); // prettier-ignore
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const user = { id: 'u1', login: 'octocat', preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false }, privateRepoScope: false, docsWriteScope: false }; // prettier-ignore

const ok = { status: 'ok', reason: null };
const activity = (weeks: number) => ({
  weeks,
  commits: { ...ok, points: [{ week: '2026-09-20', commits: null }, { week: '2026-09-27', commits: 4 }], total: 4, perWeekAverage: 4, changePercent: null, byWeekday: [0, 1, 1, 1, 1, 0, 0] },
  codeFrequency: { status: 'pending', reason: 'GitHub is still computing these statistics; try again in a minute', points: [] },
  contributors: { ...ok, points: [], top: [{ login: 'ana', commits: 4, additions: 10, deletions: 2 }], busFactor: 1, previousBusFactor: 2, truncated: false },
  pullRequests: { ...ok, coverageStart: null, points: [], medianHoursToMerge: 30 },
  issues: { ...ok, coverageStart: null, points: [], medianHoursToClose: null },
  growth: { ...ok, stars: 250, forks: 12, openIssues: 4, starPoints: [{ at: AT, stars: 250 }], sampled: false },
}); // prettier-ignore

const compareFacts = {
  base: 'v1.0.0', head: 'v1.1.0', status: 'ahead', aheadBy: 2, behindBy: 0, totalCommits: 2, commits: [], authors: 2,
  groups: { breaking: 0, feat: 1, fix: 0, perf: 0, docs: 0, refactor: 0, other: 0, chore: 1, merge: 0 },
  files: { total: 2, truncated: false, additions: 81, deletions: 1, byStatus: { added: 1, removed: 0, modified: 1, renamed: 0, other: 0 }, top: [], directories: [{ path: 'src/export', files: 1, additions: 80, deletions: 0 }] },
  dependencies: { ...ok, manifests: [{ path: 'package.json', ecosystem: 'npm', added: [], removed: [], changed: [{ name: 'express', scope: 'runtime', from: '^4.18.0', to: '^5.1.0', change: 'major', direction: 'upgrade' }] }], skipped: [] },
}; // prettier-ignore

function stubApi(routes: Record<string, (url: URL) => Response>, signedIn = true) {
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(url));
    if (url.pathname === '/api/v1/me') return Promise.resolve(signedIn ? json({ user }) : json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
} // prettier-ignore

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EvolutionPanel fullName="acme/tool" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Evolution panel', () => {
  it('labels activity as retrieved facts, keeps gaps as gaps and follows the period', async () => {
    const fetchMock = stubApi({
      [`GET ${base}/activity`]: (url) => json(envelope(['github', 'computed'], activity(Number(url.searchParams.get('weeks'))))),
    }); // prettier-ignore
    renderPanel();
    const commits = await screen.findByRole('figure', { name: 'Commits per week' }, { timeout: 5000 });
    expect(screen.getByText('Retrieved from GitHub')).toBeVisible();
    expect(screen.getByText('Computed from those records')).toBeVisible();
    expect(screen.queryByText('AI interpretation')).not.toBeInTheDocument();

    const rows = within(commits).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['Sep 20no data', 'Sep 274']);
    expect(screen.getByText(/Still being computed by GitHub/)).toBeVisible();
    expect(screen.getByText('previous period 2')).toBeVisible();

    await userEvent.selectOptions(screen.getByRole('combobox'), '12');
    await screen.findByRole('figure', { name: 'Commits per week' });
    const asked = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)).filter((u) => u.includes('/activity'));
    expect(asked.at(-1)).toContain('weeks=12');
  }); // prettier-ignore

  it('shows release facts and the AI interpretation in separate, labelled places', async () => {
    stubApi({
      [`GET ${base}/releases`]: () => json(envelope(['github', 'computed'], { source: 'releases', inWindow: 2, medianDaysBetween: 33, releases: [
        { tag: 'v1.1.0', name: 'v1.1.0', publishedAt: AT, prerelease: false, url: null, daysSincePrevious: 33 },
        { tag: 'v1.0.0', name: 'v1.0.0', publishedAt: '2026-08-29T00:00:00.000Z', prerelease: false, url: null, daysSincePrevious: null },
      ] })),
      [`GET ${base}/timeline`]: () => json(envelope(['github'], { ref: 'main', page: 1, hasMore: false, releases: [], commits: [{ sha: 'c1', subject: 'add CSV export', author: 'ana', login: 'ana', date: AT, group: 'feat', pr: 9, url: null }] })),
      [`POST ${base}/release-summary`]: () => json({
        ...envelope(['github', 'computed'], { tag: 'v1.1.0', base: 'v1.0.0', publishedAt: AT, compare: compareFacts }),
        id: 'a'.repeat(24), reused: false, interpretationNote: null,
        interpretation: { summary: SUMMARY, highlights: ['CSV export'], risks: ['Express 5 is a major upgrade'], writtenBy: 'groq/gpt-oss-120b', generatedAt: AT },
      }, 201),
    }); // prettier-ignore
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Releases' }));
    expect(await screen.findByText('add CSV export', {}, { timeout: 5000 })).toBeVisible();
    const [first] = screen.getAllByRole('button', { name: 'Summary' });
    if (!first) throw new Error('expected a summary button');
    await userEvent.click(first);
    await userEvent.click(screen.getByRole('button', { name: 'Summarise v1.1.0' }));

    const facts = await screen.findByRole('region', { name: 'Release facts' });
    const reading = screen.getByRole('region', { name: 'AI interpretation' });
    expect(within(facts).getByText('Retrieved from GitHub')).toBeVisible();
    expect(within(facts).getByText(/express \^4\.18\.0 → \^5\.1\.0/)).toBeVisible();
    expect(within(facts).queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(within(reading).getByText('AI interpretation')).toBeVisible();
    expect(within(reading).getByText(/Written by groq\/gpt-oss-120b/)).toBeVisible();
    expect(within(reading).getByText(SUMMARY)).toBeVisible();
    expect(within(reading).queryByText('Retrieved from GitHub')).not.toBeInTheDocument();
  });

  it('lists regressions from the analysis history', async () => {
    const areas = {
      codeQuality: 80,
      security: 70,
      tests: null,
      maintainability: 60,
      documentation: 50,
      dependencies: 90,
      architecture: null,
      community: 40,
      activity: 30,
      cicd: 20,
      busFactor: 10,
    };
    const point = (runId: string, overall: number | null) => ({ runId, sha: `${runId}${'0'.repeat(39)}`, finishedAt: AT, overall, confidence: 0.8, areas, findings: { total: 3, bySeverity: { critical: 0, high: 1, medium: 1, low: 1, info: 0 } }, debt: { complexFunctions: 2, averageCcn: 3, duplicationPercent: 1, vulnerabilities: 0, cycles: null, layerViolations: null } }); // prettier-ignore
    stubApi({
      [`GET ${base}/quality`]: () => json(envelope(['analysis', 'computed'], { points: [point('a', 80), point('b', null)], thresholds: { overallDrop: 10, areaDrop: 10, findingsRise: 0.2 }, regressions: [{ kind: 'findings-rise', runId: 'b', sha: `b${'0'.repeat(39)}`, at: AT, area: null, before: 2, after: 3, message: 'Findings rose from 2 to 3' }] })),
      [`GET ${base}/languages`]: () => json(envelope(['github'], { points: [], languages: [] }, ['History comes from 0 analysis snapshots.'])),
      [`GET ${base}/architecture`]: () => json(envelope(['graph', 'computed'], { snapshots: [], changes: [] })),
    }); // prettier-ignore
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Quality history' }));
    expect(
      await screen.findByText('Findings rose from 2 to 3', {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText('From stored analysis runs')).toBeVisible();
    const health = screen.getByRole('figure', { name: 'Health score' });
    expect(
      within(health)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent.endsWith('no data')),
    ).toEqual([false, true]);
    expect(screen.getByText('No language data yet.')).toBeVisible();
  });
});
