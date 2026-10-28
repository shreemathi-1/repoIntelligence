import { useState, type FormEvent } from 'react';
import { inputClass } from '@/components/fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useClearHistory,
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useHistory,
  useMarkSeen,
  useSaved,
  useUnsaveRepo,
  useUnwatchRepo,
  useWatchChanges,
  useWatchlist,
  useWatchRepo,
} from '@/hooks/use-library';

function flag(value: boolean | null, yes: string): string {
  if (value === null) return 'nothing to compare yet';
  return value ? yes : 'no change';
}

export function SavedPage() {
  const saved = useSaved();
  const collections = useCollections();
  const watchlist = useWatchlist();
  const history = useHistory();
  const [checkChanges, setCheckChanges] = useState(false);
  const changes = useWatchChanges(checkChanges);
  const [name, setName] = useState('');
  const [watchName, setWatchName] = useState('');

  const unsave = useUnsaveRepo();
  const createCollection = useCreateCollection();
  const deleteCollection = useDeleteCollection();
  const watch = useWatchRepo();
  const unwatch = useUnwatchRepo();
  const markSeen = useMarkSeen();
  const clearHistory = useClearHistory();

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Your library</h1>

      <section className="space-y-3" aria-labelledby="saved-h">
        <h2 id="saved-h" className="text-lg font-medium">
          Saved repositories
        </h2>
        {saved.data?.items.length === 0 && (
          <p className="text-muted-foreground">Nothing saved yet. Use Save on any search result.</p>
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {saved.data?.items.map((item) => (
            <li key={item.fullName}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    {item.fullName}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${item.fullName}`}
                      onClick={() => {
                        unsave.mutate(item.fullName);
                      }}
                    >
                      Remove
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground space-y-1 text-sm">
                  <p>{item.description ?? 'No description'}</p>
                  {item.collections.length > 0 && <p>In: {item.collections.join(', ')}</p>}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="collections-h">
        <h2 id="collections-h" className="text-lg font-medium">
          Collections
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!name.trim()) return;
            createCollection.mutate(name.trim(), {
              onSuccess: () => {
                setName('');
              },
            });
          }}
        >
          <input
            aria-label="New collection name"
            className={inputClass}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Button type="submit" size="sm">
            Create
          </Button>
        </form>
        {createCollection.isError && <p role="alert">Could not create the collection.</p>}
        <ul className="space-y-2">
          {collections.data?.items.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <span>
                {c.name} <span className="text-muted-foreground">({c.repositories.length})</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete collection ${c.name}`}
                onClick={() => {
                  deleteCollection.mutate(c.id);
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="watch-h">
        <h2 id="watch-h" className="text-lg font-medium">
          Watchlist
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!watchName.trim()) return;
            watch.mutate(watchName.trim(), {
              onSuccess: () => {
                setWatchName('');
              },
            });
          }}
        >
          <input
            aria-label="Repository to watch"
            placeholder="owner/name"
            className={inputClass}
            value={watchName}
            onChange={(e) => {
              setWatchName(e.target.value);
            }}
          />
          <Button type="submit" size="sm">
            Watch
          </Button>
        </form>
        {watch.isError && <p role="alert">Could not watch that repository.</p>}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setCheckChanges(true);
            void changes.refetch();
          }}
        >
          Check for changes
        </Button>
        {changes.isFetching && <p className="text-muted-foreground">Checking…</p>}
        <ul className="space-y-2">
          {watchlist.data?.items.map((w) => {
            const change = changes.data?.items.find((c) => c.fullName === w.fullName);
            return (
              <li key={w.fullName} className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{w.fullName}</span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        markSeen.mutate(w.fullName);
                      }}
                    >
                      Mark as seen
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Stop watching ${w.fullName}`}
                      onClick={() => {
                        unwatch.mutate(w.fullName);
                      }}
                    >
                      Stop
                    </Button>
                  </span>
                </div>
                {change?.status === 'unavailable' && (
                  <p className="text-muted-foreground">Could not check this repository.</p>
                )}
                {change?.status === 'ok' && (
                  <ul className="text-muted-foreground">
                    <li>
                      Release {change.latestRelease ?? 'none'}:{' '}
                      {flag(change.newRelease, 'new release')}
                    </li>
                    <li>Commits: {flag(change.newCommits, 'new commits')}</li>
                    <li>
                      Open issues and PRs: {change.openIssues ?? 'unavailable'}
                      {change.openIssuesDelta !== null &&
                        ` (${change.openIssuesDelta >= 0 ? '+' : ''}${change.openIssuesDelta})`}
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="history-h">
        <div className="flex items-center justify-between">
          <h2 id="history-h" className="text-lg font-medium">
            History
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clearHistory.mutate(undefined);
            }}
          >
            Clear
          </Button>
        </div>
        {history.data?.items.length === 0 && (
          <p className="text-muted-foreground">No history yet.</p>
        )}
        <ul className="space-y-1 text-sm">
          {history.data?.items.map((h) => (
            <li key={h.id}>
              <span className="text-muted-foreground">
                {h.kind === 'search' ? 'Searched' : 'Viewed'}
              </span>{' '}
              {h.fullName ?? h.query}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
