import { describe, expect, it } from 'vitest';
import {
  graphDiffSchema,
  graphSummarySchema,
  graphViewResponseSchema,
  traceResponseSchema,
} from '@repointelligence/shared';
import { fixtureGraph } from '../../test/fixtures/graph.js';
import { architectureSignalsOf } from '../analysis/architecture-signals.js';
import { computeHealth } from '../analysis/scoring.js';
import { healthyInputs, NOW } from '../../test/fixtures/analysis.js';
import { diffGraphs } from './diff.js';
import { DIAGRAMS, mermaidId } from './mermaid.js';
import { traceRoute } from './trace.js';
import { buildFolders, buildView, moduleOf, purposeOf } from './views.js';

const identity = { fullName: 'acme/shop', sha: 'a'.repeat(40) };

describe('views', () => {
  it('groups files into modules and aggregates import weights, flagging cycles and violations', () => {
    const view = graphViewResponseSchema.parse(
      buildView(fixtureGraph(), { view: 'modules' }, identity),
    );
    expect(view.nodes.map((n) => n.id).sort()).toEqual(
      ['src/clients', 'src/middleware', 'src/models', 'src/routes', 'src/services', 'src'].sort(),
    );
    const models = view.nodes.find((n) => n.id === 'src/models');
    expect(models).toMatchObject({ layer: 'data', inCycle: true, size: 1 });
    const violation = view.edges.find((e) => e.from === 'src/models' && e.to === 'src/services');
    expect(violation).toMatchObject({ violation: true, weight: 1 });
    expect(view.truncated).toBe(false);
  });

  it('shows files under a folder with their imports', () => {
    const view = buildView(fixtureGraph(), { view: 'files', folder: 'src' }, identity);
    expect(view.nodes).toHaveLength(6);
    expect(view.nodes.find((n) => n.id === 'src/routes/orders.ts')).toMatchObject({
      label: 'routes/orders.ts',
      layer: 'presentation',
    });
    expect(
      view.edges.some((e) => e.from === 'src/index.ts' && e.to === 'src/routes/orders.ts'),
    ).toBe(true);
    // External imports are not file edges.
    expect(view.edges.every((e) => e.to.includes('/'))).toBe(true);
  });

  it("shows one file's symbols with their callers and callees", () => {
    const view = buildView(
      fixtureGraph(),
      { view: 'symbols', file: 'src/services/orders.ts' },
      identity,
    );
    const ids = new Set(view.nodes.map((n) => n.id));
    expect(ids).toContain('src/services/orders.ts#save');
    expect(ids).toContain('src/clients/mailer.ts#notify');
    expect(ids).toContain('src/routes/orders.ts#listOrders');
    expect(view.edges.map((e) => e.kind)).toContain('call');
    expect(view.nodes.find((n) => n.id === 'src/services/orders.ts#save')?.label).toBe('save');
  });

  it('maps paths to modules and purposes', () => {
    expect(moduleOf('src/routes/orders.ts')).toBe('src/routes');
    expect(moduleOf('routes/orders.ts')).toBe('routes');
    expect(moduleOf('packages/shared/src/x.ts')).toBe('packages/shared/src');
    expect(moduleOf('index.ts')).toBe('(root)');
    expect(purposeOf('src/routes', 'presentation')).toBe('HTTP routes and request handlers');
    expect(purposeOf('weird', 'service')).toBe('Mostly service code');
    expect(purposeOf('weird', 'other')).toBeNull();
  });

  it('builds a folder tree with sizes, layers and purposes', () => {
    const folders = buildFolders(fixtureGraph());
    expect(folders.files).toBe(6);
    const src = folders.children[0];
    expect(src?.name).toBe('src');
    const routes = src?.children.find((c) => c.name === 'routes');
    expect(routes).toMatchObject({
      files: 1,
      layer: 'presentation',
      purpose: 'HTTP routes and request handlers',
    });
  });
});

describe('mermaid', () => {
  const graph = fixtureGraph();

  it('renders each diagram as valid flowchart text with escaped labels', () => {
    for (const [name, render] of Object.entries(DIAGRAMS)) {
      const text = render(graph);
      expect(text.startsWith('flowchart '), name).toBe(true);
      expect(text).not.toMatch(/[^#]"[^"\n]*"[^"\n]*"[^\n]*\]/);
    }
    expect(mermaidId('src/routes/orders.ts')).toBe('n_src_routes_orders_ts');
  });

  it('shows modules with weights, routes with handlers and layers with dotted violations', () => {
    expect(DIAGRAMS.modules(graph)).toContain('n_src_routes -->|1| n_src_services');
    expect(DIAGRAMS.routes(graph)).toContain('"GET /orders"');
    expect(DIAGRAMS.routes(graph)).toContain('listOrders (src/routes/orders.ts)');
    expect(DIAGRAMS.layers(graph)).toContain('n_data -.->|1| n_service');
    expect(DIAGRAMS.models(graph)).toContain('Order · mongoose');
    expect(DIAGRAMS.auth(graph)).toContain('jwt: jsonwebtoken');
  });

  it('says so when there is nothing to draw', () => {
    const empty = { ...graph, routes: [], auth: [], models: [] };
    expect(DIAGRAMS.routes(empty)).toContain('No routes detected');
    expect(DIAGRAMS.auth(empty)).toContain('No authentication code detected');
    expect(DIAGRAMS.models(empty)).toContain('No data models detected');
  });
});

describe('trace', () => {
  it('follows a route through middleware and calls to the model it reaches', () => {
    const trace = traceResponseSchema.parse(traceRoute(fixtureGraph(), 'POST /orders', 5));
    expect(trace.route?.handler).toBe('src/routes/orders.ts#createOrder');
    expect(trace.steps.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'route:POST /orders',
      'middleware:requireAuth',
      'call:createOrder',
      'call:save',
      'call:notify',
    ]);
    expect(trace.approximate).toBe(true);
    expect(trace.truncated).toBe(false);
  });

  it('stops at the requested depth and reports truncation', () => {
    const trace = traceRoute(fixtureGraph(), 'GET /orders', 1);
    expect(trace.steps.map((s) => s.label)).toEqual(['GET /orders', 'listOrders']);
    expect(trace.truncated).toBe(true);
  });

  it('accepts a handler id and answers an unknown route with no steps', () => {
    expect(
      traceRoute(fixtureGraph(), 'src/services/orders.ts#save', 3).steps.map((s) => s.label),
    ).toEqual(['save', 'notify']);
    const none = traceRoute(fixtureGraph(), 'DELETE /nothing', 3);
    expect(none.route).toBeNull();
    expect(none.steps).toEqual([]);
  });
});

describe('diff', () => {
  it('reports what changed between two graphs', () => {
    const before = fixtureGraph();
    const after = fixtureGraph();
    after.files.push({
      path: 'src/services/reports.ts',
      language: 'typescript',
      lines: 30,
      layer: 'service',
      symbols: 1,
      imports: 0,
      importedBy: 0,
    });
    after.imports.push({
      from: 'src/routes/orders.ts',
      to: 'src/services/reports.ts',
      external: null,
      line: 2,
      names: [],
      via: null,
    });
    after.imports = after.imports.filter(
      (e) => !(e.from === 'src/models/order.ts' && e.to === 'src/services/orders.ts'),
    );
    after.cycles = [];
    after.layerViolations = [];
    after.routes.push({
      method: 'GET',
      route: '/reports',
      path: 'src/routes/orders.ts',
      line: 9,
      framework: 'express',
      handler: null,
      middleware: [],
    });
    after.files = after.files.map((f) =>
      f.path === 'src/clients/mailer.ts' ? { ...f, layer: 'service' } : f,
    );
    const diff = graphDiffSchema.parse(
      diffGraphs(before, after, { from: 'a'.repeat(40), to: 'b'.repeat(40) }),
    );
    expect(diff.files).toEqual({ added: ['src/services/reports.ts'], removed: [] });
    expect(diff.imports.added).toEqual([
      { from: 'src/routes/orders.ts', to: 'src/services/reports.ts' },
    ]);
    expect(diff.imports.removed).toEqual([
      { from: 'src/models/order.ts', to: 'src/services/orders.ts' },
    ]);
    expect(diff.cycles).toEqual({
      introduced: [],
      resolved: [['src/models/order.ts', 'src/services/orders.ts']],
    });
    expect(diff.routes.added).toEqual(['GET /reports']);
    expect(diff.layerChanges).toEqual([
      { path: 'src/clients/mailer.ts', from: 'integration', to: 'service' },
    ]);
    expect(diff.violations).toEqual({ before: 1, after: 0 });
    expect(diff.modules.added).toEqual([]);
  });
});

describe('architecture signals feed the health score', () => {
  it('reduces a graph to signals and scores the architecture area', () => {
    const signals = architectureSignalsOf(fixtureGraph());
    expect(signals).toMatchObject({
      files: 6,
      cycles: 1,
      filesInCycles: 2,
      layerViolations: 1,
      internalImports: 6,
    });
    expect(signals?.topFanInShare).toBeCloseTo(0.333, 2);
    expect(signals?.layeredShare).toBeCloseTo(0.833, 2);
    const score = computeHealth({ ...healthyInputs(), architecture: signals }, NOW);
    const area = score.areas.find((a) => a.id === 'architecture');
    expect(area?.score).not.toBeNull();
    expect(area?.confidence).toBe(1);
    expect(area?.metrics.find((m) => m.id === 'architecture.cycles')).toMatchObject({
      status: 'measured',
      value: 33.3,
    });
    expect(architectureSignalsOf({ nonsense: true })).toBeNull();
    expect(graphSummarySchema).toBeDefined();
  });
});
