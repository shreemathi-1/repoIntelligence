import type { ActivityFacts } from '@repointelligence/shared';
import { useActivity, type Weeks } from '@/hooks/use-evolution';
import { count, duration, signed, SERIES } from '@/lib/evolution-format';
import { FactsSource } from './Provenance';
import { QueryState, SeriesState, Stat } from './parts';
import { TimeChart } from './TimeChart';

const [S1 = '', S2 = '', S3 = ''] = SERIES;

function Headline({ facts }: { facts: ActivityFacts }) {
  const { commits, contributors, pullRequests, issues, growth } = facts;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <Stat label="Commits" value={count(commits.total)} hint={commits.perWeekAverage === null ? undefined : `${commits.perWeekAverage} a week`} />
      <Stat label="Change, second half vs first" value={commits.changePercent === null ? 'no data' : `${signed(commits.changePercent)}%`} />
      <Stat label="Bus factor" value={count(contributors.busFactor)} hint={`previous period ${count(contributors.previousBusFactor)}`} />
      <Stat label="Median time to merge" value={duration(pullRequests.medianHoursToMerge)} />
      <Stat label="Median time to close an issue" value={duration(issues.medianHoursToClose)} />
      <Stat label="Stars" value={count(growth.stars)} hint={`${count(growth.forks)} forks`} />
    </div>
  );
} // prettier-ignore

export function ActivityTab({ fullName, weeks }: { fullName: string; weeks: Weeks }) {
  const { data, error, isPending } = useActivity(fullName, weeks);
  if (!data) return <QueryState error={error} isPending={isPending} />;
  const f = data.facts;
  return (
    <div className="space-y-5">
      <FactsSource sources={data.sources} retrievedAt={data.retrievedAt} notes={data.notes} />
      <Headline facts={f} />
      <div className="grid gap-5 lg:grid-cols-2">
        <SeriesState {...f.commits} title="Commits per week">
          <TimeChart title="Commits per week" kind="bar" x="week" rows={f.commits.points} series={[{ key: 'commits', label: 'Commits', color: S1 }]} />
        </SeriesState>
        <SeriesState {...f.codeFrequency} title="Lines changed per week">
          <TimeChart title="Lines changed per week" kind="bar" x="week" rows={f.codeFrequency.points} series={[{ key: 'additions', label: 'Added', color: S1 }, { key: 'deletions', label: 'Removed', color: S2 }]} />
        </SeriesState>
        <SeriesState {...f.contributors} title="Contributors per week">
          <TimeChart title="Contributors per week" kind="line" x="week" rows={f.contributors.points} series={[{ key: 'active', label: 'Active', color: S1 }, { key: 'newcomers', label: 'First commit', color: S2 }]} />
        </SeriesState>
        <SeriesState {...f.pullRequests} title="Pull requests per week">
          <TimeChart title="Pull requests per week" kind="bar" x="week" rows={f.pullRequests.points} series={[{ key: 'opened', label: 'Opened', color: S1 }, { key: 'merged', label: 'Merged', color: S2 }, { key: 'closed', label: 'Closed unmerged', color: S3 }]} />
        </SeriesState>
        <SeriesState {...f.issues} title="Issues per week">
          <TimeChart title="Issues per week" kind="bar" x="week" rows={f.issues.points} series={[{ key: 'opened', label: 'Opened', color: S1 }, { key: 'closed', label: 'Closed', color: S2 }]} />
        </SeriesState>
        <SeriesState {...f.growth} title="Stars over time">
          <TimeChart title={f.growth.sampled ? 'Stars over time (sampled)' : 'Stars over time'} kind="line" x="at" rows={f.growth.starPoints} series={[{ key: 'stars', label: 'Stars', color: S1 }]} />
        </SeriesState>
      </div>
      {f.contributors.top.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Top contributors in this period</p>
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr><th className="font-medium">Author</th><th className="font-medium">Commits</th><th className="font-medium">Lines added</th><th className="font-medium">Lines removed</th></tr>
            </thead>
            <tbody className="tabular-nums">
              {f.contributors.top.map((c) => (
                <tr key={c.login}><td>{c.login}</td><td>{c.commits}</td><td>{c.additions.toLocaleString()}</td><td>{c.deletions.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
} // prettier-ignore
