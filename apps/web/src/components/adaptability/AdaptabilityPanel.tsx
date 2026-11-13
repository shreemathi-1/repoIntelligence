import { useState } from 'react';
import { stackProfileInputSchema, type StackProfileInput } from '@repointelligence/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useAlternatives,
  useDeleteStackProfile,
  useEvaluate,
  useSaveStackProfile,
  useStackProfiles,
} from '@/hooks/use-adaptability';
import { useLatestIngestion } from '@/hooks/use-ingest';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { EMPTY_PROFILE, answersOf, profileError } from '@/lib/stack-profile';
import { ReportView } from './ReportView';
import { StackForm } from './StackForm';

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

export function AdaptabilityPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const ingestion = useLatestIngestion(fullName);
  const profiles = useStackProfiles(Boolean(user));
  const save = useSaveStackProfile();
  const remove = useDeleteStackProfile();
  const evaluate = useEvaluate(fullName);
  const alternatives = useAlternatives(fullName);

  const [draft, setDraft] = useState<StackProfileInput>(EMPTY_PROFILE);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [invalid, setInvalid] = useState<string | null>(null);
  const saved = profiles.data?.profiles ?? [];

  const pick = (id: string) => {
    const chosen = saved.find((p) => p.id === id);
    setSavedId(chosen ? id : null);
    setDraft(chosen ? answersOf(chosen) : EMPTY_PROFILE);
    // The form keeps typed text of its own, so it is remounted for a different profile.
    setFormKey((k) => k + 1);
  };

  /** Runs `then` with the validated draft, or shows what is wrong with it. */
  const withValid = (then: (profile: StackProfileInput) => void) => {
    const problem = profileError(draft);
    setInvalid(problem);
    if (!problem) then(stackProfileInputSchema.parse(draft));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adaptability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Describe your own stack to see how this repository fits it, what would have to change and roughly how much work that is.
        </p>
        {!ingestion.isPending && !ingestion.data ? (
          <p className="text-muted-foreground text-sm">Ingest this repository first; the evaluation reads its manifests and configuration.</p>
        ) : (
          <>
            {user && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label htmlFor="stack-profile">Saved stack</label>
                <select id="stack-profile" className="border-input bg-background h-8 rounded-md border px-2 text-sm" value={savedId ?? ''} onChange={(e) => { pick(e.target.value); }}>
                  <option value="">New stack</option>
                  {saved.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => { withValid((profile) => { save.mutate({ ...(savedId && { id: savedId }), profile }, { onSuccess: (p) => { setSavedId(p.id); } }); }); }}>
                  {savedId ? 'Save changes' : 'Save stack'}
                </Button>
                {savedId && (
                  <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { remove.mutate(savedId, { onSuccess: () => { pick(''); } }); }}>
                    Delete
                  </Button>
                )}
                {profiles.data && <span className="text-muted-foreground text-xs">{saved.length} of {profiles.data.limit} saved</span>}
              </div>
            )}
            <details open={!evaluate.data} className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">Your stack</summary>
              <div className="mt-3">
                <StackForm key={formKey} value={draft} onChange={setDraft} />
              </div>
            </details>
            <Button size="sm" disabled={evaluate.isPending} onClick={() => { withValid((profile) => { alternatives.reset(); evaluate.mutate(profile); }); }}>
              {evaluate.isPending ? 'Evaluating…' : 'Evaluate against this stack'}
            </Button>
            {(invalid ?? message(evaluate.error) ?? message(save.error) ?? message(remove.error) ?? message(alternatives.error)) && (
              <p role="alert" className="text-destructive text-sm">
                {invalid ?? message(evaluate.error) ?? message(save.error) ?? message(remove.error) ?? message(alternatives.error)}
              </p>
            )}
            {evaluate.data && (
              <ReportView
                key={`${evaluate.data.id ?? 'anonymous'}-${evaluate.data.generatedAt}`}
                report={evaluate.data}
                alternatives={alternatives.data}
                findingAlternatives={alternatives.isPending}
                onFindAlternatives={() => { withValid((profile) => { alternatives.mutate(profile); }); }}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
} // prettier-ignore
