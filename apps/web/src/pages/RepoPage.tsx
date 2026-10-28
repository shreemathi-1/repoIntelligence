import { Link, useParams } from 'react-router-dom';
import { IngestPanel } from '@/components/IngestPanel';
import { Badge } from '@/components/ui/badge';
import { useRepo } from '@/hooks/use-ingest';
import { ApiError } from '@/lib/api-client';

export function RepoPage() {
  const { owner = '', name = '' } = useParams();
  const fullName = `${owner}/${name}`;
  const { data, error, isPending } = useRepo(fullName);

  if (isPending) return <p className="text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {error instanceof ApiError && error.status === 404
            ? 'Repository not found'
            : 'Could not load the repository'}
        </h1>
        <Link to="/search" className="text-sm underline">
          Back to search
        </Link>
      </section>
    );
  }

  const { repo } = data;
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}</h1>
        <p className="text-muted-foreground">{repo.description ?? 'No description'}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {repo.language && <Badge variant="outline">{repo.language}</Badge>}
          <span>★ {repo.stars.toLocaleString()}</span>
          <a className="underline" href={repo.htmlUrl} rel="noreferrer">
            View on GitHub
          </a>
        </div>
      </div>
      <IngestPanel fullName={repo.fullName} />
    </section>
  );
}
