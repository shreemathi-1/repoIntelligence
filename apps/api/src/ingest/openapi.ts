import { parse as parseYaml } from 'yaml';
import type { OpenApiDoc, OpenApiEndpoint } from './types.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Parses an OpenAPI 3.x or Swagger 2.0 document. Returns null if the text is not one. */
export function parseOpenApi(source: string, path: string): OpenApiDoc | null {
  let doc: unknown;
  try {
    // YAML is a superset of JSON, and the parser caps alias expansion.
    doc = parseYaml(source, { maxAliasCount: 50 });
  } catch {
    return null;
  }
  if (!isObject(doc)) return null;

  const specVersion = text(doc.openapi) ?? text(doc.swagger);
  if (!specVersion || !isObject(doc.paths)) return null;

  const endpoints: OpenApiEndpoint[] = [];
  for (const [route, item] of Object.entries(doc.paths)) {
    if (!isObject(item)) continue;
    const shared: unknown[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const own: unknown[] = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own];
      endpoints.push({
        method: method.toUpperCase(),
        path: route,
        summary: text(op.summary) ?? text(op.description),
        operationId: text(op.operationId),
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string')
          : [],
        parameters: params.flatMap((p) =>
          isObject(p) && typeof p.name === 'string'
            ? [{ name: p.name, in: text(p.in) ?? 'query', required: p.required === true }]
            : [],
        ),
        responses: isObject(op.responses) ? Object.keys(op.responses) : [],
      });
    }
  }

  const info = isObject(doc.info) ? doc.info : {};
  const components = isObject(doc.components) ? doc.components : {};
  const schemas = isObject(components.schemas)
    ? components.schemas
    : isObject(doc.definitions)
      ? doc.definitions
      : {};
  const servers = Array.isArray(doc.servers)
    ? doc.servers.flatMap((s) => (isObject(s) && typeof s.url === 'string' ? [s.url] : []))
    : typeof doc.host === 'string'
      ? [`${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`]
      : [];

  return {
    path,
    specVersion,
    title: text(info.title),
    version: text(info.version),
    servers,
    endpoints,
    schemaCount: Object.keys(schemas).length,
  };
}

/** Normalises `:id` and `{id}` so a documented route can be compared with the spec. */
export function normalizeRoute(route: string): string {
  return route
    .replace(/\/+$/, '')
    .replace(/:([A-Za-z_]\w*)/g, '{$1}')
    .replace(/\{[^}]+\}/g, '{}')
    .toLowerCase();
}
