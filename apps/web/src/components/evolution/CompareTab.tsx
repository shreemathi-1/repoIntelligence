import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useCompare, useReleases } from '@/hooks/use-evolution';
import { CompareView } from './CompareView';
import { FactsSource } from './Provenance';
import { QueryState } from './parts';

const input = 'border-input bg-background h-8 w-40 rounded-md border px-2 text-sm';

/** Compares any two branches, tags or commits. Defaults to the two latest releases. */
export function CompareTab({ fullName }: { fullName: string }) {
  const releases = useReleases(fullName, 52);
  const [latest, previous] = releases.data?.facts.releases ?? [];
  const [chosen, setChosen] = useState<{ base: string; head: string } | null>(null);
  const refs = chosen ?? { base: previous?.tag ?? '', head: latest?.tag ?? '' };
  const compare = useCompare(fullName, refs.base, refs.head);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v.trim() : '';
    };
    setChosen({ base: value('base'), head: value('head') });
  };

  return (
    <div className="space-y-4">
      <form key={`${refs.base}-${refs.head}`} onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block">Base</span>
          <input name="base" className={input} defaultValue={refs.base} placeholder="v1.0.0 or main" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Head</span>
          <input name="head" className={input} defaultValue={refs.head} placeholder="v1.1.0 or a branch" />
        </label>
        <Button size="sm" type="submit">Compare</Button>
      </form>
      {!refs.base || !refs.head ? (
        <p className="text-muted-foreground text-sm">Enter two branches, tags or commits.</p>
      ) : compare.data ? (
        <section aria-label="Comparison facts" className="space-y-3">
          <FactsSource sources={compare.data.sources} retrievedAt={compare.data.retrievedAt} notes={compare.data.notes} />
          <CompareView facts={compare.data.facts} />
        </section>
      ) : (
        <QueryState error={compare.error} isPending={compare.isPending} />
      )}
    </div>
  );
} // prettier-ignore
