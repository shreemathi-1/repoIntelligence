import type { MetricStatus } from '@repointelligence/shared';
import { Badge } from '@/components/ui/badge';

const LABEL: Record<MetricStatus, string> = {
  measured: 'measured',
  inferred: 'inferred',
  unavailable: 'unavailable',
};

const TITLE: Record<MetricStatus, string> = {
  measured: 'A tool produced this number',
  inferred: 'Judged from the presence or absence of a file or setting',
  unavailable: 'Could not be observed; left out of the score',
};

export function StatusBadge({ status }: { status: MetricStatus }) {
  return (
    <Badge
      variant={status === 'measured' ? 'default' : status === 'inferred' ? 'secondary' : 'outline'}
      title={TITLE[status]}
    >
      {LABEL[status]}
    </Badge>
  );
}
