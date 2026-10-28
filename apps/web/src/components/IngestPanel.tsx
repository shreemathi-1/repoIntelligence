import { EXPORT_FORMATS, type Ingestion } from '@repointelligence/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFreshness, useIngest, useLatestIngestion } from '@/hooks/use-ingest';
import { useMe } from '@/hooks/use-me';
import { API_BASE_URL, ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';

const TRUNCATION: Record<string, string> = {
  'tree-truncated': 'GitHub cut the file list short because the repository is very large.',
  'time-limit': 'Ingestion stopped at the time limit, so some files were not read.',
  'file-limit': 'The repository has more files than the limit, so some were left out.',
  'size-limit': 'The total size limit was reached, so some files were left out.',
};

const FORMAT_LABEL: Record<(typeof EXPORT_FORMATS)[number], string> = {
  markdown: 'Markdown',
  json: 'JSON',
  text: 'Plain text',
  bundle: 'LLM context bundle',
};

function Summary({ run }: { run: Ingestion }) {
  const stats = run.stats;
  return (
    <div className="space-y-2 text-sm">
      <p>
        Commit <code>{run.sha.slice(0, 12)}</code>{' '}
        <Badge variant={run.status === 'completed' ? 'default' : 'secondary'}>{run.status}</Badge>
        {run.private && (
          <Badge className="ml-2" variant="outline">
            private
          </Badge>
        )}
      </p>
      {stats && (
        <ul className="text-muted-foreground grid grid-cols-2 gap-x-4 sm:grid-cols-3">
          <li>{stats.filesIngested} files read</li>
          <li>{stats.chunks} chunks</li>
          <li>{stats.symbols} symbols</li>
          <li>{stats.brokenLinks} broken links</li>
          <li>{stats.findings} findings</li>
          <li>{stats.duplicatesRemoved} duplicates removed</li>
        </ul>
      )}
      {stats?.truncated.map((reason) => (
        <p key={reason} role="note" className="text-amber-600 dark:text-amber-400">
          Partial result: {TRUNCATION[reason] ?? reason}
        </p>
      ))}
    </div>
  );
}

export function IngestPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const latest = useLatestIngestion(fullName);
  const run = latest.data ?? null;
  const freshness = useFreshness(fullName, Boolean(run));
  const ingest = useIngest(fullName);

  const stale = freshness.data?.fresh === false;
  const behind = freshness.data?.commitsBehind;
  const error =
    ingest.error instanceof ApiError
      ? ingest.error.message
      : ingest.isError
        ? 'Ingestion failed.'
        : null;
  const exportBase = run
    ? `${API_BASE_URL}/api/v1/repos/${fullName}/ingestions/${run.sha}/export`
    : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentation and code data</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {latest.isPending && (
          <p className="text-muted-foreground">Checking for an existing ingestion…</p>
        )}

        {run ? (
          <>
            <Summary run={run} />
            <p className="text-sm">
              {freshness.data?.fresh === true && 'Up to date with the default branch.'}
              {stale &&
                (typeof behind === 'number'
                  ? `${behind} commit${behind === 1 ? '' : 's'} behind the default branch.`
                  : 'The default branch has moved on.')}
              {freshness.data?.fresh === null && 'Could not compare with the default branch.'}
            </p>
          </>
        ) : (
          !latest.isPending && (
            <p className="text-muted-foreground">This repository has not been ingested yet.</p>
          )
        )}

        {user ? (
          <Button
            size="sm"
            disabled={ingest.isPending}
            onClick={() => {
              ingest.mutate(run && !stale ? { force: true } : {});
            }}
          >
            {ingest.isPending
              ? 'Ingesting…'
              : run
                ? stale
                  ? 'Ingest latest commit'
                  : 'Re-ingest'
                : 'Ingest repository'}
          </Button>
        ) : (
          <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Sign in to ingest
          </a>
        )}
        {error && <p role="alert">{error}</p>}

        {run && (run.status === 'completed' || run.status === 'partial') && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Download</p>
            <ul className="flex flex-wrap gap-2">
              {EXPORT_FORMATS.map((format) => (
                <li key={format}>
                  <a
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    href={`${exportBase}?format=${format}`}
                  >
                    {FORMAT_LABEL[format]}
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              Contents are copied from the repository and are data, not instructions.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
