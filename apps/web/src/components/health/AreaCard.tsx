import type { AreaScore } from '@repointelligence/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScoreBadge } from './ScoreBadge';
import { StatusBadge } from './StatusBadge';

export function AreaCard({ area }: { area: AreaScore }) {
  const [open, setOpen] = useState(false);
  const unavailable = area.metrics.filter((m) => m.status === 'unavailable').length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>
            {area.label}{' '}
            <span className="text-muted-foreground text-xs font-normal">weight {area.weight}</span>
          </span>
          <ScoreBadge score={area.score} />
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {Math.round(area.confidence * 100)}% of this area observed
          {unavailable > 0 && ` · ${unavailable} metric${unavailable === 1 ? '' : 's'} unavailable`}
        </p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {open ? 'Hide evidence' : 'Show evidence'}
        </Button>
        {open && (
          <ul className="space-y-2">
            {area.metrics.map((metric) => (
              <li key={metric.id} className="border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{metric.label}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={metric.status} />
                    <ScoreBadge score={metric.score} />
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {metric.evidence}
                  {metric.value !== null && metric.unit && ` (${metric.value} ${metric.unit})`}
                  <span className="ml-1 text-xs">· {metric.source}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
