import { useState } from 'react';
import type { ChatSession, Citation, Confidence } from '@repointelligence/shared';
import { Link } from 'react-router-dom';
import { SourceViewer } from '@/components/graph/SourceViewer';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  exportUrl,
  useAsk,
  useBuildIndex,
  useChatStatus,
  useCreateSession,
  useSuggestions,
} from '@/hooks/use-chat';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { AnswerText } from './Answer';

const CONFIDENCE: Record<Confidence, { label: string; hint: string }> = {
  verified: { label: 'Cited', hint: 'Every citation points at lines that exist at this commit.' },
  inferred: {
    label: 'Partly supported',
    hint: 'Some statements could not be tied to the retrieved lines.',
  },
  insufficient: {
    label: 'No evidence',
    hint: 'Nothing in the repository supported an answer.',
  },
};

function errorText(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong.';
}

export function ChatPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const status = useChatStatus(fullName);
  const sha = status.data?.sha ?? null;
  const canAsk = Boolean(user && sha && status.data?.llm.available);
  const suggestions = useSuggestions(fullName, canAsk);
  const create = useCreateSession(fullName);
  const ask = useAsk();
  const index = useBuildIndex(fullName);

  const [session, setSession] = useState<ChatSession | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [cited, setCited] = useState<Citation | null>(null);

  const busy = create.isPending || ask.isPending;
  const failure = errorText(create.error ?? ask.error);
  const optInNeeded =
    (create.error instanceof ApiError && create.error.code === 'PRIVATE_LLM_OPT_IN') ||
    (suggestions.error instanceof ApiError && suggestions.error.code === 'PRIVATE_LLM_OPT_IN');

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const current = session ?? (await create.mutateAsync().catch(() => null));
    if (!current) return;
    setSession(current);
    const result = await ask
      .mutateAsync({ sessionId: current.id, question: trimmed })
      .catch(() => null);
    if (!result) return;
    setSession(result.session);
    setFollowUps(result.suggestions);
    setQuestion('');
  };

  const embedding = status.data?.embedding;
  const searchLabel =
    embedding?.status === 'ready'
      ? 'Search: keywords and meaning'
      : embedding && (embedding.status === 'queued' || embedding.status === 'running')
        ? `Building the meaning index (${embedding.embedded} of ${status.data?.chunks ?? 0})…`
        : 'Search: keywords only';

  const prompts = session?.messages.length ? followUps : (suggestions.data?.questions ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask about this repository</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isPending && <p className="text-muted-foreground text-sm">Checking chat…</p>}
        {status.data && !sha && (
          <p className="text-muted-foreground text-sm">
            Ingest this repository first; answers are drawn from the ingested files.
          </p>
        )}
        {status.data && sha && !status.data.llm.available && (
          <p className="text-muted-foreground text-sm">{status.data.llm.reason}</p>
        )}
        {status.data && sha && !user && (
          <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Sign in to ask questions
          </a>
        )}

        {canAsk && (
          <>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <span>
                Answers come from commit <code>{(session?.sha ?? sha ?? '').slice(0, 12)}</code>
              </span>
              <span aria-hidden>·</span>
              <span>{searchLabel}</span>
              {embedding && (embedding.status === 'none' || embedding.status === 'failed') && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={index.isPending}
                  onClick={() => {
                    index.mutate();
                  }}
                >
                  Build meaning index
                </Button>
              )}
              {session && session.messages.length > 0 && (
                <a
                  className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                  href={exportUrl(session.id)}
                >
                  Export Markdown
                </a>
              )}
            </div>

            {session && session.messages.length > 0 && (
              <ol className="space-y-3" aria-label="Conversation">
                {session.messages.map((message, i) => (
                  <li
                    key={`${message.createdAt}-${i}`}
                    className={
                      message.role === 'user'
                        ? 'bg-muted rounded-md px-3 py-2 text-sm font-medium'
                        : 'space-y-1 rounded-md border px-3 py-2'
                    }
                  >
                    {message.role === 'user' ? (
                      message.content
                    ) : (
                      <>
                        <AnswerText content={message.content} onCite={setCited} />
                        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                          {message.confidence && (
                            <Badge
                              variant={message.confidence === 'verified' ? 'default' : 'secondary'}
                              title={CONFIDENCE[message.confidence].hint}
                            >
                              {CONFIDENCE[message.confidence].label}
                            </Badge>
                          )}
                          {message.model && <span>{message.model}</span>}
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {cited && (
              <SourceViewer
                fullName={fullName}
                sha={session?.sha ?? sha ?? ''}
                path={cited.path}
                line={cited.startLine}
                onClose={() => {
                  setCited(null);
                }}
              />
            )}

            {prompts.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Suggested questions">
                {prompts.map((prompt) => (
                  <li key={prompt}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        void send(prompt);
                      }}
                    >
                      {prompt}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void send(question);
              }}
            >
              <label className="sr-only" htmlFor="chat-question">
                Question
              </label>
              <textarea
                id="chat-question"
                className="border-input bg-background min-h-16 flex-1 rounded-md border px-3 py-2 text-sm"
                maxLength={2000}
                placeholder="How is a request authenticated? Where is the database configured?"
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                }}
              />
              <Button type="submit" disabled={busy || question.trim() === ''}>
                {busy ? 'Thinking…' : 'Ask'}
              </Button>
            </form>
          </>
        )}

        {optInNeeded ? (
          <p role="alert" className="text-sm">
            This repository is private. Turn on chat for private repositories in{' '}
            <Link className="underline" to="/settings">
              Settings
            </Link>{' '}
            first.
          </p>
        ) : (
          failure && (
            <p role="alert" className="text-destructive text-sm">
              {failure}
            </p>
          )
        )}
        <p className="text-muted-foreground text-xs">
          Answers quote the repository as data and can be wrong. Citations are checked against the
          files; the prose is not.
        </p>
      </CardContent>
    </Card>
  );
}
