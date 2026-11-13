import { useState } from 'react';
import type { FileRef, LearningMode, Onboarding } from '@repointelligence/shared';
import { Database } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLatestIngestion } from '@/hooks/use-ingest';
import { useMe } from '@/hooks/use-me';
import { useOnboarding, useSaveOnboardingProgress, useStarterIssues } from '@/hooks/use-planner';
import { ApiError } from '@/lib/api-client';
import { FileLink } from './FileLink';

const MODES: { id: LearningMode; label: string }[] = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'advanced', label: 'Advanced' },
];
const KIND_LABELS = {
  runtime: 'Runtime',
  tool: 'Tool',
  service: 'Service',
  knowledge: 'Knowledge',
};
const STARTER_LABELS = {
  'missing-tests': 'Tests',
  undocumented: 'Docs',
  todo: 'TODO',
  docs: 'Docs',
};

function Guide({ data, fullName }: { data: Onboarding; fullName: string }) {
  const { sha } = data;
  const source = (ref: FileRef | null) => ref && <FileLink fullName={fullName} sha={sha} path={ref.path} line={ref.line} />;
  return (
    <div className="space-y-5 text-sm">
      <section aria-label="Walkthrough" className="space-y-2">
        <h3 className="font-medium">Walkthrough</h3>
        {data.walkthrough.summary.map((s) => <p key={s}>{s}</p>)}
        {data.walkthrough.layout.length > 0 && (
          <table className="w-full text-left">
            <thead className="text-muted-foreground text-xs"><tr><th className="font-medium">Module</th><th className="font-medium">Files</th><th className="font-medium">What lives there</th></tr></thead>
            <tbody>{data.walkthrough.layout.map((l) => <tr key={l.path}><td className="font-mono text-xs">{l.path}</td><td className="tabular-nums">{l.files}</td><td>{l.role}</td></tr>)}</tbody>
          </table>
        )}
        {data.walkthrough.entryPoints.length > 0 && (
          <p>Execution starts in {data.walkthrough.entryPoints.map((e, i) => <span key={e.path}>{i > 0 && ', '}<FileLink fullName={fullName} sha={sha} path={e.path} line={e.line} /></span>)}.</p>
        )}
        {data.walkthrough.flows.length > 0 && (
          <ul className="list-disc pl-5">
            {data.walkthrough.flows.map((f) => <li key={`${f.title}-${f.path}`}><code>{f.title}</code> is defined in <FileLink fullName={fullName} sha={sha} path={f.path} line={f.line} /></li>)}
          </ul>
        )}
      </section>

      <section aria-label="Prerequisites" className="space-y-1">
        <h3 className="font-medium">Before you start</h3>
        {data.prerequisites.length === 0 ? <p className="text-muted-foreground">No prerequisites were detected.</p> : (
          <ul className="space-y-1">
            {data.prerequisites.map((p) => (
              <li key={p.id}><Badge variant="outline">{KIND_LABELS[p.kind]}</Badge> <span className="font-medium">{p.label}</span> <span className="text-muted-foreground">{p.detail}</span> {source(p.source)}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Install steps" className="space-y-1">
        <h3 className="font-medium">Install and run</h3>
        {data.install.length === 0 ? <p className="text-muted-foreground">No install commands could be derived from the files.</p> : (
          <ol className="list-decimal space-y-1 pl-5">
            {data.install.map((s) => <li key={s.id}><code className="bg-muted rounded px-1">{s.command}</code> <span className="text-muted-foreground">{s.why}</span> {source(s.source)}</li>)}
          </ol>
        )}
      </section>

      {data.troubleshooting.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">If the first run fails ({data.troubleshooting.length})</summary>
          <ul className="mt-1 space-y-1">
            {data.troubleshooting.map((t) => <li key={t.id}><span className="font-medium">{t.symptom}</span> {t.fix} {source(t.source)}</li>)}
          </ul>
        </details>
      )}

      <section aria-label="Reading list" className="space-y-1">
        <h3 className="font-medium">Read these first</h3>
        <ol className="list-decimal space-y-1 pl-5">
          {data.readingList.map((r) => <li key={r.path}><FileLink fullName={fullName} sha={sha} path={r.path} line={r.line} /> <span className="text-muted-foreground">{r.reason}</span></li>)}
        </ol>
      </section>

      <section aria-label="Learning roadmap" className="space-y-1">
        <h3 className="font-medium">Learning roadmap</h3>
        <p className="text-muted-foreground text-xs">Sized for a {data.roadmap.complexity} repository: {data.roadmap.basis}.</p>
        <ol className="list-decimal space-y-1 pl-5">
          {data.roadmap.stages.map((s) => (
            <li key={s.id}>
              <span className="font-medium">{s.title}.</span> {s.goal}{' '}
              {s.files.map((f) => <span key={f} className="mr-2"><FileLink fullName={fullName} sha={sha} path={f} /></span>)}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
} // prettier-ignore

function Starters({ fullName, enabled }: { fullName: string; enabled: boolean }) {
  const { data } = useStarterIssues(fullName, enabled);
  if (!data || (data.github.length === 0 && data.candidates.length === 0)) return null;
  return (
    <section aria-label="Starter issues" className="space-y-1 text-sm">
      <h3 className="font-medium">Good first changes</h3>
      <ul className="space-y-1">
        {data.github.map((i) => <li key={i.number}><Badge variant="secondary">Open issue</Badge> <a className="underline" href={i.htmlUrl} target="_blank" rel="noreferrer">#{i.number} {i.title}</a></li>)}
        {data.candidates.map((c) => <li key={c.id}><Badge variant="outline">{STARTER_LABELS[c.kind]}</Badge> {c.title} <span className="text-muted-foreground">{c.detail}</span> <FileLink fullName={fullName} sha={data.sha} path={c.path} line={c.line} /></li>)}
      </ul>
    </section>
  );
} // prettier-ignore

export function OnboardingPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const ingestion = useLatestIngestion(fullName);
  const ready = Boolean(ingestion.data);
  const [mode, setMode] = useState<LearningMode>('beginner');
  const onboarding = useOnboarding(fullName, mode, ready);
  const save = useSaveOnboardingProgress(fullName);
  // Ticks show at once; for a signed-in user they are also stored.
  const [ticked, setTicked] = useState<string[] | null>(null);
  const data = onboarding.data;
  const done = ticked ?? data?.checklist.filter((c) => c.done).map((c) => c.id) ?? [];

  const tick = (id: string) => {
    const next = done.includes(id) ? done.filter((d) => d !== id) : [...done, id];
    setTicked(next);
    if (user) save.mutate(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Get started</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ingestion.isPending && !ready ? (
          <p className="text-muted-foreground text-sm">Ingest this repository to build a walkthrough from its files.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Learning mode" className="flex gap-1">
                {MODES.map((m) => (
                  <Button key={m.id} size="sm" aria-pressed={mode === m.id} variant={mode === m.id ? 'secondary' : 'ghost'} onClick={() => { setMode(m.id); }}>{m.label}</Button>
                ))}
              </div>
              <Badge variant="outline" data-kind="fact"><Database aria-hidden />Built from the repository files</Badge>
            </div>
            {onboarding.isPending && <p className="text-muted-foreground text-sm">Loading…</p>}
            {onboarding.error && <p role="alert" className="text-destructive text-sm">{onboarding.error instanceof ApiError ? onboarding.error.message : 'Something went wrong.'}</p>}
            {data && (
              <>
                {data.notes.length > 0 && <ul className="text-muted-foreground list-disc pl-5 text-xs">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                <Guide data={data} fullName={fullName} />
                <Starters fullName={fullName} enabled={ready} />
                <section aria-label="Progress" className="space-y-1 text-sm">
                  <h3 className="font-medium">Your progress: {data.checklist.filter((c) => done.includes(c.id)).length} of {data.checklist.length}</h3>
                  {!user && <p className="text-muted-foreground text-xs">Sign in to keep your progress between visits.</p>}
                  <ul className="space-y-1">
                    {data.checklist.map((c) => (
                      <li key={c.id}>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" className="mt-1" checked={done.includes(c.id)} onChange={() => { tick(c.id); }} />
                          <span>{c.text}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
} // prettier-ignore
