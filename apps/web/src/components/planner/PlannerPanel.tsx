import { useState } from 'react';
import type { ImplementationPlan } from '@repointelligence/shared';
import { Database, Sparkles } from 'lucide-react';
import { Stat } from '@/components/evolution/parts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLatestIngestion } from '@/hooks/use-ingest';
import { useMe } from '@/hooks/use-me';
import {
  planExportUrl,
  useCreatePlan,
  useDeletePlan,
  usePlan,
  usePlans,
  useSavePlanProgress,
} from '@/hooks/use-planner';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { FileLink } from './FileLink';

const RISK = { low: 'outline', medium: 'secondary', high: 'destructive' } as const;
const message = (error: unknown) =>
  error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

function PlanView({ plan, onTick }: { plan: ImplementationPlan; onTick: (done: string[]) => void }) {
  const { fullName, sha } = plan;
  const done = plan.tasks.filter((t) => t.done).map((t) => t.id);
  const orderOf = (id: string) => plan.tasks.find((t) => t.id === id)?.order;
  const removed = plan.dropped.tasks + plan.dropped.files;
  return (
    <section aria-label="Implementation plan" className="space-y-4 text-sm">
      <div className="space-y-1">
        <h3 className="font-medium">{plan.goal}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {plan.origin === 'model' ? (
            <Badge variant="secondary" data-kind="interpretation"><Sparkles aria-hidden />Tasks proposed by {plan.writtenBy ?? 'a model'}</Badge>
          ) : (
            <Badge variant="outline">Files only: no model wrote tasks</Badge>
          )}
          <Badge variant="outline" data-kind="fact"><Database aria-hidden />Paths, order, tests, effort and risk checked against commit {sha.slice(0, 7)}</Badge>
        </div>
        {removed > 0 && <p className="text-muted-foreground text-xs">{plan.dropped.tasks} proposed tasks and {plan.dropped.files} proposed files were removed because they did not match the repository.</p>}
        {plan.notes.length > 0 && <ul className="text-muted-foreground list-disc pl-5 text-xs">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Stat label="Progress" value={`${plan.progress.done} of ${plan.progress.total}`} />
        <Stat label="Files" value={String(plan.totals.files)} />
        <Stat label="Effort estimate" value={`${plan.totals.effort.low}–${plan.totals.effort.high} h`} hint="a range, not a measurement" />
        <Stat label="Overall risk" value={plan.totals.risk} />
      </div>

      {plan.tasks.length === 0 ? (
        <p className="text-muted-foreground">Nothing in the ingested files matched this goal.</p>
      ) : (
        <ol className="space-y-3">
          {plan.tasks.map((t) => (
            <li key={t.id} className="rounded-lg border p-3">
              <label className="flex items-start gap-2 font-medium">
                <input type="checkbox" className="mt-1" checked={t.done} onChange={() => { onTick(t.done ? done.filter((d) => d !== t.id) : [...done, t.id]); }} />
                <span>{t.order}. {t.title}</span>
              </label>
              {t.description && <p className="mt-1">{t.description}</p>}
              <ul className="mt-2 space-y-0.5">
                {t.files.map((f) => (
                  <li key={f.path}>
                    {f.change === 'create' ? <><Badge variant="outline">New file</Badge> <code className="text-xs">{f.path}</code></> : <FileLink fullName={fullName} sha={sha} path={f.path} />}
                    {f.reason && <span className="text-muted-foreground"> {f.reason}</span>}
                  </li>
                ))}
              </ul>
              <dl className="text-muted-foreground mt-2 space-y-0.5 text-xs">
                {t.dependsOn.length > 0 && <div><dt className="inline font-medium">After: </dt><dd className="inline">{t.dependsOn.map((id) => `task ${orderOf(id) ?? '?'}`).join(', ')}</dd></div>}
                {t.api.length > 0 && <div><dt className="inline font-medium">API: </dt><dd className="inline">{t.api.map((a) => `${a.change === 'new' ? 'add' : 'change'} ${a.method} ${a.route}`).join('; ')}</dd></div>}
                {t.database.length > 0 && <div><dt className="inline font-medium">Database: </dt><dd className="inline">{t.database.map((d) => `${d.change === 'new' ? 'add' : 'change'} model ${d.model}`).join('; ')}</dd></div>}
                {t.tests.length > 0 && <div><dt className="inline font-medium">Tests: </dt><dd className="inline">{t.tests.map((x) => `${x.path}${x.exists ? '' : ' (new)'}`).join('; ')}</dd></div>}
                <div>
                  <dt className="inline font-medium">Effort: </dt><dd className="inline">{t.effort.low}–{t.effort.high} h. </dd>
                  <dt className="inline font-medium">Risk: </dt><dd className="inline"><Badge variant={RISK[t.risk.level]}>{t.risk.level}</Badge> {t.risk.reasons.join('; ')}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span>Export:</span>
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={planExportUrl(plan.id, 'markdown')}>Markdown</a>
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={planExportUrl(plan.id, 'issue')}>Issue checklist</a>
      </div>
    </section>
  );
} // prettier-ignore

export function PlannerPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const ingestion = useLatestIngestion(fullName);
  const ready = Boolean(ingestion.data);
  const plans = usePlans(fullName, Boolean(user) && ready);
  const create = useCreatePlan(fullName);
  const progress = useSavePlanProgress(fullName);
  const remove = useDeletePlan(fullName);
  const [goal, setGoal] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const open = usePlan(openId);
  const tooShort = goal.trim().length < 10;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan a feature</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ingestion.isPending && !ready && <p className="text-muted-foreground text-sm">Ingest this repository to plan changes against its real files.</p>}
        {ready && !user && <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Sign in to plan a feature</a>}
        {ready && user && (
          <>
            <div className="space-y-2">
              <label htmlFor="plan-goal" className="text-sm font-medium">What do you want to build or change?</label>
              <textarea id="plan-goal" className="border-input bg-background min-h-16 w-full rounded-md border p-2 text-sm" maxLength={1000} placeholder="Add CSV export to the orders list" value={goal} onChange={(e) => { setGoal(e.target.value); }} />
              <Button size="sm" disabled={tooShort || create.isPending} onClick={() => { create.mutate(goal.trim(), { onSuccess: (plan) => { setOpenId(plan.id); setGoal(''); } }); }}>
                {create.isPending ? 'Planning…' : 'Create plan'}
              </Button>
            </div>
            {(message(create.error) ?? message(progress.error) ?? message(remove.error)) && (
              <p role="alert" className="text-destructive text-sm">{message(create.error) ?? message(progress.error) ?? message(remove.error)}</p>
            )}
            {plans.data && plans.data.plans.length > 0 && (
              <div className="space-y-1 text-sm">
                <p className="font-medium">Your plans ({plans.data.plans.length} of {plans.data.limit})</p>
                <ul className="space-y-1">
                  {plans.data.plans.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <button type="button" className="text-left underline" aria-current={openId === p.id} onClick={() => { setOpenId(p.id); }}>{p.goal}</button>
                      <span className="text-muted-foreground text-xs">{p.progress.done} of {p.progress.total} done, commit {p.sha.slice(0, 7)}</span>
                      <Button size="sm" variant="ghost" aria-label={`Delete plan: ${p.goal}`} disabled={remove.isPending} onClick={() => { remove.mutate(p.id, { onSuccess: () => { if (openId === p.id) setOpenId(null); } }); }}>Delete</Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {open.data && <PlanView plan={open.data} onTick={(done) => { progress.mutate({ id: open.data.id, done }); }} />}
          </>
        )}
      </CardContent>
    </Card>
  );
} // prettier-ignore
