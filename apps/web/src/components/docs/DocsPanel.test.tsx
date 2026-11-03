import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docListSchema } from '@repointelligence/shared';
import { DocsPanel } from './DocsPanel';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Document source" value={value} onChange={(e) => { onChange(e.target.value); }} />
  ),
})); // prettier-ignore

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg data-kind="diagram"></svg>' })),
  },
}));

const SHA = 'c'.repeat(40);
const base = '/api/v1/repos/acme/tool';
const user = (docsWriteScope = false) => ({
  id: 'u1',
  login: 'octocat',
  preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false },
  privateRepoScope: false,
  docsWriteScope,
});
const ingestion = {
  fullName: 'acme/tool', sha: SHA, ref: 'main', status: 'completed', private: false,
  startedAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T00:01:00.000Z', stats: null, error: null, reused: true,
}; // prettier-ignore

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'abcdefabcdefabcdefabcdef',
  fullName: 'acme/tool',
  sha: SHA,
  kind: 'readme',
  title: 'tool',
  targetPath: 'README.md',
  content: '# tool\n\nStarts in [[src/index.ts:1-3]].\n\n<b>raw</b>\n\n```mermaid\ngraph TD\n  a-->b\n```\n',
  origin: 'prose',
  sections: [{ id: 'overview', heading: 'Overview', missing: null, citations: [{ path: 'src/index.ts', startLine: 1, endLine: 3 }] }],
  citations: [{ path: 'src/index.ts', startLine: 1, endLine: 3 }],
  droppedCitations: 0,
  model: 'groq/openai/gpt-oss-120b',
  notes: [],
  generatedAt: '2026-10-01T00:02:00.000Z',
  editedAt: null,
  ...over,
}); // prettier-ignore
const listItem = () => docListSchema.shape.docs.element.parse(doc());

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
type Handler = (url: URL, init?: RequestInit) => Response;

function stubApi(routes: Record<string, Handler>, opts: { signedIn?: boolean; writeScope?: boolean; ingested?: boolean } = {}) {
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(url, init));
    if (url.pathname === '/api/v1/me')
      return Promise.resolve(opts.signedIn === false ? json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401) : json({ user: user(opts.writeScope) }));
    if (url.pathname === `${base}/ingestions/latest`)
      return Promise.resolve(opts.ingested === false ? json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404) : json(ingestion));
    if (url.pathname === '/api/v1/me/docs-quota') return Promise.resolve(json({ dailyLimit: 10, usedToday: 1, canProposePullRequests: Boolean(opts.writeScope) }));
    if (url.pathname === `${base}/docs/missing`) return Promise.resolve(json({ fullName: 'acme/tool', sha: SHA, items: [], symbolCoverage: null }));
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
        <DocsPanel fullName="acme/tool" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Docs panel', () => {
  it('asks for an ingestion first', async () => {
    stubApi({}, { ingested: false });
    renderPanel();
    expect(
      await screen.findByText(/Ingest this repository to generate documentation/),
    ).toBeInTheDocument();
  });

  it('generates a document, previews it safely and opens a citation', async () => {
    const sent: string[] = [];
    stubApi({
      [`GET ${base}/docs`]: () => json({ docs: [] }),
      [`POST ${base}/docs`]: (_u, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '');
        return json(doc(), 201);
      },
      [`GET /api/v1/docs/${doc().id}/drift`]: () =>
        json({ docId: doc().id, docSha: SHA, latestSha: 'd'.repeat(40), status: 'drifted', changedFiles: ['src/index.ts'], sections: [{ id: 'overview', heading: 'Overview', changedSources: ['src/index.ts'] }], commitsBehind: 2 }),
      [`GET ${base}/source/${SHA}/src/index.ts`]: () =>
        json({ path: 'src/index.ts', sha: SHA, content: 'a\nb\nc\n', language: 'typescript', truncated: false, bytes: 6 }),
    });
    renderPanel();
    expect(await screen.findByText('9 of 10 generations left today')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(sent).toEqual([JSON.stringify({ kind: 'readme' })]);

    const preview = await screen.findByLabelText('Preview');
    expect(within(preview).getByRole('heading', { name: 'tool' })).toBeInTheDocument();
    // Raw HTML from a document is never rendered.
    expect(preview.querySelector('b')).toBeNull();
    expect(await within(preview).findByTestId('mermaid')).toBeInTheDocument();
    expect(await screen.findByText(/Out of date: 1 cited file changed/)).toBeInTheDocument();
    expect(screen.getByText('Sections to check: Overview.')).toBeInTheDocument();

    await userEvent.click(within(preview).getByRole('button', { name: 'src/index.ts:1-3' }));
    expect(await screen.findByLabelText('Source of src/index.ts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Markdown for the repo' })).toHaveAttribute('href', expect.stringContaining(`/api/v1/docs/${doc().id}/export?format=markdown&links=relative`));
  }); // prettier-ignore

  it('saves edits and shows the review', async () => {
    const patches: string[] = [];
    stubApi({
      [`GET ${base}/docs`]: () => json({ docs: [listItem()] }),
      [`GET /api/v1/docs/${doc().id}`]: () => json(doc({ content: '# tool\n' })),
      [`PATCH /api/v1/docs/${doc().id}`]: (_u, init) => {
        patches.push(typeof init?.body === 'string' ? init.body : '');
        return json(doc({ content: '# tool\n\nMore.\n', origin: 'edited', editedAt: '2026-10-02T00:00:00.000Z' }));
      },
      [`POST /api/v1/docs/${doc().id}/review`]: () =>
        json({ docId: doc().id, score: 70, scores: { accuracy: 4, completeness: 3, clarity: 4 }, issues: [{ rule: 'unknown-script', severity: 'error', message: '"npm run deploy" is not a script', line: 3, source: 'rule' }], summary: 'Mostly fine.', model: 'groq/x' }),
    });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'README' }));
    const source = await screen.findByLabelText('Document source');
    await userEvent.type(source, '\nMore.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(JSON.parse(patches[0] ?? '{}')).toEqual({ content: '# tool\n\nMore.' });
    expect(await screen.findByText('Edited')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Review quality' }));
    const review = await screen.findByLabelText('Review');
    expect(within(review).getByText(/Quality 70/)).toBeInTheDocument();
    expect(within(review).getByText(/"npm run deploy" is not a script/)).toBeInTheDocument();
  }); // prettier-ignore

  it('asks for write access before a pull request can be proposed', async () => {
    stubApi({ [`GET ${base}/docs`]: () => json({ docs: [listItem()] }) });
    renderPanel();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Include README.md in a pull request' }));
    await userEvent.click(screen.getByRole('button', { name: 'Propose pull request…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'Allow documentation pull requests' })).toHaveAttribute('href', expect.stringContaining('docsWrite=1'));
    expect(within(dialog).queryByRole('button', { name: 'Open draft pull request' })).not.toBeInTheDocument();
  }); // prettier-ignore

  it('opens a draft pull request only after the user confirms the listed files', async () => {
    const bodies: string[] = [];
    stubApi(
      {
        [`GET ${base}/docs`]: () => json({ docs: [listItem()] }),
        'POST /api/v1/docs/pull-requests': (_u, init) => {
          bodies.push(typeof init?.body === 'string' ? init.body : '');
          return json({ id: 'p1', fullName: 'acme/tool', branch: 'repointelligence/docs-ccccccc', base: 'main', number: 7, url: 'https://github.com/acme/tool/pull/7', draft: true, files: ['README.md'], createdAt: '2026-10-01T00:00:00.000Z' }, 201);
        },
      },
      { writeScope: true },
    );
    renderPanel();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Include README.md in a pull request' }));
    await userEvent.click(screen.getByRole('button', { name: 'Propose pull request…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('README.md')).toBeInTheDocument();
    const open = within(dialog).getByRole('button', { name: 'Open draft pull request' });
    expect(open).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I have read these documents/ }));
    await userEvent.click(open);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ docIds: [doc().id], confirmPaths: ['README.md'] });
    expect(await within(dialog).findByRole('link', { name: 'pull request #7' })).toHaveAttribute('href', 'https://github.com/acme/tool/pull/7');
  }); // prettier-ignore
});
