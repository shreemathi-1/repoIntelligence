import type { RepoCard as RepoCardData } from '@repointelligence/shared';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/hooks/use-me';
import { useSaved, useSaveRepo, useUnsaveRepo } from '@/hooks/use-library';

const RESTRICTIVE = new Set(['strong-copyleft', 'network-copyleft', 'none', 'unknown']);

export function LicenseBadge({ license }: { license: RepoCardData['license'] }) {
  const label = license.spdxId ?? 'No license';
  return (
    <Badge
      variant={RESTRICTIVE.has(license.category) ? 'destructive' : 'secondary'}
      title={license.flags.join('. ') || 'No adoption restrictions flagged'}
    >
      {label}
    </Badge>
  );
}

export function RepoCard({ repo }: { repo: RepoCardData }) {
  const { data: user } = useMe();
  const { data: saved } = useSaved();
  const save = useSaveRepo();
  const unsave = useUnsaveRepo();
  const isSaved = saved?.items.some(
    (item) => item.fullName.toLowerCase() === repo.fullName.toLowerCase(),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start justify-between gap-2 text-base">
          <Link
            to={`/repo/${repo.fullName}`}
            className="break-all underline-offset-2 hover:underline"
          >
            {repo.fullName}
          </Link>
          {user && (
            <Button
              size="sm"
              variant={isSaved ? 'secondary' : 'outline'}
              disabled={save.isPending || unsave.isPending}
              aria-label={`${isSaved ? 'Unsave' : 'Save'} ${repo.fullName}`}
              onClick={() => {
                if (isSaved) unsave.mutate(repo.fullName);
                else save.mutate(repo.fullName);
              }}
            >
              {isSaved ? 'Saved' : 'Save'}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">{repo.description ?? 'No description'}</p>
        <div className="flex flex-wrap items-center gap-2">
          {repo.language && <Badge variant="outline">{repo.language}</Badge>}
          <span>★ {repo.stars.toLocaleString()}</span>
          <span className="text-muted-foreground">{repo.forks.toLocaleString()} forks</span>
          <LicenseBadge license={repo.license} />
        </div>
      </CardContent>
    </Card>
  );
}
