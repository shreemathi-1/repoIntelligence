import type { CompareFacts } from '@repointelligence/shared';
import { Badge } from '@/components/ui/badge';
import { count } from '@/lib/evolution-format';
import { Stat } from './parts';

const GROUP_LABELS: Record<string, string> = {
  breaking: 'Breaking', feat: 'Features', fix: 'Fixes', perf: 'Performance', docs: 'Docs',
  refactor: 'Refactors', other: 'Other', chore: 'Housekeeping', merge: 'Merges',
}; // prettier-ignore

/** Retrieved and counted facts of a comparison between two refs. No model text appears here. */
export function CompareView({ facts }: { facts: CompareFacts }) {
  const deps = facts.dependencies;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Stat label="Commits" value={count(facts.totalCommits)} hint={`${facts.authors} authors`} />
        <Stat label="Files changed" value={`${count(facts.files.total)}${facts.files.truncated ? '+' : ''}`} />
        <Stat label="Lines" value={`+${facts.files.additions.toLocaleString()} −${facts.files.deletions.toLocaleString()}`} />
        <Stat label="Status" value={facts.status} hint={`${facts.aheadBy} ahead, ${facts.behindBy} behind`} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(facts.groups).filter(([, n]) => n > 0).map(([g, n]) => (
          <Badge key={g} variant="outline">{GROUP_LABELS[g] ?? g}: {n}</Badge>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="text-sm font-medium">Busiest directories</p>
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-muted-foreground text-xs"><tr><th className="font-medium">Directory</th><th className="font-medium">Files</th><th className="font-medium">+</th><th className="font-medium">−</th></tr></thead>
            <tbody>{facts.files.directories.map((d) => <tr key={d.path}><td className="font-mono text-xs">{d.path}</td><td>{d.files}</td><td>{d.additions}</td><td>{d.deletions}</td></tr>)}</tbody>
          </table>
        </div>
        <div>
          <p className="text-sm font-medium">Largest file changes</p>
          <ul className="space-y-0.5 text-sm">
            {facts.files.top.slice(0, 10).map((f) => (
              <li key={f.path} className="flex justify-between gap-2"><span className="truncate font-mono text-xs">{f.path}</span><span className="text-muted-foreground shrink-0 text-xs">{f.status} +{f.additions} −{f.deletions}</span></li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium">Dependency changes</p>
        {deps.status !== 'ok' ? (
          <p className="text-muted-foreground text-sm">Unavailable. {deps.reason}</p>
        ) : deps.manifests.length === 0 ? (
          <p className="text-muted-foreground text-sm">No declared dependencies changed.</p>
        ) : (
          deps.manifests.map((m) => (
            <div key={m.path} className="mt-1">
              <p className="font-mono text-xs">{m.path}</p>
              <ul className="text-sm">
                {m.changed.map((c) => <li key={c.name}>{c.name} {c.from} → {c.to} <Badge variant={c.change === 'major' ? 'destructive' : 'outline'}>{c.change} {c.direction}</Badge></li>)}
                {m.added.map((a) => <li key={`+${a.name}`}>Added {a.name} {a.spec}</li>)}
                {m.removed.map((r) => <li key={`-${r.name}`}>Removed {r.name}</li>)}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
} // prettier-ignore
