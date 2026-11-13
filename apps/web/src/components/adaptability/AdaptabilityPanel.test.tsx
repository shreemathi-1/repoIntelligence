import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adaptabilityReportSchema, stackProfileInputSchema } from '@repointelligence/shared';
import { AdaptabilityPanel } from './AdaptabilityPanel';

const SHA = 'c'.repeat(40);
const base = '/api/v1/repos/acme/tool';
const EXPLANATION = 'The license fits; the Node version is the gap.';
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const user = { id: 'u1', login: 'octocat', preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false }, privateRepoScope: false, docsWriteScope: false }; // prettier-ignore
const ingestion = { fullName: 'acme/tool', sha: SHA, ref: 'main', status: 'completed', private: false, startedAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T00:01:00.000Z', stats: null, error: null, reused: true }; // prettier-ignore

const engine = {
  source: 'file',
  path: 'package.json',
  line: 17,
  text: 'package.json requires node >=22',
};
const mine = { source: 'profile', path: null, line: null, text: 'Your stack runs Node.js 18' };
const dimension = (id: string, label: string, score: number | null, summary: string, evidence: unknown[] = []) => ({ id, label, status: score === null ? 'unavailable' : 'measured', score, weight: 10, summary, evidence }); // prettier-ignore

function report(profile: unknown, over: Record<string, unknown> = {}) {
  return adaptabilityReportSchema.parse({
    id: null,
    fullName: 'acme/tool',
    sha: SHA,
    profile,
    generatedAt: '2026-10-02T00:00:00.000Z',
    notes: [],
    facts: {
      overall: { score: 62, confidence: 0.85, verdict: 'adaptable', formula: 'Weight-averaged mean of the compared dimensions.' },
      dimensions: [
        dimension('runtime', 'Language and runtime', 35, 'Node.js 18 does not satisfy >=22', [engine]),
        dimension('dependencies', 'Dependencies', null, 'Add your own dependencies to the profile to check for version conflicts.'),
      ],
      warnings: [{ id: 'runtime-version-node', dimension: 'runtime', severity: 'major', message: 'The repository requires Node.js >=22; you run 18.', evidence: [engine, mine] }],
      requirements: {
        runtimes: [{ runtime: 'node', range: '>=22', pinned: false, evidence: [engine] }],
        frameworks: [], dependencyCount: 3, envVars: [], services: [],
        database: { engines: [], orms: [], models: 0, migrations: 0, evidence: [] },
        auth: [], license: { spdxId: 'MIT', category: 'permissive', flags: [] },
      },
      breakingRisk: { level: 'medium', reasons: [{ text: 'Node.js 18 does not satisfy the required >=22', evidence: [engine] }] },
      missingInfrastructure: [],
      setupComplexity: { level: 'low', factors: [] },
      effort: { hours: { low: 5, high: 18 }, basis: [{ text: 'Base setup (low complexity)', hours: { low: 1, high: 2 } }], estimate: true },
      modifications: [{ id: 'runtime-upgrade-node', dimension: 'runtime', title: 'Move to Node.js >=22', detail: 'Change your Node.js version.', hours: { low: 4, high: 16 }, evidence: [engine] }],
      inputs: { ingestion: true, graph: true },
    },
    checklist: [
      { id: 'pin-commit', dimension: null, text: 'Check out commit cccccccccccc', done: false },
      { id: 'runtime-upgrade-node', dimension: 'runtime', text: 'Move to Node.js >=22.', done: false },
    ],
    interpretation: null,
    interpretationNote: null,
    ...over,
  });
} // prettier-ignore

type Handler = (url: URL, body: unknown) => Response;
function stubApi(routes: Record<string, Handler>, opts: { signedIn?: boolean; ingested?: boolean } = {}) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    if (handler) return Promise.resolve(handler(url, body));
    if (url.pathname === '/api/v1/me') return Promise.resolve(opts.signedIn ? json({ user }) : json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
    if (url.pathname === `${base}/ingestions/latest`) return Promise.resolve(opts.ingested === false ? json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404) : json(ingestion));
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));
  }));
  return calls;
} // prettier-ignore

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdaptabilityPanel fullName="acme/tool" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Adaptability panel', () => {
  it('asks for an ingestion first', async () => {
    stubApi({}, { ingested: false });
    renderPanel();
    expect(await screen.findByText(/Ingest this repository first/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Evaluate/ })).not.toBeInTheDocument();
  });

  it('evaluates the entered stack and links each warning to its evidence', async () => {
    const calls = stubApi({ [`POST ${base}/adaptability`]: (_u, body) => json(report((body as { profile: unknown }).profile)) });
    renderPanel();
    await userEvent.type(await screen.findByLabelText('Node.js'), '18');
    await userEvent.type(screen.getByLabelText('Frameworks'), 'Express 5.1, React');
    await userEvent.click(screen.getByLabelText('Windows'));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate against this stack' }));

    const results = await screen.findByRole('region', { name: 'Adaptability results' });
    const sent = stackProfileInputSchema.parse((calls.find((c) => c.key === `POST ${base}/adaptability`)?.body as { profile: unknown }).profile);
    expect(sent).toMatchObject({ runtimes: { node: '18' }, frameworks: [{ name: 'Express', version: '5.1' }, { name: 'React' }], os: ['linux', 'windows'] });

    expect(within(results).getByText('62 / 100')).toBeVisible();
    expect(within(results).getByText('Adaptable with changes')).toBeVisible();
    expect(within(results).getByText('Computed by fixed rules from the repository files')).toBeVisible();
    expect(within(results).getByText('not compared')).toBeVisible();
    const warning = within(results).getByText(/requires Node\.js >=22; you run 18/).closest('li');
    if (!warning) throw new Error('expected the warning');
    expect(within(warning).getByText('Major')).toBeVisible();
    expect(within(warning).getByRole('link', { name: 'package.json:17' })).toHaveAttribute('href', `https://github.com/acme/tool/blob/${SHA}/package.json#L17`);
    expect(within(warning).getByText(/From your profile/)).toBeVisible();

    // Anonymous: nothing is stored, so ticks stay on the page and there is no export or explanation.
    await userEvent.click(within(results).getByLabelText('Move to Node.js >=22.'));
    expect(within(results).getByLabelText('Move to Node.js >=22.')).toBeChecked();
    expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(false);
    expect(screen.getByText(/Sign in to keep this report/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Explain these results' })).not.toBeInTheDocument();
    expect(screen.queryByText('AI interpretation')).not.toBeInTheDocument();
  }); // prettier-ignore

  it('shows what is wrong with the stack instead of sending it', async () => {
    const calls = stubApi({});
    renderPanel();
    await userEvent.type(await screen.findByLabelText('Python'), 'latest');
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate against this stack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/runtimes\.python/);
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('keeps the explanation apart from the results for a signed-in user', async () => {
    const id = 'a'.repeat(24);
    const saved = { ...stackProfileInputSchema.parse({ name: 'Legacy API', runtimes: { node: '18' } }), id: 'b'.repeat(24), updatedAt: '2026-10-01T00:00:00.000Z' };
    const stored = (over: Record<string, unknown> = {}) => report(stackProfileInputSchema.strip().parse(saved), { id, ...over });
    const ticked = [{ id: 'pin-commit', dimension: null, text: 'Check out commit cccccccccccc', done: true }, { id: 'runtime-upgrade-node', dimension: 'runtime', text: 'Move to Node.js >=22.', done: false }];
    const calls = stubApi({
      'GET /api/v1/me/stack-profiles': () => json({ profiles: [saved], limit: 5 }),
      [`POST ${base}/adaptability`]: () => json(stored()),
      [`PUT /api/v1/adaptability/${id}/checklist`]: () => json(stored({ checklist: ticked })),
      [`POST /api/v1/adaptability/${id}/explain`]: () => json(stored({ checklist: ticked, interpretation: { summary: EXPLANATION, highlights: ['MIT license'], risks: ['Upgrade Node'], writtenBy: 'groq/gpt-oss-120b', generatedAt: '2026-10-02T00:00:00.000Z' } })),
      [`POST ${base}/adaptability/alternatives`]: () => json({ basis: { language: 'TypeScript', topics: [] }, filtered: 2, items: [{ similarity: 0.6, reasons: ['MIT fits your license policy'], repo: { fullName: 'other/kit', description: null, language: 'TypeScript', stars: 1200, forks: 1, openIssues: 0, topics: [], license: { spdxId: 'MIT', category: 'permissive', flags: [] }, pushedAt: null, createdAt: null, sizeKb: null, archived: false, htmlUrl: 'https://github.com/other/kit' } }] }),
    }, { signedIn: true });
    renderPanel();
    await screen.findByRole('option', { name: 'Legacy API' });
    await userEvent.selectOptions(screen.getByLabelText('Saved stack'), 'Legacy API');
    expect(screen.getByLabelText('Node.js')).toHaveValue('18');
    expect(screen.getByText('1 of 5 saved')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate against this stack' }));

    const results = await screen.findByRole('region', { name: 'Adaptability results' });
    await userEvent.click(within(results).getByLabelText('Check out commit cccccccccccc'));
    expect(calls.find((c) => c.key.startsWith('PUT'))?.body).toEqual({ done: ['pin-commit'] });
    expect(await within(results).findByLabelText('Check out commit cccccccccccc')).toBeChecked();

    expect(screen.getByRole('link', { name: 'HTML' })).toHaveAttribute('href', expect.stringContaining(`/api/v1/adaptability/${id}/export?format=html`));
    await userEvent.click(screen.getByRole('button', { name: 'Explain these results' }));
    const reading = await screen.findByRole('region', { name: 'AI interpretation' });
    expect(within(reading).getByText(EXPLANATION)).toBeVisible();
    expect(within(reading).getByText(/Written by groq\/gpt-oss-120b/)).toBeVisible();
    expect(within(reading).getByText('Resolve first')).toBeVisible();
    expect(within(results).queryByText(EXPLANATION)).not.toBeInTheDocument();
    // The tick made before explaining is still there.
    expect(within(results).getByLabelText('Check out commit cccccccccccc')).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Find alternatives that fit this stack' }));
    const alternatives = await screen.findByRole('region', { name: 'Alternatives' });
    expect(within(alternatives).getByRole('link', { name: 'other/kit' })).toHaveAttribute('href', 'https://github.com/other/kit');
    expect(within(alternatives).getByText(/2 were left out/)).toBeVisible();
  }); // prettier-ignore
});
