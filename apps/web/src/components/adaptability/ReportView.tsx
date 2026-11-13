import { useState } from 'react';
import type {
  AdaptabilityReport,
  Alternatives,
  Evidence,
  WarningSeverity,
} from '@repointelligence/shared';
import { Database } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { InterpretationBox } from '@/components/evolution/Provenance';
import { Stat } from '@/components/evolution/parts';
import { reportExportUrl, useExplainReport, useSaveChecklist } from '@/hooks/use-adaptability';
import { ApiError } from '@/lib/api-client';
import { evidenceHref } from '@/lib/stack-profile';

const SEVERITY: Record<WarningSeverity, { label: string; variant: 'destructive' | 'outline' | 'secondary' }> = {
  blocker: { label: 'Blocker', variant: 'destructive' },
  major: { label: 'Major', variant: 'destructive' },
  minor: { label: 'Minor', variant: 'outline' },
  info: { label: 'Note', variant: 'secondary' },
}; // prettier-ignore
const VERDICTS = { ready: 'Ready to adopt', adaptable: 'Adaptable with changes', difficult: 'Difficult to adapt', blocked: 'Blocked' }; // prettier-ignore
const SOURCE_NOTE = { graph: 'architecture graph', github: 'GitHub', profile: 'your profile', file: 'file' } as const; // prettier-ignore
const message = (error: unknown) => (error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null); // prettier-ignore

function EvidenceList({ items, fullName, sha }: { items: Evidence[]; fullName: string; sha: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
      {items.map((e, i) => {
        const href = evidenceHref(e, fullName, sha);
        return (
          <li key={`${e.path ?? e.source}-${e.line ?? ''}-${i}`}>
            {href ? (
              <a className="underline" href={href} target="_blank" rel="noreferrer">{e.path}{e.line ? `:${e.line}` : ''}</a>
            ) : (
              <span>From {SOURCE_NOTE[e.source]}</span>
            )}
            : {e.text}
          </li>
        );
      })}
    </ul>
  );
} // prettier-ignore

interface ReportViewProps {
  report: AdaptabilityReport;
  alternatives: Alternatives | undefined;
  onFindAlternatives: () => void;
  findingAlternatives: boolean;
}

/** The evaluation. Everything outside the AI interpretation box was computed by fixed rules. */
export function ReportView({ report: initial, alternatives, onFindAlternatives, findingAlternatives }: ReportViewProps) {
  const explain = useExplainReport();
  const saveChecklist = useSaveChecklist();
  // Explaining and ticking both answer with the updated report, which replaces the one shown.
  const [report, setReport] = useState(initial);
  const { facts, fullName, sha } = report;
  const [localDone, setLocalDone] = useState<string[]>([]);
  const done = report.id ? report.checklist.filter((c) => c.done).map((c) => c.id) : localDone;

  const tick = (id: string) => {
    const next = done.includes(id) ? done.filter((d) => d !== id) : [...done, id];
    if (report.id) saveChecklist.mutate({ id: report.id, done: next }, { onSuccess: setReport });
    else setLocalDone(next);
  };

  return (
    <div className="space-y-5">
      <section aria-label="Adaptability results" className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" data-kind="fact"><Database aria-hidden />Computed by fixed rules from the repository files</Badge>
          <span className="text-muted-foreground text-xs">commit {sha.slice(0, 7)}, stack “{report.profile.name}”</span>
        </div>
        {report.notes.length > 0 && <ul className="text-muted-foreground list-disc pl-5 text-xs">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Stat label="Overall adaptability" value={facts.overall.score === null ? 'not scored' : `${facts.overall.score} / 100`} hint={facts.overall.verdict ? VERDICTS[facts.overall.verdict] : 'Too little could be compared'} />
          <Stat label="Compared" value={`${Math.round(facts.overall.confidence * 100)}%`} hint="of the score's weight" />
          <Stat label="Breaking-change risk" value={facts.breakingRisk.level} />
          <Stat label="Setup complexity" value={facts.setupComplexity.level} />
          <Stat label="Effort estimate" value={`${facts.effort.hours.low}–${facts.effort.hours.high} h`} hint="a range, not a measurement" />
        </div>
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">How is this computed?</summary>
          <p className="mt-1">{facts.overall.formula}</p>
          <ul className="mt-1 list-disc pl-5">{facts.effort.basis.map((b, i) => <li key={`${b.text}-${i}`}>{b.text}: {b.hours.low}–{b.hours.high} h</li>)}</ul>
        </details>

        <div className="space-y-1">
          <p className="text-sm font-medium">Dimensions</p>
          <ul className="divide-y text-sm">
            {facts.dimensions.map((d) => (
              <li key={d.id} className="py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{d.label}</span>
                  <span className="tabular-nums">{d.score === null ? 'not compared' : `${d.score} / 100`}</span>
                </div>
                <p className="text-muted-foreground">{d.summary}</p>
                <EvidenceList items={d.evidence.slice(0, 4)} fullName={fullName} sha={sha} />
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">Warnings ({facts.warnings.length})</p>
          {facts.warnings.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {facts.warnings.map((w) => (
                <li key={w.id} data-warning={w.id}>
                  <Badge variant={SEVERITY[w.severity].variant}>{SEVERITY[w.severity].label}</Badge> {w.message}
                  <EvidenceList items={w.evidence} fullName={fullName} sha={sha} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {facts.breakingRisk.reasons.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Breaking changes to expect</p>
            <ul className="list-disc pl-5 text-sm">{facts.breakingRisk.reasons.map((r) => <li key={r.text}>{r.text}</li>)}</ul>
          </div>
        )}
        {facts.missingInfrastructure.length > 0 && (
          <p className="text-sm"><span className="font-medium">Missing infrastructure:</span> {facts.missingInfrastructure.map((m) => m.label).join(', ')}</p>
        )}

        {facts.modifications.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Required modifications</p>
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs"><tr><th className="font-medium">Change</th><th className="font-medium">Detail</th><th className="font-medium">Effort</th></tr></thead>
              <tbody>{facts.modifications.map((m) => <tr key={m.id} className="align-top"><td className="pr-3">{m.title}</td><td className="text-muted-foreground pr-3">{m.detail}</td><td className="tabular-nums whitespace-nowrap">{m.hours.low}–{m.hours.high} h</td></tr>)}</tbody>
            </table>
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Detected requirements</summary>
          <ul className="mt-1 list-disc pl-5">
            <li>Runtimes: {facts.requirements.runtimes.map((r) => `${r.runtime} ${r.range}${r.pinned ? ' (pinned)' : ''}`).join(', ') || 'none detected'}</li>
            <li>Frameworks: {facts.requirements.frameworks.map((f) => `${f.name}${f.version ? ` ${f.version}` : ''}`).join(', ') || 'none detected'}</li>
            <li>Database: {facts.requirements.database.engines.join(', ') || 'none detected'}{facts.requirements.database.orms.length > 0 && ` via ${facts.requirements.database.orms.join(', ')}`}, {facts.requirements.database.migrations} migrations</li>
            <li>Authentication: {facts.requirements.auth.map((a) => a.label).join(', ') || 'none detected'}</li>
            <li>External services: {facts.requirements.services.map((s) => s.label).join(', ') || 'none detected'}</li>
            <li>License: {facts.requirements.license.spdxId ?? 'none'} ({facts.requirements.license.category})</li>
            <li>Environment variables: {facts.requirements.envVars.map((v) => `${v.name}${v.required ? ' (required)' : ''}`).join(', ') || 'no example file found'}</li>
          </ul>
        </details>

        <div className="space-y-1">
          <p className="text-sm font-medium">Adaptation checklist</p>
          <ul className="space-y-1 text-sm">
            {report.checklist.map((c) => (
              <li key={c.id}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={done.includes(c.id)} onChange={() => { tick(c.id); }} />
                  <span>{c.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {report.id ? (
        <div className="flex flex-wrap items-center gap-2">
          {!report.interpretation && (
            <Button size="sm" variant="outline" disabled={explain.isPending} onClick={() => { if (report.id) explain.mutate(report.id, { onSuccess: setReport }); }}>
              {explain.isPending ? 'Explaining…' : 'Explain these results'}
            </Button>
          )}
          <span className="text-sm">Readiness report:</span>
          {(['markdown', 'html', 'json'] as const).map((f) => (
            <a key={f} className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={reportExportUrl(report.id ?? '', f)}>{f === 'markdown' ? 'Markdown' : f.toUpperCase()}</a>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Sign in to keep this report, export it and get an explanation.</p>
      )}
      {message(explain.error) && <p role="alert" className="text-destructive text-sm">{message(explain.error)}</p>}
      <InterpretationBox interpretation={report.interpretation} note={report.interpretationNote} highlightsLabel="What fits" risksLabel="Resolve first" />

      <section className="space-y-2">
        <Button size="sm" variant="outline" disabled={findingAlternatives} onClick={onFindAlternatives}>
          {findingAlternatives ? 'Searching…' : 'Find alternatives that fit this stack'}
        </Button>
        {alternatives && (
          <div aria-label="Alternatives" role="region" className="space-y-1 text-sm">
            <p className="text-muted-foreground text-xs">
              Similar repositories from GitHub search, kept only when they pass your license and runtime rules. {alternatives.filtered} were left out.
            </p>
            {alternatives.items.length === 0 ? (
              <p>No similar repository passed the rules.</p>
            ) : (
              <ul className="space-y-1">
                {alternatives.items.map((a) => (
                  <li key={a.repo.fullName}>
                    <a className="font-medium underline" href={a.repo.htmlUrl} target="_blank" rel="noreferrer">{a.repo.fullName}</a>
                    <span className="text-muted-foreground"> ★ {a.repo.stars.toLocaleString()}: {a.reasons.join('; ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
} // prettier-ignore
