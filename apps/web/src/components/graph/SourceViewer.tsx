import { lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { useSource } from '@/hooks/use-graph';

const Monaco = lazy(() => import('@monaco-editor/react'));

export interface SourceViewerProps {
  fullName: string;
  sha: string;
  path: string;
  line: number | null;
  onClose: () => void;
}

/** Plain text with line numbers; shown until the editor loads and wherever it cannot. */
function PlainSource({ content, line }: { content: string; line: number | null }) {
  return (
    <pre
      className="bg-muted max-h-[480px] overflow-auto rounded-md p-3 text-xs"
      data-testid="plain-source"
    >
      {content.split('\n').map((text, index) => (
        <div
          key={index}
          className={index + 1 === line ? 'bg-amber-200 dark:bg-amber-900' : undefined}
        >
          <span className="text-muted-foreground mr-3 inline-block w-8 select-none text-right">
            {index + 1}
          </span>
          {text}
        </div>
      ))}
    </pre>
  );
}

export function SourceViewer({ fullName, sha, path, line, onClose }: SourceViewerProps) {
  const source = useSource(fullName, sha, path);
  return (
    <section className="space-y-2" aria-label={`Source of ${path}`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-mono">
          {path}
          {line ? `:${line}` : ''}{' '}
          <span className="text-muted-foreground">@ {sha.slice(0, 12)}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {source.isPending && <p className="text-muted-foreground text-sm">Loading source…</p>}
      {source.isError && <p role="alert">Could not load this file.</p>}
      {source.data && (
        <>
          {source.data.truncated && (
            <p className="text-muted-foreground text-xs">
              Showing the first 512 KB of {source.data.bytes} bytes.
            </p>
          )}
          <Suspense fallback={<PlainSource content={source.data.content} line={line} />}>
            <Monaco
              height="480px"
              language={source.data.language ?? 'plaintext'}
              value={source.data.content}
              theme={document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
              onMount={(editor) => {
                if (line) {
                  editor.revealLineInCenter(line);
                  editor.setSelection({
                    startLineNumber: line,
                    startColumn: 1,
                    endLineNumber: line,
                    endColumn: 1,
                  });
                }
              }}
              loading={<PlainSource content={source.data.content} line={line} />}
            />
          </Suspense>
        </>
      )}
    </section>
  );
}
