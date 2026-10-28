import { TRENDING_PERIODS } from '@repointelligence/shared';
import { useState } from 'react';
import { inputClass } from '@/components/fields';
import { RepoCard } from '@/components/RepoCard';
import { Button } from '@/components/ui/button';
import { useTrending, useTrendingTopics } from '@/hooks/use-discovery';

export function TrendingPage() {
  const [period, setPeriod] = useState<(typeof TRENDING_PERIODS)[number]>('weekly');
  const [topic, setTopic] = useState('');
  const topics = useTrendingTopics();
  const { data, error, isPending } = useTrending(period, topic || undefined);

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
      <p className="text-muted-foreground text-sm">
        GitHub has no trending feed, so this is our own estimate from recent stars and activity.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {TRENDING_PERIODS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={period === p ? 'default' : 'outline'}
            aria-pressed={period === p}
            onClick={() => {
              setPeriod(p);
            }}
          >
            {p}
          </Button>
        ))}
        <select
          aria-label="Topic"
          className={inputClass}
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
          }}
        >
          <option value="">All topics</option>
          {topics.data && (
            <>
              <optgroup label="Technology">
                {topics.data.technologies.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Use case">
                {topics.data.useCases.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </>
          )}
        </select>
      </div>

      {isPending && <p className="text-muted-foreground">Loading…</p>}
      {error && <p role="alert">Could not load the trending list.</p>}
      {data?.computedAt === null && (
        <p>This list has not been computed yet. Check back after the next daily run.</p>
      )}
      {data?.computedAt && (
        <>
          <p className="text-muted-foreground text-sm">
            Updated {new Date(data.computedAt).toLocaleString()}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.items.map(({ repo }) => (
              <li key={repo.fullName}>
                <RepoCard repo={repo} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
