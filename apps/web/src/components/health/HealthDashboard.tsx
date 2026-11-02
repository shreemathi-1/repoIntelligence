import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useAnalysisRun,
  useCancelAnalysis,
  useHealth,
  useHealthHistory,
  useQuota,
  useStartAnalysis,
} from '@/hooks/use-analysis';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { AreaCard } from './AreaCard';
import { HistoryChart } from './HistoryChart';
import { ScoreBadge } from './ScoreBadge';
import { Simulator } from './Simulator';

export function HealthDashboard({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const health = useHealth(fullName);
  const [runId, setRunId] = useState<string | null>(null);
  const run = useAnalysisRun(runId);
  const start = useStartAnalysis(fullName);
  const cancel = useCancelAnalysis();
  const latest = health.data ?? null;
  const score = latest?.score ?? null;
  const history = useHealthHistory(fullName, Boolean(latest));
  const quota = useQuota(Boolean(user));
  const active = run.data && (run.data.status === 'queued' || run.data.status === 'running');
  const [showFormula, setShowFormula] = useState(false);

  const startError =
    start.error instanceof ApiError
      ? start.error.message
      : start.isError
        ? 'Could not start the analysis.'
        : null;
  const counts = score
    ? score.areas
        .flatMap((a) => a.metrics)
        .reduce((acc, m) => ({ ...acc, [m.status]: acc[m.status] + 1 }), {
          measured: 0,
          inferred: 0,
          unavailable: 0,
        })
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Health score
          {score && <ScoreBadge score={score.overall} size="lg" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {health.isPending && (
          <p className="text-muted-foreground">Looking for an existing score…</p>
        )}
        {!health.isPending && !latest && !active && (
          <p className="text-muted-foreground">This repository has not been analysed yet.</p>
        )}

        {score && latest && (
          <div className="space-y-1 text-sm">
            <p>
              {score.status === 'insufficient-data'
                ? 'Not enough could be observed to give an overall number.'
                : `${score.overall}/100 from the commit ${latest.sha?.slice(0, 12) ?? ''}.`}{' '}
              <span className="text-muted-foreground">
                {Math.round(score.confidence * 100)}% of the total weight observed
                {counts &&
                  ` · ${counts.measured} measured, ${counts.inferred} inferred, ${counts.unavailable} unavailable`}
              </span>
            </p>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                setShowFormula((v) => !v);
              }}
            >
              {showFormula ? 'Hide how it is computed' : 'How is it computed?'}
            </Button>
            {showFormula && (
              <div className="text-muted-foreground space-y-1">
                <p>{score.formula}</p>
                <p>
                  Weights:{' '}
                  {Object.entries(score.weights)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(', ')}
                  .
                </p>
              </div>
            )}
          </div>
        )}

        {run.data && (
          <div className="space-y-1 text-sm" aria-live="polite">
            <p>
              <span className="font-medium">{run.data.status}</span> · {run.data.progress.message}
              {run.data.attempt > 1 && ` (attempt ${run.data.attempt})`}
            </p>
            <progress
              className="h-2 w-full"
              value={run.data.progress.percent}
              max={100}
              aria-label="Analysis progress"
            />
            {run.data.error && <p role="alert">{run.data.error}</p>}
            {active && (
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => {
                  cancel.mutate(run.data.id);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {user ? (
            <Button
              size="sm"
              disabled={start.isPending || Boolean(active)}
              onClick={() => {
                start.mutate(latest ? { force: true } : {}, {
                  onSuccess: (started) => {
                    setRunId(started.id);
                  },
                });
              }}
            >
              {latest ? 'Analyse again' : 'Analyse repository'}
            </Button>
          ) : (
            <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Sign in to analyse
            </a>
          )}
          {quota.data && (
            <span className="text-muted-foreground text-xs">
              {quota.data.usedToday}/{quota.data.dailyLimit} analyses used today
            </span>
          )}
        </div>
        {startError && <p role="alert">{startError}</p>}

        {score && (
          <>
            <ul className="grid gap-3 sm:grid-cols-2">
              {score.areas.map((area) => (
                <li key={area.id}>
                  <AreaCard area={area} />
                </li>
              ))}
            </ul>
            <section className="space-y-2" aria-labelledby="history-h">
              <h3 id="history-h" className="font-medium">
                History
              </h3>
              <HistoryChart items={history.data?.items ?? []} />
            </section>
            <Simulator fullName={fullName} score={score} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
