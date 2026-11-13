import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { useReleaseSummary, useReleases, useTimeline, type Weeks } from '@/hooks/use-evolution';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { count, longDate } from '@/lib/evolution-format';
import { CompareView } from './CompareView';
import { FactsSource, InterpretationBox } from './Provenance';
import { QueryState, Stat } from './parts';

function Summary({ fullName, tag }: { fullName: string; tag: string }) {
  const summarise = useReleaseSummary(fullName);
  const s = summarise.data;
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" disabled={summarise.isPending} onClick={() => { summarise.mutate({ tag, ...(s && { force: true }) }); }}>
        {summarise.isPending ? 'Summarising…' : s ? 'Summarise again' : `Summarise ${tag}`}
      </Button>
      {summarise.error && <p role="alert" className="text-destructive text-sm">{summarise.error instanceof ApiError ? summarise.error.message : 'Something went wrong.'}</p>}
      {s && (
        <>
          <section aria-label="Release facts" className="space-y-3">
            <FactsSource sources={s.sources} retrievedAt={s.retrievedAt} notes={s.notes} />
            {s.facts.compare ? (
              <>
                <p className="text-sm">Changes from <code>{s.facts.base}</code> to <code>{s.facts.tag}</code></p>
                <CompareView facts={s.facts.compare} />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">No earlier release to compare with.</p>
            )}
          </section>
          <InterpretationBox interpretation={s.interpretation} note={s.interpretationNote} />
        </>
      )}
    </div>
  );
} // prettier-ignore

export function ReleasesTab({ fullName, weeks }: { fullName: string; weeks: Weeks }) {
  const { data: user } = useMe();
  const releases = useReleases(fullName, weeks);
  const timeline = useTimeline(fullName, 1);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      {releases.data ? (
        <section className="space-y-3">
          <FactsSource sources={releases.data.sources} retrievedAt={releases.data.retrievedAt} notes={releases.data.notes} />
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Stat label="Releases in this period" value={count(releases.data.facts.inWindow)} />
            <Stat label="Median days between releases" value={count(releases.data.facts.medianDaysBetween)} />
          </div>
          <ul className="divide-y text-sm">
            {releases.data.facts.releases.slice(0, 15).map((r) => (
              <li key={r.tag} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.tag}</span>
                  {r.prerelease && <Badge variant="outline">pre-release</Badge>}
                  <span className="text-muted-foreground text-xs">{longDate(r.publishedAt)}{r.daysSincePrevious !== null && ` · ${r.daysSincePrevious} days after the previous`}</span>
                  {user ? (
                    <Button size="sm" variant="ghost" onClick={() => { setOpen(open === r.tag ? null : r.tag); }}>
                      {open === r.tag ? 'Hide' : 'Summary'}
                    </Button>
                  ) : null}
                </div>
                {open === r.tag && <Summary fullName={fullName} tag={r.tag} />}
              </li>
            ))}
          </ul>
          {!user && releases.data.facts.releases.length > 0 && (
            <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Sign in to summarise releases</a>
          )}
        </section>
      ) : (
        <QueryState error={releases.error} isPending={releases.isPending} />
      )}

      {timeline.data && (
        <section className="space-y-2">
          <p className="text-sm font-medium">Recent commits on {timeline.data.facts.ref}</p>
          <ul className="space-y-1 text-sm">
            {timeline.data.facts.commits.slice(0, 25).map((c) => (
              <li key={c.sha} className="flex flex-wrap items-baseline gap-2">
                <Badge variant="outline">{c.group}</Badge>
                {c.url ? <a href={c.url} className="hover:underline" rel="noreferrer">{c.subject}</a> : <span>{c.subject}</span>}
                <span className="text-muted-foreground text-xs">{c.login ?? c.author ?? 'unknown'} · {longDate(c.date)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
} // prettier-ignore
