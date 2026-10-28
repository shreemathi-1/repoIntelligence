import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useHealth } from '@/hooks/use-health';
import { ApiError } from '@/lib/api-client';

export function HealthPage() {
  const { data, error, isPending } = useHealth();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">System health</h1>

      {isPending && <p className="text-muted-foreground">Checking the API…</p>}

      {error && (
        <Card role="alert">
          <CardHeader>
            <CardTitle>API unreachable</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {error instanceof ApiError ? error.message : 'Something went wrong.'}
          </CardContent>
        </Card>
      )}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {data.service}
              <Badge variant={data.status === 'ok' ? 'default' : 'destructive'}>
                {data.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{data.version}</dd>
              <dt className="text-muted-foreground">Database</dt>
              <dd>{data.checks.database}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd>{Math.round(data.uptimeSeconds)}s</dd>
            </dl>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
