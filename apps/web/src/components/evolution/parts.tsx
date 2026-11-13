import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-28">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

interface SeriesStateProps {
  status: 'ok' | 'pending' | 'unavailable';
  reason: string | null;
  title: string;
  children: ReactNode;
}

/** Shows why a series is missing instead of drawing an empty or zero chart. */
export function SeriesState({ status, reason, title, children }: SeriesStateProps) {
  if (status === 'ok') return <>{children}</>;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-sm">
        {status === 'pending' ? 'Still being computed by GitHub. ' : 'Unavailable. '}
        {reason}
      </p>
    </div>
  );
}

export function QueryState({ error, isPending }: { error: unknown; isPending: boolean }) {
  if (isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (!error) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {error instanceof ApiError ? error.message : 'Something went wrong.'}
    </p>
  );
}
