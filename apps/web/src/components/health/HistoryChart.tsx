import type { HealthHistoryItem } from '@repointelligence/shared';

/** Overall score per run, oldest first. Plain SVG; nothing to load. */
export function HistoryChart({ items }: { items: HealthHistoryItem[] }) {
  const points = [...items].reverse();
  if (points.length < 2) {
    return (
      <p className="text-muted-foreground text-sm">History appears after a second analysis.</p>
    );
  }
  const width = 320;
  const height = 80;
  const step = width / (points.length - 1);
  const path = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((p.overall ?? 0) / 100) * height).toFixed(1)}`,
    )
    .join(' ');
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-20 w-full"
        role="img"
        aria-label={`Score history: ${points.map((p) => p.overall ?? 'none').join(', ')}`}
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
        {points.map((p, i) => (
          <circle
            key={p.runId}
            cx={i * step}
            cy={height - ((p.overall ?? 0) / 100) * height}
            r={3}
            fill={p.overall === null ? 'none' : 'currentColor'}
            stroke="currentColor"
          />
        ))}
      </svg>
      <figcaption className="text-muted-foreground flex justify-between text-xs">
        <span>{new Date(points[0]?.finishedAt ?? '').toLocaleDateString()}</span>
        <span>{new Date(points[points.length - 1]?.finishedAt ?? '').toLocaleDateString()}</span>
      </figcaption>
    </figure>
  );
}
