import { useState } from 'react';
import { DOC_KINDS, DOC_LABELS, DOC_TARGETS, type DocKind } from '@repointelligence/shared';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useDoc,
  useDocList,
  useDocQuota,
  useGenerateDoc,
  useMissingDocs,
  useProposePullRequest,
} from '@/hooks/use-docs';
import { useLatestIngestion } from '@/hooks/use-ingest';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { DocEditor } from './DocEditor';

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

export function DocsPanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const ingestion = useLatestIngestion(fullName);
  const ready = Boolean(ingestion.data);
  const list = useDocList(fullName, Boolean(user) && ready);
  const quota = useDocQuota(Boolean(user));
  const missing = useMissingDocs(fullName, ready);
  const generate = useGenerateDoc(fullName);
  const propose = useProposePullRequest();

  const [kind, setKind] = useState<DocKind>('readme');
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const open = useDoc(openId);

  const docs = list.data?.docs ?? [];
  const existing = docs.find((d) => d.kind === kind && d.sha === ingestion.data?.sha);
  const chosen = docs.filter((d) => selected.includes(d.id));

  const run = (k: DocKind, force = false) => {
    setKind(k);
    generate.mutate(
      { kind: k, ...(force && { force }) },
      {
        onSuccess: (doc) => {
          setOpenId(doc.id);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ingestion.isPending && !ready && (
          <p className="text-muted-foreground text-sm">Ingest this repository to generate documentation from its files.</p>
        )}
        {ready && !user && (
          <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Sign in to generate documentation
          </a>
        )}

        {ready && user && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor="doc-kind">
              Document
            </label>
            <select
              id="doc-kind"
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as DocKind);
              }}
            >
              {DOC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOC_LABELS[k]}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={generate.isPending} onClick={() => { run(kind, Boolean(existing)); }}>
              {generate.isPending ? 'Generating…' : existing ? 'Regenerate' : 'Generate'}
            </Button>
            {existing && (
              <Button size="sm" variant="ghost" onClick={() => { setOpenId(existing.id); }}>
                Open
              </Button>
            )}
            {quota.data && (
              <span className="text-muted-foreground text-xs">
                {quota.data.dailyLimit - quota.data.usedToday} of {quota.data.dailyLimit} generations left today
              </span>
            )}
          </div>
        )}
        {message(generate.error) && <p role="alert" className="text-destructive text-sm">{message(generate.error)}</p>}

        {missing.data && missing.data.items.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Missing documentation ({missing.data.items.length})
              {missing.data.symbolCoverage !== null && (
                <span className="text-muted-foreground ml-2 font-normal">
                  {Math.round(missing.data.symbolCoverage * 100)}% of exported symbols documented
                </span>
              )}
            </summary>
            <ul className="mt-2 space-y-1">
              {missing.data.items.slice(0, 25).map((item, i) => (
                <li key={`${item.label}-${i}`} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.kind}</Badge>
                  <span>{item.label}</span>
                  {item.path && <code className="text-muted-foreground text-xs">{item.path}{item.line ? `:${item.line}` : ''}</code>}
                  {user && item.suggest && (
                    <Button size="xs" variant="ghost" disabled={generate.isPending} onClick={() => { run(item.suggest ?? 'readme'); }}>
                      Generate {DOC_LABELS[item.suggest].toLowerCase()}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {docs.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Generated</p>
            <ul className="space-y-1 text-sm" aria-label="Generated documents">
              {docs.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Include ${d.targetPath} in a pull request`}
                    checked={selected.includes(d.id)}
                    onChange={(e) => {
                      setConfirming(false);
                      setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)));
                    }}
                  />
                  <button type="button" className="underline" onClick={() => { setOpenId(d.id); }}>
                    {DOC_LABELS[d.kind]}
                  </button>
                  <code className="text-muted-foreground text-xs">{d.targetPath}</code>
                  <span className="text-muted-foreground text-xs">@ {d.sha.slice(0, 7)}</span>
                  {d.origin === 'edited' && <Badge variant="outline">edited</Badge>}
                </li>
              ))}
            </ul>
            {chosen.length > 0 && !confirming && (
              <Button size="sm" variant="outline" onClick={() => { setConfirming(true); setReviewed(false); propose.reset(); }}>
                Propose pull request…
              </Button>
            )}
          </div>
        )}

        {confirming && chosen.length > 0 && (
          <div role="dialog" aria-label="Propose a documentation pull request" className="space-y-2 rounded-md border p-3 text-sm">
            <p>
              A draft pull request will be opened on <strong>{fullName}</strong> from a new branch, using your GitHub
              account. The default branch is not changed. These files will be added or replaced:
            </p>
            <ul className="list-disc pl-5">
              {chosen.map((d) => (
                <li key={d.id}><code>{DOC_TARGETS[d.kind]}</code></li>
              ))}
            </ul>
            {user?.docsWriteScope ? (
              <>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={reviewed} onChange={(e) => { setReviewed(e.target.checked); }} />
                  I have read these documents and want to propose them
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!reviewed || propose.isPending}
                    onClick={() => {
                      propose.mutate({ docIds: chosen.map((d) => d.id), confirmPaths: chosen.map((d) => d.targetPath) });
                    }}
                  >
                    {propose.isPending ? 'Opening…' : 'Open draft pull request'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setConfirming(false); }}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <p>
                GitHub has not granted write access yet.{' '}
                <a className="underline" href={loginUrl(user?.preferences.privateRepoAccess ?? false, true)}>
                  Allow documentation pull requests
                </a>{' '}
                (you can also do this in <Link className="underline" to="/settings">Settings</Link>).
              </p>
            )}
            {propose.data && (
              <p role="status">
                Opened{' '}
                <a className="underline" href={propose.data.url} rel="noreferrer" target="_blank">
                  pull request #{propose.data.number}
                </a>{' '}
                from <code>{propose.data.branch}</code>.
              </p>
            )}
            {message(propose.error) && <p role="alert" className="text-destructive">{message(propose.error)}</p>}
          </div>
        )}

        {open.data && (
          <DocEditor
            key={`${open.data.id}-${open.data.editedAt ?? open.data.generatedAt}`}
            doc={open.data}
          />
        )}
        <p className="text-muted-foreground text-xs">
          Tables and lists come from the repository files; explanations are written by a model and can be wrong. Every
          citation links to the lines it came from.
        </p>
      </CardContent>
    </Card>
  );
} // prettier-ignore
