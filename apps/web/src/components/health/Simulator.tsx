import { SEVERITIES, type HealthScore, type SimulateRequest } from '@repointelligence/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useSimulate } from '@/hooks/use-analysis';
import { ScoreBadge } from './ScoreBadge';

const FILES: SimulateRequest['addFiles'] = [
  'CONTRIBUTING',
  'CODE_OF_CONDUCT',
  'SECURITY',
  'CHANGELOG',
  'LICENSE',
  'ci',
  'tests',
];
const FILE_LABEL: Record<SimulateRequest['addFiles'][number], string> = {
  CONTRIBUTING: 'Add a contributing guide',
  CODE_OF_CONDUCT: 'Add a code of conduct',
  SECURITY: 'Add a security policy',
  CHANGELOG: 'Add a changelog',
  LICENSE: 'Add a license',
  ci: 'Add a CI workflow',
  tests: 'Add tests (30% of source files)',
};

export function Simulator({ fullName, score }: { fullName: string; score: HealthScore }) {
  const [severities, setSeverities] = useState<Set<SimulateRequest['resolveSeverities'][number]>>(
    new Set(),
  );
  const [files, setFiles] = useState<Set<SimulateRequest['addFiles'][number]>>(new Set());
  const [rules, setRules] = useState<Set<string>>(new Set());
  const simulate = useSimulate(fullName);

  const ruleOptions = [...new Map(score.findings.map((f) => [`${f.tool}|${f.rule}`, f])).values()]
    .map((f) => ({
      key: `${f.tool}|${f.rule}`,
      label: `${f.tool}: ${f.rule}`,
      count: score.findings.filter((x) => x.tool === f.tool && x.rule === f.rule).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void): void => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const run = (): void => {
    simulate.mutate({
      resolveSeverities: [...severities],
      addFiles: [...files],
      resolveRules: [...rules].map((key) => {
        const [tool = '', rule = ''] = key.split('|');
        return { tool: tool as SimulateRequest['resolveRules'][number]['tool'], rule };
      }),
    });
  };

  const result = simulate.data;
  return (
    <section className="space-y-3" aria-labelledby="simulator-h">
      <h3 id="simulator-h" className="font-medium">
        What if…
      </h3>
      <p className="text-muted-foreground text-sm">
        Pick findings to resolve or files to add. The same formula is applied to the edited inputs,
        so this is an estimate.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Resolve by severity</legend>
          {SEVERITIES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={severities.has(s)}
                onChange={() => {
                  toggle(severities, s, setSeverities);
                }}
              />{' '}
              {s}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Resolve by rule</legend>
          {ruleOptions.length === 0 && (
            <p className="text-muted-foreground">No findings to resolve.</p>
          )}
          {ruleOptions.map((r) => (
            <label key={r.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rules.has(r.key)}
                onChange={() => {
                  toggle(rules, r.key, setRules);
                }}
              />{' '}
              {r.label} <span className="text-muted-foreground">({r.count})</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Add</legend>
          {FILES.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={files.has(f)}
                onChange={() => {
                  toggle(files, f, setFiles);
                }}
              />{' '}
              {FILE_LABEL[f]}
            </label>
          ))}
        </fieldset>
      </div>
      <Button size="sm" onClick={run} disabled={simulate.isPending}>
        {simulate.isPending ? 'Estimating…' : 'Estimate'}
      </Button>
      {simulate.isError && <p role="alert">Could not run the simulation.</p>}
      {result && (
        <div className="space-y-2 text-sm" role="status">
          <p className="flex items-center gap-2">
            <ScoreBadge score={result.before.overall} /> →{' '}
            <ScoreBadge score={result.after.overall} />
            {result.delta.overall !== null && (
              <span
                className={
                  result.delta.overall >= 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-rose-700 dark:text-rose-300'
                }
              >
                {result.delta.overall >= 0 ? '+' : ''}
                {result.delta.overall} overall
              </span>
            )}
            <span className="text-muted-foreground">
              · {result.findingsResolved} finding{result.findingsResolved === 1 ? '' : 's'} resolved
              · estimate
            </span>
          </p>
          <ul className="text-muted-foreground grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            {result.after.areas
              .filter((a) => (result.delta.areas[a.id] ?? 0) !== 0)
              .map((a) => (
                <li key={a.id}>
                  {a.label}: {(result.delta.areas[a.id] ?? 0) > 0 ? '+' : ''}
                  {result.delta.areas[a.id]}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
