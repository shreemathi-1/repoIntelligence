import { cn } from '@/lib/utils';

/** A score out of 100, or a dash when there is none. Colour follows the number. */
export function ScoreBadge({ score, size = 'md' }: { score: number | null; size?: 'md' | 'lg' }) {
  const tone =
    score === null
      ? 'bg-muted text-muted-foreground'
      : score >= 75
        ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
        : score >= 50
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200';
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-semibold tabular-nums',
        size === 'lg' ? 'h-16 w-20 text-3xl' : 'h-7 min-w-10 px-2 text-sm',
        tone,
      )}
      aria-label={score === null ? 'No score' : `Score ${score} out of 100`}
    >
      {score ?? '—'}
    </span>
  );
}
