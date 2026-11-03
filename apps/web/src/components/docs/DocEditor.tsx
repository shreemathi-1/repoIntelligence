import { lazy, Suspense, useState } from 'react';
import type { Citation, GeneratedDoc } from '@repointelligence/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { SourceViewer } from '@/components/graph/SourceViewer';
import { docExportUrl, useDrift, useReviewDoc, useSaveDoc } from '@/hooks/use-docs';
import { ApiError } from '@/lib/api-client';
import { MarkdownPreview } from './MarkdownPreview';

const Monaco = lazy(() => import('@monaco-editor/react'));

const ORIGIN: Record<GeneratedDoc['origin'], string> = {
  facts: 'From repository facts',
  prose: 'Facts with written explanations',
  edited: 'Edited',
};

/** Keyed by document version by its parent, so a new version starts a fresh draft. */
export function DocEditor({ doc }: { doc: GeneratedDoc }) {
  const [draft, setDraft] = useState(doc.content);
  const [cited, setCited] = useState<Citation | null>(null);
  const save = useSaveDoc(doc.fullName);
  const review = useReviewDoc();
  const drift = useDrift(doc.id);

  const dirty = draft !== doc.content;
  const error = save.error ?? review.error;

  return (
    <section className="space-y-3" aria-label={`Editing ${doc.title}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{doc.title}</span>
        <code className="text-muted-foreground text-xs">{doc.targetPath}</code>
        <Badge variant="outline">{ORIGIN[doc.origin]}</Badge>
        {doc.model && <span className="text-muted-foreground text-xs">{doc.model}</span>}
        {drift.data?.status === 'drifted' && (
          <Badge variant="secondary" title={drift.data.changedFiles.join(', ')}>
            Out of date: {drift.data.changedFiles.length} cited file
            {drift.data.changedFiles.length === 1 ? '' : 's'} changed
          </Badge>
        )}
        {drift.data?.status === 'current' && <Badge variant="outline">Up to date</Badge>}
      </div>
      {doc.notes.map((note) => (
        <p key={note} className="text-muted-foreground text-xs">
          {note}
        </p>
      ))}
      {drift.data?.status === 'drifted' && drift.data.sections.length > 0 && (
        <p role="note" className="text-sm text-amber-700 dark:text-amber-400">
          Sections to check: {drift.data.sections.map((s) => s.heading).join(', ')}.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-h-[420px] rounded-md border">
          <Suspense
            fallback={
              <textarea
                aria-label="Document source"
                className="h-[420px] w-full p-2 font-mono text-xs"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
              />
            }
          >
            <Monaco
              height="420px"
              language="markdown"
              value={draft}
              theme={document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light'}
              options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 12 }}
              onChange={(value) => {
                setDraft(value ?? '');
              }}
            />
          </Suspense>
        </div>
        <div className="max-h-[420px] overflow-auto rounded-md border p-3" aria-label="Preview">
          <MarkdownPreview content={draft} onCite={setCited} />
        </div>
      </div>

      {cited && (
        <SourceViewer
          fullName={doc.fullName}
          sha={doc.sha}
          path={cited.path}
          line={cited.startLine}
          onClose={() => {
            setCited(null);
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.mutate({ id: doc.id, content: draft });
          }}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={dirty || review.isPending}
          title={dirty ? 'Save first' : undefined}
          onClick={() => {
            review.mutate(doc.id);
          }}
        >
          {review.isPending ? 'Reviewing…' : 'Review quality'}
        </Button>
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={docExportUrl(doc.id, 'markdown', 'github')}>
          Markdown
        </a>
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={docExportUrl(doc.id, 'markdown', 'relative')}>
          Markdown for the repo
        </a>
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={docExportUrl(doc.id, 'html', 'github')}>
          HTML
        </a>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error instanceof ApiError ? error.message : 'Something went wrong.'}
        </p>
      )}

      {review.data && (
        <div className="space-y-2 rounded-md border p-3 text-sm" aria-label="Review">
          <p className="font-medium">
            Quality {review.data.score ?? 'not scored'}
            {review.data.score !== null && '/100'}
            {review.data.model && <span className="text-muted-foreground ml-2 text-xs">{review.data.model}</span>}
          </p>
          {review.data.summary && <p>{review.data.summary}</p>}
          <ul className="space-y-1">
            {review.data.issues.map((issue, i) => (
              <li key={`${issue.rule}-${i}`}>
                <Badge variant={issue.severity === 'error' ? 'destructive' : 'outline'}>{issue.severity}</Badge>{' '}
                {issue.message}
                {issue.line ? ` (line ${issue.line})` : ''}
              </li>
            ))}
            {review.data.issues.length === 0 && <li>No issues found.</li>}
          </ul>
        </div>
      )}
    </section>
  );
} // prettier-ignore
