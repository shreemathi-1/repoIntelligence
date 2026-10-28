import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { inputClass } from '@/components/fields';
import { RepoCard } from '@/components/RepoCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useContribute, useSearch } from '@/hooks/use-discovery';
import { ApiError } from '@/lib/api-client';

const FIELDS = [
  'q',
  'language',
  'license',
  'minStars',
  'activeWithinDays',
  'size',
  'sort',
] as const;

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code === 'RATE_LIMITED'
      ? 'GitHub is limiting searches right now. Try again in a minute.'
      : error.message;
  }
  return 'Something went wrong.';
}

function ContributeFinder() {
  const [language, setLanguage] = useState('');
  const [submitted, setSubmitted] = useState<string | undefined>();
  const [started, setStarted] = useState(false);
  const { data, error, isFetching } = useContribute(submitted, started);

  return (
    <section className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setSubmitted(language.trim() || undefined);
          setStarted(true);
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Language (optional)
          <input
            className={inputClass}
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
            }}
          />
        </label>
        <Button type="submit">Find issues</Button>
      </form>
      {isFetching && <p className="text-muted-foreground">Looking for issues…</p>}
      {error && <p role="alert">{errorText(error)}</p>}
      {data?.items.length === 0 && <p className="text-muted-foreground">No open issues found.</p>}
      <ul className="space-y-2">
        {data?.items.map((issue) => (
          <li key={`${issue.repo}#${issue.number}`}>
            <Card>
              <CardContent className="space-y-1 pt-4 text-sm">
                <a href={issue.htmlUrl} className="font-medium underline-offset-2 hover:underline">
                  {issue.title}
                </a>
                <p className="text-muted-foreground">
                  {issue.repo} #{issue.number} · {issue.comments} comments
                </p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<'repos' | 'issues'>('repos');

  const values = Object.fromEntries(FIELDS.map((field) => [field, params.get(field) ?? undefined]));
  const hasCriteria = FIELDS.some((field) => field !== 'sort' && Boolean(params.get(field)));
  const { data, error, isFetching } = useSearch(values, mode === 'repos' && hasCriteria);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const field of FIELDS) {
      const value = form.get(field);
      if (typeof value === 'string' && value.trim() !== '') next.set(field, value.trim());
    }
    setParams(next);
  };

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Discover repositories</h1>

      <div className="flex gap-2" role="tablist" aria-label="Search mode">
        {(
          [
            ['repos', 'Repositories'],
            ['issues', 'Good first issues'],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            aria-selected={mode === id}
            variant={mode === id ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setMode(id);
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === 'issues' ? (
        <ContributeFinder />
      ) : (
        <>
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={onSubmit} aria-label="Search">
            <label className="flex flex-col gap-1 text-sm sm:col-span-3">
              Keywords
              <input name="q" defaultValue={params.get('q') ?? ''} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Language
              <input
                name="language"
                defaultValue={params.get('language') ?? ''}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              License (e.g. mit)
              <input
                name="license"
                defaultValue={params.get('license') ?? ''}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Minimum stars
              <input
                name="minStars"
                type="number"
                min={0}
                defaultValue={params.get('minStars') ?? ''}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Active within (days)
              <input
                name="activeWithinDays"
                type="number"
                min={1}
                defaultValue={params.get('activeWithinDays') ?? ''}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Size
              <select name="size" defaultValue={params.get('size') ?? ''} className={inputClass}>
                <option value="">Any</option>
                <option value="small">Small (&lt; 1 MB)</option>
                <option value="medium">Medium</option>
                <option value="large">Large (&gt; 50 MB)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Sort by
              <select
                name="sort"
                defaultValue={params.get('sort') ?? 'best-match'}
                className={inputClass}
              >
                <option value="best-match">Best match</option>
                <option value="stars">Stars</option>
                <option value="forks">Forks</option>
                <option value="updated">Recently updated</option>
              </select>
            </label>
            <div className="flex items-end">
              <Button type="submit">Search</Button>
            </div>
          </form>

          {!hasCriteria && (
            <p className="text-muted-foreground">Enter a keyword or pick a filter to begin.</p>
          )}
          {isFetching && <p className="text-muted-foreground">Searching…</p>}
          {error && <p role="alert">{errorText(error)}</p>}
          {data && (
            <>
              <p className="text-muted-foreground text-sm">
                {data.totalCount.toLocaleString()} results
                {data.incomplete && (
                  <Badge className="ml-2" variant="outline">
                    partial
                  </Badge>
                )}
              </p>
              {data.items.length === 0 && <p>No repositories matched.</p>}
              <ul className="grid gap-3 sm:grid-cols-2">
                {data.items.map((repo) => (
                  <li key={repo.fullName}>
                    <RepoCard repo={repo} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
