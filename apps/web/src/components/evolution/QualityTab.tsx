import { useState } from 'react';
import { AREAS, type QualityPoint } from '@repointelligence/shared';
import { Badge } from '@/components/ui/badge';
import {
  useArchitectureEvolution,
  useLanguages,
  useQuality,
  useSnapshotCompare,
} from '@/hooks/use-evolution';
import { count, longDate, percent, signed, SERIES, SERIES_OTHER } from '@/lib/evolution-format';
import { FactsSource } from './Provenance';
import { QueryState } from './parts';
import { TimeChart } from './TimeChart';

const [S1 = ''] = SERIES;
const select = 'border-input bg-background h-8 rounded-md border px-2 text-sm';
const label = (p: QualityPoint) => `${longDate(p.finishedAt)} · ${p.sha.slice(0, 7)}`;

function Snapshots({ fullName, points }: { fullName: string; points: QualityPoint[] }) {
  const [a, setA] = useState(points[0]?.runId ?? '');
  const [b, setB] = useState(points.at(-1)?.runId ?? '');
  const compare = useSnapshotCompare(fullName, a, b);
  const f = compare.data?.facts;
  return (
    <section className="space-y-2">
      <p className="text-sm font-medium">Compare two analyses</p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Earlier analysis" className={select} value={a} onChange={(e) => { setA(e.target.value); }}>
          {points.map((p) => <option key={p.runId} value={p.runId}>{label(p)}</option>)}
        </select>
        <select aria-label="Later analysis" className={select} value={b} onChange={(e) => { setB(e.target.value); }}>
          {points.map((p) => <option key={p.runId} value={p.runId}>{label(p)}</option>)}
        </select>
      </div>
      {a === b ? (
        <p className="text-muted-foreground text-sm">Pick two different analyses.</p>
      ) : f && compare.data ? (
        <div className="space-y-2">
          <FactsSource sources={compare.data.sources} retrievedAt={compare.data.retrievedAt} notes={compare.data.notes} />
          <table className="text-sm tabular-nums">
            <thead className="text-muted-foreground text-xs"><tr><th className="pr-4 text-left font-medium">Score</th><th className="pr-4 font-medium">Before</th><th className="pr-4 font-medium">After</th><th className="font-medium">Change</th></tr></thead>
            <tbody>
              <tr><td className="pr-4">Overall</td><td className="pr-4">{count(f.a.overall)}</td><td className="pr-4">{count(f.b.overall)}</td><td>{signed(f.delta.overall)}</td></tr>
              {AREAS.map((area) => <tr key={area}><td className="pr-4">{area}</td><td className="pr-4">{count(f.a.areas[area])}</td><td className="pr-4">{count(f.b.areas[area])}</td><td>{signed(f.delta.areas[area] ?? null)}</td></tr>)}
            </tbody>
          </table>
          <p className="text-sm">{f.findings.introducedCount} findings introduced, {f.findings.resolvedCount} resolved.</p>
          {f.findings.introduced.length > 0 && (
            <ul className="text-xs">{f.findings.introduced.slice(0, 10).map((x, i) => <li key={`${x.rule}-${x.path}-${i}`}><Badge variant="outline">{x.severity}</Badge> {x.tool} {x.rule} in <code>{x.path}</code></li>)}</ul>
          )}
        </div>
      ) : (
        <QueryState error={compare.error} isPending={compare.isPending} />
      )}
    </section>
  );
} // prettier-ignore

function Languages({ fullName }: { fullName: string }) {
  const { data, error, isPending } = useLanguages(fullName);
  if (!data) return <QueryState error={error} isPending={isPending} />;
  const { points, languages } = data.facts;
  const rows = points.map((p) => ({ at: p.at, ...Object.fromEntries(languages.map((l) => [l, p.shares[l] ?? 0])) }));
  const series = languages.map((l, i) => ({ key: l, label: l, color: l === 'Other' ? SERIES_OTHER : (SERIES[i] ?? SERIES_OTHER) }));
  return (
    <section className="space-y-2">
      <FactsSource sources={data.sources} retrievedAt={data.retrievedAt} notes={data.notes} />
      {points.length > 0 ? (
        <TimeChart title="Language share over time" kind="area" shares x="at" rows={rows} series={series} height={200} />
      ) : (
        <p className="text-muted-foreground text-sm">No language data yet.</p>
      )}
      <p className="text-muted-foreground text-xs">Analysis snapshots count lines; the latest point from GitHub counts bytes.</p>
    </section>
  );
} // prettier-ignore

function Architecture({ fullName }: { fullName: string }) {
  const { data, error, isPending } = useArchitectureEvolution(fullName);
  if (!data) return <QueryState error={error} isPending={isPending} />;
  const { snapshots, changes } = data.facts;
  return (
    <section className="space-y-2">
      <p className="text-sm font-medium">Architecture changes</p>
      <FactsSource sources={data.sources} retrievedAt={data.retrievedAt} notes={data.notes} />
      {snapshots.length > 0 && (
        <table className="w-full text-left text-sm tabular-nums">
          <thead className="text-muted-foreground text-xs"><tr><th className="font-medium">Commit</th><th className="font-medium">Built</th><th className="font-medium">Files</th><th className="font-medium">Imports</th><th className="font-medium">Cycles</th><th className="font-medium">Layer violations</th></tr></thead>
          <tbody>{snapshots.map((s) => <tr key={s.sha}><td className="font-mono text-xs">{s.sha.slice(0, 7)}</td><td>{longDate(s.computedAt)}</td><td>{s.files}</td><td>{s.imports}</td><td>{s.cycles}</td><td>{s.layerViolations}</td></tr>)}</tbody>
        </table>
      )}
      <ul className="space-y-1 text-sm">
        {changes.map((c) => (
          <li key={`${c.from}-${c.to}`}>
            <code>{c.from.slice(0, 7)}</code> → <code>{c.to.slice(0, 7)}</code>: +{c.filesAdded} / −{c.filesRemoved} files
            {c.modulesAdded.length > 0 && `, new modules ${c.modulesAdded.join(', ')}`}
            {c.modulesRemoved.length > 0 && `, removed modules ${c.modulesRemoved.join(', ')}`}
            {c.externalsAdded.length > 0 && `, new dependencies ${c.externalsAdded.slice(0, 5).join(', ')}`}
            {c.cyclesIntroduced > 0 && `, ${c.cyclesIntroduced} new import cycles`}
            {c.violationsAfter !== c.violationsBefore && `, layer violations ${c.violationsBefore} → ${c.violationsAfter}`}
          </li>
        ))}
      </ul>
    </section>
  );
} // prettier-ignore

export function QualityTab({ fullName }: { fullName: string }) {
  const { data, error, isPending } = useQuality(fullName);
  return (
    <div className="space-y-6">
      {data ? (
        <section className="space-y-4">
          <FactsSource sources={data.sources} retrievedAt={data.retrievedAt} notes={data.notes} />
          {data.facts.points.length === 0 ? (
            <p className="text-muted-foreground text-sm">Analyse this repository to start its health history.</p>
          ) : (
            <>
              <div className="grid gap-5 lg:grid-cols-2">
                <TimeChart title="Health score" kind="line" x="finishedAt" domain={[0, 100]} rows={data.facts.points.map((p) => ({ finishedAt: p.finishedAt, overall: p.overall }))} series={[{ key: 'overall', label: 'Overall', color: S1 }]} />
                <TimeChart title="Findings" kind="line" x="finishedAt" rows={data.facts.points.map((p) => ({ finishedAt: p.finishedAt, findings: p.findings.total }))} series={[{ key: 'findings', label: 'Findings', color: S1 }]} />
                <TimeChart title="Complex functions" kind="line" x="finishedAt" rows={data.facts.points.map((p) => ({ finishedAt: p.finishedAt, complex: p.debt.complexFunctions }))} series={[{ key: 'complex', label: 'Functions over complexity 15', color: S1 }]} />
                <TimeChart title="Duplicated code (%)" kind="line" x="finishedAt" rows={data.facts.points.map((p) => ({ finishedAt: p.finishedAt, duplication: p.debt.duplicationPercent }))} series={[{ key: 'duplication', label: 'Duplicated lines %', color: S1 }]} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Regressions</p>
                <p className="text-muted-foreground text-xs">
                  An overall or area drop of {data.facts.thresholds.overallDrop} points or more, findings up {percent(data.facts.thresholds.findingsRise)} or more, or a new import cycle or layer violation.
                </p>
                {data.facts.regressions.length === 0 ? (
                  <p className="text-sm">None detected.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {data.facts.regressions.map((r, i) => (
                      <li key={`${r.runId}-${r.kind}-${r.area ?? ''}-${i}`}><Badge variant="destructive">Regression</Badge> {r.message} <span className="text-muted-foreground text-xs">at {r.sha.slice(0, 7)}, {longDate(r.at)}</span></li>
                    ))}
                  </ul>
                )}
              </div>
              {data.facts.points.length > 1 && <Snapshots fullName={fullName} points={data.facts.points} />}
            </>
          )}
        </section>
      ) : (
        <QueryState error={error} isPending={isPending} />
      )}
      <Languages fullName={fullName} />
      <Architecture fullName={fullName} />
    </div>
  );
} // prettier-ignore
