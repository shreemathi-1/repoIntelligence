import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Weeks } from '@/hooks/use-evolution';
import type { Tab } from './EvolutionTabs';

const EvolutionTabs = lazy(() => import('./EvolutionTabs'));

const TABS: { id: Tab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'releases', label: 'Releases' },
  { id: 'compare', label: 'Compare versions' },
  { id: 'quality', label: 'Quality history' },
];
const WINDOWS: Weeks[] = [12, 26, 52];

export function EvolutionPanel({ fullName }: { fullName: string }) {
  const [tab, setTab] = useState<Tab>('activity');
  const [weeks, setWeeks] = useState<Weeks>(52);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evolution</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Evolution views" className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <Button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                size="sm"
                variant={tab === t.id ? 'secondary' : 'ghost'}
                onClick={() => {
                  setTab(t.id);
                }}
              >
                {t.label}
              </Button>
            ))}
          </div>
          {(tab === 'activity' || tab === 'releases') && (
            <label className="ml-auto flex items-center gap-2 text-sm">
              Period
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                value={weeks}
                onChange={(e) => {
                  setWeeks(Number(e.target.value) as Weeks);
                }}
              >
                {WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    Last {w} weeks
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <Suspense fallback={<p className="text-muted-foreground text-sm">Loading charts…</p>}>
          <EvolutionTabs fullName={fullName} tab={tab} weeks={weeks} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
