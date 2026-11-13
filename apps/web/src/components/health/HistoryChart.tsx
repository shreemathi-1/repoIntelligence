import { lazy, Suspense } from 'react';
import type { HealthHistoryItem } from '@repointelligence/shared';

// The charting library is loaded only when a history is shown.
const TimeChart = lazy(() =>
  import('../evolution/TimeChart').then((m) => ({ default: m.TimeChart })),
);

/** Overall score per run, oldest first. A run without an overall score leaves a gap. */
export function HistoryChart({ items }: { items: HealthHistoryItem[] }) {
  if (items.length < 2) {
    return (
      <p className="text-muted-foreground text-sm">History appears after a second analysis.</p>
    );
  }
  const rows = [...items].reverse().map((p) => ({ finishedAt: p.finishedAt, overall: p.overall }));
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading chart…</p>}>
      <TimeChart
        title="Score history"
        kind="line"
        x="finishedAt"
        domain={[0, 100]}
        height={120}
        rows={rows}
        series={[{ key: 'overall', label: 'Overall', color: 'var(--series-1)' }]}
      />
    </Suspense>
  );
}
