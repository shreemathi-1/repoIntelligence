import {
  GRAPH_VIEWS,
  MERMAID_DIAGRAMS,
  type GraphView,
  type ViewNode,
} from '@repointelligence/shared';
import { lazy, Suspense, useState } from 'react';
import { inputClass } from '@/components/fields';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  mermaidUrl,
  useGraphDiff,
  useGraphRun,
  useGraphSummary,
  useGraphView,
  useStartGraph,
  useTrace,
} from '@/hooks/use-graph';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { loginUrl } from '@/lib/auth-urls';
import { FolderTree } from './FolderTree';
import { SourceViewer } from './SourceViewer';

const GraphCanvas = lazy(() => import('./GraphCanvas'));

const TABS = ['overview', 'graph', 'folders', 'routes', 'data', 'auth', 'diff'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  graph: 'Graph',
  folders: 'Folders',
  routes: 'Routes',
  data: 'Data',
  auth: 'Auth',
  diff: 'Compare',
};

export function ArchitecturePanel({ fullName }: { fullName: string }) {
  const { data: user } = useMe();
  const summary = useGraphSummary(fullName);
  const [runId, setRunId] = useState<string | null>(null);
  const run = useGraphRun(runId);
  const start = useStartGraph(fullName);
  const [tab, setTab] = useState<Tab>('overview');
  const [view, setView] = useState<GraphView>('modules');
  const [folder, setFolder] = useState<string | undefined>();
  const [file, setFile] = useState<string | undefined>();
  const [selected, setSelected] = useState<{ path: string; line: number | null } | null>(null);
  const [traceRoute, setTraceRoute] = useState<string | null>(null);
  const [diffFrom, setDiffFrom] = useState('');

  const data = summary.data ?? null;
  const sha = data?.sha ?? null;
  const graphView = useGraphView(fullName, tab === 'graph' ? sha : null, view, folder, file);
  const trace = useTrace(fullName, sha, traceRoute);
  const diff = useGraphDiff(
    fullName,
    /^[0-9a-f]{40}$/i.test(diffFrom) ? diffFrom.toLowerCase() : null,
    sha,
  );
  const active = run.data && (run.data.status === 'queued' || run.data.status === 'running');
  const startError =
    start.error instanceof ApiError
      ? start.error.message
      : start.isError
        ? 'Could not start the build.'
        : null;

  const openNode = (node: ViewNode): void => {
    if (node.kind === 'module' && node.path) {
      setView('files');
      setFolder(node.path);
      setFile(undefined);
    } else if (node.kind === 'file' && node.path) {
      setSelected({ path: node.path, line: node.line });
    } else if (node.kind === 'symbol' && node.path) {
      setSelected({ path: node.path, line: node.line });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Architecture map</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.isPending && <p className="text-muted-foreground">Looking for an existing map…</p>}
        {!summary.isPending && !data && !active && (
          <p className="text-muted-foreground">This repository has not been mapped yet.</p>
        )}
        {data && (
          <p className="text-sm">
            Mapped from commit <code>{data.sha.slice(0, 12)}</code>: {data.stats.filesParsed} files
            parsed
            {data.stats.filesSkipped > 0 && `, ${data.stats.filesSkipped} skipped`}
            {data.stats.parseErrors > 0 && `, ${data.stats.parseErrors} with parse errors`}.{' '}
            <span className="text-muted-foreground">
              Detected from source by pattern; nothing here is verified by running the code.
            </span>
          </p>
        )}

        {run.data && (
          <div className="space-y-1 text-sm" aria-live="polite">
            <p>
              <span className="font-medium">{run.data.status}</span> · {run.data.progress.message}
            </p>
            <progress
              className="h-2 w-full"
              value={run.data.progress.percent}
              max={100}
              aria-label="Graph build progress"
            />
            {run.data.error && <p role="alert">{run.data.error}</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {user ? (
            <Button
              size="sm"
              disabled={start.isPending || Boolean(active)}
              onClick={() => {
                start.mutate(data ? { force: true } : {}, {
                  onSuccess: (started) => {
                    setRunId(started.id);
                  },
                });
              }}
            >
              {data ? 'Map again' : 'Map architecture'}
            </Button>
          ) : (
            <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Sign in to map
            </a>
          )}
          {data && (
            <span className="text-muted-foreground text-xs">
              Export Mermaid:{' '}
              {MERMAID_DIAGRAMS.map((diagram) => (
                <a
                  key={diagram}
                  className="mr-2 underline"
                  href={mermaidUrl(fullName, data.sha, diagram)}
                >
                  {diagram}
                </a>
              ))}
            </span>
          )}
        </div>
        {startError && <p role="alert">{startError}</p>}

        {data && (
          <>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Architecture views">
              {TABS.map((id) => (
                <Button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  size="sm"
                  variant={tab === id ? 'default' : 'outline'}
                  onClick={() => {
                    setTab(id);
                  }}
                >
                  {TAB_LABEL[id]}
                </Button>
              ))}
            </div>

            {tab === 'overview' && (
              <div className="grid gap-4 text-sm sm:grid-cols-2">
                <section>
                  <h3 className="font-medium">Tech stack</h3>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {data.stack.map((item) => (
                      <li key={`${item.category}-${item.name}`}>
                        <Badge
                          variant={item.category === 'framework' ? 'default' : 'secondary'}
                          title={item.evidence}
                        >
                          {item.name}
                          {item.version ? ` ${item.version}` : ''}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="font-medium">Layers</h3>
                  <ul className="text-muted-foreground mt-1">
                    {Object.entries(data.layers)
                      .filter(([, n]) => n > 0)
                      .map(([layer, n]) => (
                        <li key={layer}>
                          {layer}: {n} file{n === 1 ? '' : 's'}
                        </li>
                      ))}
                  </ul>
                </section>
                <section>
                  <h3 className="font-medium">Entry points</h3>
                  <ul className="text-muted-foreground mt-1">
                    {data.entryPoints.length === 0 && <li>None detected</li>}
                    {data.entryPoints.map((e) => (
                      <li key={`${e.path}-${e.label}`}>
                        <button
                          type="button"
                          className="font-mono underline-offset-2 hover:underline"
                          onClick={() => {
                            setSelected({ path: e.path, line: e.line });
                          }}
                        >
                          {e.path}
                          {e.line ? `:${e.line}` : ''}
                        </button>{' '}
                        — {e.label} <span className="text-xs">({e.evidence})</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="font-medium">Cycles and layer violations</h3>
                  <ul className="text-muted-foreground mt-1">
                    {data.cycles.length === 0 && <li>No import cycles</li>}
                    {data.cycles.slice(0, 10).map((cycle) => (
                      <li key={cycle.join('|')} className="font-mono text-xs">
                        ↻ {cycle.join(' ↔ ')}
                      </li>
                    ))}
                    <li>
                      {data.layerViolations.length} import
                      {data.layerViolations.length === 1 ? '' : 's'} against the layer direction
                    </li>
                  </ul>
                </section>
              </div>
            )}

            {tab === 'graph' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {GRAPH_VIEWS.map((v) => (
                    <Button
                      key={v}
                      size="sm"
                      variant={view === v ? 'default' : 'outline'}
                      aria-pressed={view === v}
                      onClick={() => {
                        setView(v);
                        if (v === 'modules') {
                          setFolder(undefined);
                          setFile(undefined);
                        }
                      }}
                    >
                      {v}
                    </Button>
                  ))}
                  {folder && (
                    <span className="text-muted-foreground">
                      in <code>{folder}</code>
                    </span>
                  )}
                  {file && (
                    <span className="text-muted-foreground">
                      for <code>{file}</code>
                    </span>
                  )}
                  {(folder ?? file) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setFolder(undefined);
                        setFile(undefined);
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  {graphView.data?.truncated && <Badge variant="outline">largest nodes only</Badge>}
                </div>
                {graphView.isPending && (
                  <p className="text-muted-foreground text-sm">Loading graph…</p>
                )}
                {graphView.data && (
                  <Suspense
                    fallback={<p className="text-muted-foreground text-sm">Loading the canvas…</p>}
                  >
                    <GraphCanvas
                      nodes={graphView.data.nodes}
                      edges={graphView.data.edges}
                      onSelect={openNode}
                    />
                  </Suspense>
                )}
                <p className="text-muted-foreground text-xs">
                  Red borders mark files in an import cycle; red animated edges import against the
                  layer direction. Click a module to open its files, a file to view its source.
                </p>
              </div>
            )}

            {tab === 'folders' && (
              <ul className="text-sm">
                <FolderTree
                  node={data.folders}
                  onOpen={(path) => {
                    setTab('graph');
                    setView('files');
                    setFolder(path || undefined);
                    setFile(undefined);
                  }}
                />
              </ul>
            )}

            {tab === 'routes' && (
              <div className="space-y-3 text-sm">
                {data.routes.length === 0 && (
                  <p className="text-muted-foreground">No routes detected.</p>
                )}
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1 pr-2">Method</th>
                      <th className="py-1 pr-2">Route</th>
                      <th className="py-1 pr-2">Handler</th>
                      <th className="py-1 pr-2">Middleware</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.map((r) => (
                      <tr key={`${r.method} ${r.route} ${r.path}:${r.line}`} className="border-b">
                        <td className="py-1 pr-2 font-mono">{r.method}</td>
                        <td className="py-1 pr-2 font-mono">{r.route}</td>
                        <td className="py-1 pr-2">
                          <button
                            type="button"
                            className="font-mono underline-offset-2 hover:underline"
                            onClick={() => {
                              setSelected({ path: r.path, line: r.line });
                            }}
                          >
                            {r.handler ? r.handler.split('#')[1] : `${r.path}:${r.line}`}
                          </button>
                        </td>
                        <td className="text-muted-foreground py-1 pr-2">
                          {r.middleware.join(', ')}
                        </td>
                        <td className="py-1">
                          {r.method !== 'USE' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setTraceRoute(`${r.method} ${r.route}`);
                              }}
                            >
                              Trace
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {trace.data && (
                  <section className="space-y-1" aria-label="Request trace">
                    <h3 className="font-medium">Request lifecycle: {traceRoute}</h3>
                    <ol className="space-y-0.5">
                      {trace.data.steps.map((step) => (
                        <li key={step.id} style={{ paddingLeft: step.depth * 16 }}>
                          <Badge variant="outline">{step.kind}</Badge>{' '}
                          <button
                            type="button"
                            className="font-mono underline-offset-2 hover:underline"
                            onClick={() => {
                              setSelected({ path: step.path, line: step.line });
                            }}
                          >
                            {step.label}
                          </button>
                          <span className="text-muted-foreground text-xs">
                            {' '}
                            {step.path}
                            {step.layer ? ` · ${step.layer}` : ''}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <p className="text-muted-foreground text-xs">
                      {trace.data.models.length > 0
                        ? `Reaches ${trace.data.models.map((m) => m.name).join(', ')}.`
                        : 'No data model reached.'}{' '}
                      {trace.data.truncated && 'Stopped at the depth limit. '}Follows name-resolved
                      calls only; framework glue and dynamic dispatch are not visible.
                    </p>
                  </section>
                )}
              </div>
            )}

            {tab === 'data' && (
              <ul className="space-y-1 text-sm">
                {data.models.length === 0 && (
                  <li className="text-muted-foreground">No data models or migrations detected.</li>
                )}
                {data.models.map((m) => (
                  <li key={`${m.path}-${m.name}`}>
                    <Badge variant={m.kind === 'model' ? 'default' : 'secondary'}>{m.kind}</Badge>{' '}
                    <button
                      type="button"
                      className="font-mono underline-offset-2 hover:underline"
                      onClick={() => {
                        setSelected({ path: m.path, line: m.line });
                      }}
                    >
                      {m.name}
                    </button>
                    <span className="text-muted-foreground text-xs">
                      {' '}
                      {m.orm} · {m.path}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'auth' && (
              <ul className="space-y-1 text-sm">
                {data.auth.length === 0 && (
                  <li className="text-muted-foreground">No authentication code detected.</li>
                )}
                {data.auth.map((a) => (
                  <li key={`${a.path}-${a.line}-${a.label}`}>
                    <Badge variant="outline">{a.kind}</Badge>{' '}
                    <button
                      type="button"
                      className="font-mono underline-offset-2 hover:underline"
                      onClick={() => {
                        setSelected({ path: a.path, line: a.line });
                      }}
                    >
                      {a.path}
                      {a.line ? `:${a.line}` : ''}
                    </button>
                    <span className="text-muted-foreground text-xs">
                      {' '}
                      {a.label} — {a.evidence}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'diff' && (
              <div className="space-y-2 text-sm">
                <label className="flex flex-col gap-1">
                  Compare with an earlier mapped commit (full SHA)
                  <input
                    className={inputClass}
                    value={diffFrom}
                    onChange={(e) => {
                      setDiffFrom(e.target.value.trim());
                    }}
                    placeholder="40-character commit SHA"
                  />
                </label>
                {diff.isError && (
                  <p role="alert">
                    No graph is stored for that commit. Map it first, then compare.
                  </p>
                )}
                {diff.data && (
                  <dl
                    className="grid grid-cols-2 gap-x-4 gap-y-1"
                    aria-label="Architecture changes"
                  >
                    <dt>Files</dt>
                    <dd>
                      +{diff.data.files.added.length} / −{diff.data.files.removed.length}
                    </dd>
                    <dt>Modules</dt>
                    <dd>
                      +{diff.data.modules.added.length} / −{diff.data.modules.removed.length}
                    </dd>
                    <dt>Imports</dt>
                    <dd>
                      +{diff.data.imports.added.length} / −{diff.data.imports.removed.length}
                    </dd>
                    <dt>Routes</dt>
                    <dd>
                      +{diff.data.routes.added.join(', ') || '0'} / −
                      {diff.data.routes.removed.join(', ') || '0'}
                    </dd>
                    <dt>Models</dt>
                    <dd>
                      +{diff.data.models.added.length} / −{diff.data.models.removed.length}
                    </dd>
                    <dt>Cycles</dt>
                    <dd>
                      {diff.data.cycles.introduced.length} introduced,{' '}
                      {diff.data.cycles.resolved.length} resolved
                    </dd>
                    <dt>Layer violations</dt>
                    <dd>
                      {diff.data.violations.before} → {diff.data.violations.after}
                    </dd>
                    <dt>Layer changes</dt>
                    <dd>
                      {diff.data.layerChanges
                        .map((c) => `${c.path}: ${c.from} → ${c.to}`)
                        .join('; ') || 'none'}
                    </dd>
                  </dl>
                )}
              </div>
            )}

            {selected && sha && (
              <SourceViewer
                fullName={fullName}
                sha={sha}
                path={selected.path}
                line={selected.line}
                onClose={() => {
                  setSelected(null);
                }}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
