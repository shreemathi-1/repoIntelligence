import type { ArchitectureGraph } from '@repointelligence/shared';

const file = (
  path: string,
  layer: ArchitectureGraph['files'][number]['layer'],
  lines = 40,
  symbols = 2,
) => ({
  path,
  language: 'typescript' as const,
  lines,
  layer,
  symbols,
  imports: 0,
  importedBy: 0,
});
const imp = (from: string, to: string | null, external: string | null = null, line = 1) => ({
  from,
  to,
  external,
  line,
  names: [],
  via: null,
});
const sym = (path: string, name: string, kind: 'function' | 'class' = 'function', line = 1) => ({
  id: `${path}#${name}`,
  path,
  name,
  qualifiedName: name,
  kind,
  line,
  endLine: line + 5,
  exported: true,
});

/** A small Express service with one cycle, one layer violation and a traced route. */
export function fixtureGraph(): ArchitectureGraph {
  return {
    files: [
      file('src/index.ts', 'other', 20, 0),
      file('src/routes/orders.ts', 'presentation'),
      file('src/services/orders.ts', 'service'),
      file('src/models/order.ts', 'data'),
      file('src/clients/mailer.ts', 'integration', 10, 1),
      file('src/middleware/auth.ts', 'service', 15, 1),
    ],
    externals: ['express', 'mongoose', 'jsonwebtoken'],
    imports: [
      imp('src/index.ts', 'src/routes/orders.ts'),
      imp('src/index.ts', 'src/middleware/auth.ts'),
      imp('src/index.ts', null, 'express'),
      imp('src/routes/orders.ts', 'src/services/orders.ts'),
      imp('src/services/orders.ts', 'src/models/order.ts'),
      imp('src/services/orders.ts', 'src/clients/mailer.ts'),
      imp('src/models/order.ts', 'src/services/orders.ts', null, 2),
      imp('src/models/order.ts', null, 'mongoose'),
      imp('src/middleware/auth.ts', null, 'jsonwebtoken'),
    ],
    symbols: [
      sym('src/routes/orders.ts', 'listOrders', 'function', 5),
      sym('src/routes/orders.ts', 'createOrder', 'function', 6),
      sym('src/services/orders.ts', 'findAll', 'function', 3),
      sym('src/services/orders.ts', 'save', 'function', 8),
      sym('src/models/order.ts', 'Order', 'class', 4),
      sym('src/models/order.ts', 'BaseEntity', 'class', 1),
      sym('src/clients/mailer.ts', 'notify', 'function', 1),
      sym('src/middleware/auth.ts', 'requireAuth', 'function', 3),
    ],
    relations: [
      {
        from: 'src/routes/orders.ts#listOrders',
        to: 'src/services/orders.ts#findAll',
        kind: 'call',
        line: 5,
        resolution: 'import',
      },
      {
        from: 'src/routes/orders.ts#createOrder',
        to: 'src/services/orders.ts#save',
        kind: 'call',
        line: 6,
        resolution: 'import',
      },
      {
        from: 'src/services/orders.ts#save',
        to: 'src/clients/mailer.ts#notify',
        kind: 'call',
        line: 9,
        resolution: 'import',
      },
      {
        from: 'src/models/order.ts#Order',
        to: 'src/models/order.ts#BaseEntity',
        kind: 'extends',
        line: 4,
        resolution: 'name',
      },
    ],
    entryPoints: [
      {
        kind: 'entry',
        path: 'src/index.ts',
        line: 1,
        label: 'index.ts',
        evidence: 'conventional entry file name',
      },
    ],
    routes: [
      {
        method: 'GET',
        route: '/orders',
        path: 'src/routes/orders.ts',
        line: 5,
        framework: 'express',
        handler: 'src/routes/orders.ts#listOrders',
        middleware: [],
      },
      {
        method: 'POST',
        route: '/orders',
        path: 'src/routes/orders.ts',
        line: 6,
        framework: 'express',
        handler: 'src/routes/orders.ts#createOrder',
        middleware: ['requireAuth'],
      },
      {
        method: 'USE',
        route: '/api',
        path: 'src/index.ts',
        line: 6,
        framework: 'express',
        handler: null,
        middleware: ['requireAuth', 'router'],
      },
    ],
    models: [
      { name: 'Order', path: 'src/models/order.ts', line: 4, orm: 'mongoose', kind: 'model' },
    ],
    auth: [
      {
        kind: 'jwt',
        path: 'src/middleware/auth.ts',
        line: 1,
        label: 'jsonwebtoken',
        evidence: 'imports jsonwebtoken',
      },
    ],
    stack: [
      { name: 'TypeScript', category: 'language', version: null, evidence: '6 source file(s)' },
      { name: 'Express', category: 'framework', version: '5.0.0', evidence: 'package.json' },
    ],
    layerViolations: [
      {
        from: 'src/models/order.ts',
        to: 'src/services/orders.ts',
        fromLayer: 'data',
        toLayer: 'service',
        line: 2,
      },
    ],
    cycles: [['src/models/order.ts', 'src/services/orders.ts']],
    stats: {
      filesParsed: 6,
      filesSkipped: 0,
      parseErrors: 0,
      truncated: false,
      callEdgesTruncated: false,
      durationMs: 12,
    },
  };
}
