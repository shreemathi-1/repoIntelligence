import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre>,
}));

const SHA = 'b'.repeat(40);
const base = '/api/v1/repos/acme/tool';
const user = {
  id: 'u1',
  login: 'octocat',
  preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false },
  privateRepoScope: false,
  docsWriteScope: false,
};

const status = (over: Record<string, unknown> = {}) => ({
  fullName: 'acme/tool',
  sha: SHA,
  private: false,
  chunks: 12,
  embedding: { status: 'ready', embedded: 12, model: 'bge', error: null },
  llm: { available: true, providers: ['gemini'], reason: null },
  vectorSearch: false,
  ...over,
});

const session = (messages: unknown[] = []) => ({
  id: 'abcdefabcdefabcdefabcdef',
  fullName: 'acme/tool',
  sha: SHA,
  title: messages.length ? 'How do I run it?' : null,
  messages,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const answer = {
  role: 'assistant',
  content: 'Run `npm start` [[README.md:3-4]] after copying the env file.',
  citations: [{ path: 'README.md', startLine: 3, endLine: 4 }],
  confidence: 'verified',
  model: 'gemini/gemini-2.5-flash',
  createdAt: '2026-10-01T00:00:01.000Z',
};
const question = {
  role: 'user',
  content: 'How do I run it?',
  citations: [],
  confidence: null,
  model: null,
  createdAt: '2026-10-01T00:00:01.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
type Handler = (url: URL, init?: RequestInit) => Response;

function stubApi(routes: Record<string, Handler>, signedIn = true) {
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(url, init));
    if (url.pathname === '/api/v1/me')
      return Promise.resolve(
        signedIn
          ? json({ user })
          : json({ error: { code: 'UNAUTHORIZED', message: 'Sign in' } }, 401),
      );
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChatPanel fullName="acme/tool" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Chat panel', () => {
  it('asks for an ingestion first', async () => {
    stubApi({ [`GET ${base}/chat/status`]: () => json(status({ sha: null, chunks: 0 })) });
    renderPanel();
    expect(await screen.findByText(/Ingest this repository first/)).toBeInTheDocument();
  });

  it('explains why chat is unavailable and asks anonymous visitors to sign in', async () => {
    stubApi(
      {
        [`GET ${base}/chat/status`]: () =>
          json(
            status({
              llm: { available: false, providers: [], reason: 'No model provider is configured' },
            }),
          ),
      },
      false,
    );
    renderPanel();
    expect(await screen.findByText('No model provider is configured')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to ask questions' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('asks a suggested question, shows the cited answer and opens the cited lines', async () => {
    const asked: string[] = [];
    stubApi({
      [`GET ${base}/chat/status`]: () => json(status()),
      [`GET ${base}/chat/suggestions`]: () =>
        json({ questions: ['How do I run it?'], source: 'static' }),
      [`POST ${base}/chat/sessions`]: () => json(session(), 201),
      [`POST /api/v1/chat/sessions/${session().id}/messages`]: (_url, init) => {
        asked.push(typeof init?.body === 'string' ? init.body : '');
        return json({
          session: session([question, answer]),
          answer,
          retrieved: 3,
          suggestions: ['Explain README.md lines 3-4 line by line'],
        });
      },
      [`GET ${base}/source/${SHA}/README.md`]: () =>
        json({
          path: 'README.md',
          sha: SHA,
          content: '# Tool\n\nnpm start\n',
          language: 'markdown',
          truncated: false,
          bytes: 18,
        }),
    });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'How do I run it?' }));

    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(within(conversation).getByText('Cited')).toBeInTheDocument();
    expect(within(conversation).getByText('gemini/gemini-2.5-flash')).toBeInTheDocument();
    expect(asked).toEqual([JSON.stringify({ question: 'How do I run it?' })]);
    expect(screen.getByText(/Search: keywords and meaning/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export Markdown' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/api/v1/chat/sessions/${session().id}/export.md`),
    );
    // Follow-up suggestions replace the opening ones.
    expect(
      screen.getByRole('button', { name: 'Explain README.md lines 3-4 line by line' }),
    ).toBeInTheDocument();

    await userEvent.click(within(conversation).getByRole('button', { name: 'README.md:3-4' }));
    expect(await screen.findByLabelText('Source of README.md')).toBeInTheDocument();
  });

  it('does not render HTML from an answer', async () => {
    const hostile = { ...answer, content: '<img src=x onerror=alert(1)> done', citations: [] };
    stubApi({
      [`GET ${base}/chat/status`]: () => json(status()),
      [`GET ${base}/chat/suggestions`]: () => json({ questions: [], source: 'static' }),
      [`POST ${base}/chat/sessions`]: () => json(session(), 201),
      [`POST /api/v1/chat/sessions/${session().id}/messages`]: () =>
        json({
          session: session([question, hostile]),
          answer: hostile,
          retrieved: 1,
          suggestions: [],
        }),
    });
    renderPanel();
    await userEvent.type(await screen.findByRole('textbox'), 'Hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)> done/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('points to Settings when a private repository needs the opt-in', async () => {
    stubApi({
      [`GET ${base}/chat/status`]: () => json(status({ private: true })),
      [`GET ${base}/chat/suggestions`]: () =>
        json({ error: { code: 'PRIVATE_LLM_OPT_IN', message: 'off' } }, 403),
      [`POST ${base}/chat/sessions`]: () =>
        json({ error: { code: 'PRIVATE_LLM_OPT_IN', message: 'off' } }, 403),
    });
    renderPanel();
    await userEvent.type(await screen.findByRole('textbox'), 'What is this?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('offers to build the meaning index when there is none', async () => {
    const fn = stubApi({
      [`GET ${base}/chat/status`]: () =>
        json(status({ embedding: { status: 'none', embedded: 0, model: null, error: null } })),
      [`GET ${base}/chat/suggestions`]: () => json({ questions: [], source: 'static' }),
      [`POST ${base}/chat/index`]: () =>
        json(
          status({ embedding: { status: 'queued', embedded: 0, model: null, error: null } }),
          202,
        ),
    });
    renderPanel();
    expect(await screen.findByText('Search: keywords only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Build meaning index' }));
    expect(await screen.findByText(/Building the meaning index \(0 of 12\)/)).toBeInTheDocument();
    expect(fn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
  });
});
