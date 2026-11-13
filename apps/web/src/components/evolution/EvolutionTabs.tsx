import type { Weeks } from '@/hooks/use-evolution';
import { ActivityTab } from './ActivityTab';
import { CompareTab } from './CompareTab';
import { QualityTab } from './QualityTab';
import { ReleasesTab } from './ReleasesTab';

export type Tab = 'activity' | 'releases' | 'compare' | 'quality';

/** The chart-heavy part of the panel, loaded on demand together with the charting library. */
export default function EvolutionTabs({ fullName, tab, weeks }: { fullName: string; tab: Tab; weeks: Weeks }) {
  if (tab === 'activity') return <ActivityTab fullName={fullName} weeks={weeks} />;
  if (tab === 'releases') return <ReleasesTab fullName={fullName} weeks={weeks} />;
  if (tab === 'compare') return <CompareTab fullName={fullName} />;
  return <QualityTab fullName={fullName} />;
} // prettier-ignore
