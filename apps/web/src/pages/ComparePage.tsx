import type { CompareResponse } from '@repointelligence/shared';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { inputClass } from '@/components/fields';
import { LicenseBadge } from '@/components/RepoCard';
import { Button } from '@/components/ui/button';
import { useCompare } from '@/hooks/use-discovery';

type Item = CompareResponse['items'][number];

const unavailable = <span className="text-muted-foreground">unavailable</span>;

const ROWS: { label: string; cell: (item: Item) => React.ReactNode }[] = [
  { label: 'Language', cell: (i) => i.repo?.language ?? unavailable },
  { label: 'Stars', cell: (i) => i.repo?.stars.toLocaleString() ?? unavailable },
  { label: 'Forks', cell: (i) => i.repo?.forks.toLocaleString() ?? unavailable },
  { label: 'Open issues and PRs', cell: (i) => i.repo?.openIssues.toLocaleString() ?? unavailable },
  {
    label: 'License',
    cell: (i) => (i.repo ? <LicenseBadge license={i.repo.license} /> : unavailable),
  },
  {
    label: 'Commits, last 4 weeks',
    cell: (i) => i.commitsLast4Weeks ?? unavailable,
  },
  {
    label: 'Beginner-friendly',
    cell: (i) =>
      i.beginner?.score != null ? (
        <span>
          {i.beginner.score}/100{' '}
          <span className="text-muted-foreground">
            ({Math.round(i.beginner.confidence * 100)}% observed)
          </span>
        </span>
      ) : (
        unavailable
      ),
  },
];

export function ComparePage() {
  const [params, setParams] = useSearchParams();
  const repos = (params.get('repos') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const [text, setText] = useState(repos.join(', '));
  const { data, error, isFetching } = useCompare(repos);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setParams(text.trim() ? { repos: text.trim() } : {});
  };

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Compare repositories</h1>
      <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit} aria-label="Compare">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Repositories (owner/name, 2 to 4, comma separated)
          <input
            className={inputClass}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </label>
        <Button type="submit">Compare</Button>
      </form>

      {repos.length === 1 && <p>Add at least one more repository to compare.</p>}
      {isFetching && <p className="text-muted-foreground">Comparing…</p>}
      {error && <p role="alert">Could not compare these repositories. Check the names.</p>}
      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4" />
                {data.items.map((item) => (
                  <th key={item.fullName} className="py-2 pr-4">
                    {item.fullName}
                    {item.status !== 'ok' && (
                      <span className="text-muted-foreground block text-xs font-normal">
                        {item.status === 'not_found' ? 'not found' : 'unavailable'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label} className="border-b">
                  <th scope="row" className="text-muted-foreground py-2 pr-4 font-normal">
                    {row.label}
                  </th>
                  {data.items.map((item) => (
                    <td key={item.fullName} className="py-2 pr-4">
                      {item.status === 'ok' ? row.cell(item) : unavailable}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
