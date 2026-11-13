import {
  MAX_PLAN_FILES,
  MAX_PLAN_TASKS,
  type ArchitectureGraph,
  type Layer,
  type PlanFile,
  type PlanTask,
} from '@repointelligence/shared';
import { moduleOf } from '../graph/views.js';
import { normalizeRoute } from '../ingest/openapi.js';

/** What a model (or the files-only fallback) proposes, before anything is checked. */
export interface ProposedTask {
  title: string;
  description: string | null;
  files: { path: string; change: 'modify' | 'create'; reason: string | null }[];
  api: { method: string; route: string }[];
  models: string[];
}

/** Lookups over the ingested commit that every check shares. */
export interface RepoIndex {
  paths: Set<string>;
  directories: Set<string>;
  graph: ArchitectureGraph | null;
  /** Repository files each file imports. */
  imports: Map<string, Set<string>>;
}

const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.java$/;
const TEST_FOLDER = /(^|\/)(__tests__|tests?|spec)\//;
const SAFE_PATH = /^[\w@.()[\]+ -]+(\/[\w@.()[\]+ -]+)*$/;
/** Things lower in the stack are changed first when the import graph does not decide. */
const LAYER_RANK: Record<Layer, number> = { config: 0, data: 1, integration: 2, service: 3, presentation: 4, other: 5, test: 6 }; // prettier-ignore

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);
const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');
const baseOf = (path: string): string => path.split('/').pop() ?? path;

export function indexRepo(paths: string[], graph: ArchitectureGraph | null): RepoIndex {
  const directories = new Set<string>(['']);
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const imports = new Map<string, Set<string>>();
  for (const edge of graph?.imports ?? []) {
    if (!edge.to) continue;
    const set = imports.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    imports.set(edge.from, set);
  }
  return { paths: new Set(paths), directories, graph, imports };
}

/** The layer of a file, or for a new file the commonest layer among its future neighbours. */
function layerOf(path: string, index: RepoIndex): Layer | null {
  const files = index.graph?.files ?? [];
  const known = files.find((f) => f.path === path);
  if (known) return known.layer;
  const counts = new Map<Layer, number>();
  for (const f of files) {
    if (dirOf(f.path) === dirOf(path)) counts.set(f.layer, (counts.get(f.layer) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export interface Verified {
  tasks: (Omit<ProposedTask, 'files'> & { files: PlanFile[] })[];
  dropped: { tasks: number; files: number };
}

/**
 * Keeps only what matches the repository: files to modify must exist, new files must sit in a
 * directory that exists, and a task left without files is dropped. Counts what was removed.
 */
export function verifyProposal(proposed: ProposedTask[], index: RepoIndex): Verified {
  const dropped = { tasks: Math.max(0, proposed.length - MAX_PLAN_TASKS), files: 0 };
  const tasks: Verified['tasks'] = [];
  let budget = MAX_PLAN_FILES;
  for (const task of proposed.slice(0, MAX_PLAN_TASKS)) {
    const files: PlanFile[] = [];
    const seen = new Set<string>();
    for (const f of task.files) {
      const path = f.path.trim().replace(/^\.?\//, '');
      const exists = index.paths.has(path);
      const placeable = SAFE_PATH.test(path) && !path.split('/').includes('..') && path.length <= 200 && index.directories.has(dirOf(path));
      if (seen.has(path) || budget === 0 || (!exists && (f.change === 'modify' || !placeable))) {
        dropped.files += 1;
        continue;
      }
      seen.add(path);
      budget -= 1;
      const known = index.graph?.files.find((g) => g.path === path);
      files.push({
        path,
        // A "new" file that already exists is a change to that file.
        change: exists ? 'modify' : 'create',
        module: moduleOf(path),
        layer: layerOf(path, index),
        lines: known?.lines ?? null,
        importedBy: known?.importedBy ?? null,
        reason: f.reason,
      });
    }
    if (files.length === 0) dropped.tasks += 1;
    else tasks.push({ ...task, files });
  }
  return { tasks, dropped };
} // prettier-ignore

/**
 * Orders tasks so that a task comes after the tasks whose files its own files import. Where the
 * import graph has nothing to say, lower layers go first, then the proposed order.
 */
export function orderTasks<T extends { files: PlanFile[] }>(tasks: T[], index: RepoIndex): { task: T; dependsOn: number[] }[] {
  const owner = new Map<string, number>();
  for (const [i, t] of tasks.entries()) {
    for (const f of t.files) owner.set(f.path, i);
  }
  const deps = tasks.map((t, i) => {
    const set = new Set<number>();
    for (const f of t.files) {
      for (const imported of index.imports.get(f.path) ?? []) {
        const j = owner.get(imported);
        if (j !== undefined && j !== i) set.add(j);
      }
    }
    return set;
  });
  const at = (i: number): T => {
    const task = tasks[i];
    if (!task) throw new Error('task index out of range');
    return task;
  };
  const rank = (t: T) => Math.min(...t.files.map((f) => LAYER_RANK[f.layer ?? 'other']));
  const placed: number[] = [];
  const remaining = new Set(tasks.map((_, i) => i));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((i) => [...(deps[i] ?? [])].every((d) => !remaining.has(d)));
    // A cycle between tasks leaves nothing ready; the lowest layer breaks it.
    const pool = ready.length > 0 ? ready : [...remaining];
    pool.sort((a, b) => rank(at(a)) - rank(at(b)) || a - b);
    const [next] = pool;
    if (next === undefined) break;
    placed.push(next);
    remaining.delete(next);
  }
  return placed.map((i) => ({
    task: at(i),
    dependsOn: [...(deps[i] ?? [])].filter((d) => placed.indexOf(d) < placed.indexOf(i)),
  }));
} // prettier-ignore

/** How this repository names its tests, learned from the tests it already has. */
function newTestPath(path: string, index: RepoIndex): string {
  const dir = dirOf(path);
  const base = baseOf(path);
  const stem = base.replace(/\.[^.]+$/, '');
  const ext = base.slice(stem.length);
  const tests = [...index.paths].filter(isTestPath);
  if (ext === '.py') {
    const folder = tests.find((t) => /(^|\/)tests?\//.test(t));
    return folder ? `${dirOf(folder)}/test_${stem}.py` : `${dir ? `${dir}/` : ''}test_${stem}.py`;
  }
  if (ext === '.go') return `${dir ? `${dir}/` : ''}${stem}_test.go`;
  if (ext === '.java') return path.replace('/main/', '/test/').replace(/\.java$/, 'Test.java');
  const spec = tests.filter((t) => t.includes('.spec.')).length > tests.filter((t) => t.includes('.test.')).length;
  const inFolder = tests.filter((t) => t.includes('__tests__/')).length > tests.length / 2;
  const name = `${stem}.${spec ? 'spec' : 'test'}${ext}`;
  return [dir, inFolder ? '__tests__' : '', name].filter(Boolean).join('/');
} // prettier-ignore

/** The test file to extend, or the path a new one would take, for each source file of a task. */
export function suggestTests(files: PlanFile[], index: RepoIndex): PlanTask['tests'] {
  const out: PlanTask['tests'] = [];
  for (const f of files) {
    if (isTestPath(f.path)) {
      out.push({ path: f.path, exists: f.change === 'modify', note: 'This task changes the tests themselves.' });
      continue;
    }
    if (!/\.([cm]?[jt]sx?|py|go|java)$/.test(f.path)) continue;
    const stem = baseOf(f.path).replace(/\.[^.]+$/, '');
    const names = new Set([`${stem}.test`, `${stem}.spec`, `test_${stem}`, `${stem}_test`, `${stem}Test`]);
    const existing = [...index.paths]
      // A test beside another file of the same name belongs to that file, not this one.
      .filter((p) => dirOf(p) === dirOf(f.path) || TEST_FOLDER.test(p))
      .filter((p) => isTestPath(p) && names.has(baseOf(p).replace(/\.[^.]+$/, '')))
      .sort((a, b) => Number(dirOf(b) === dirOf(f.path)) - Number(dirOf(a) === dirOf(f.path)))[0];
    out.push(
      existing
        ? { path: existing, exists: true, note: `Extend the existing tests for ${baseOf(f.path)}.` }
        : { path: newTestPath(f.path, index), exists: false, note: `${baseOf(f.path)} has no test file; add one.` },
    );
  }
  return out.filter((t, i) => out.findIndex((x) => x.path === t.path) === i);
} // prettier-ignore

/** Routes and models a task names, matched against what the graph detected. */
export function matchInterfaces(task: Pick<ProposedTask, 'api' | 'models'>, graph: ArchitectureGraph | null) {
  const api: PlanTask['api'] = task.api.slice(0, 10).map((a) => {
    const method = a.method.toUpperCase();
    const found = graph?.routes.find((r) => r.method.toUpperCase() === method && normalizeRoute(r.route) === normalizeRoute(a.route));
    return found
      ? { method, route: found.route, change: 'existing', path: found.path, line: found.line || null }
      : { method, route: a.route, change: 'new' };
  });
  const database: PlanTask['database'] = task.models.slice(0, 10).map((name) => {
    const found = graph?.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
    return found ? { model: found.name, change: 'existing', path: found.path } : { model: name, change: 'new', path: null };
  });
  return { api, database };
} // prettier-ignore

const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * Effort and risk from fixed rules over the files: size, how many files depend on them, whether
 * tests exist, and whether routes, models or authentication are touched.
 */
export function estimate(
  files: PlanFile[],
  tests: PlanTask['tests'],
  interfaces: Pick<PlanTask, 'api' | 'database'>,
  graph: ArchitectureGraph | null,
): Pick<PlanTask, 'risk' | 'effort'> {
  let low = 0;
  let high = 0;
  const reasons: string[] = [];
  let level = 0;
  const raise = (to: number, reason: string) => {
    level = Math.max(level, to);
    reasons.push(reason);
  };
  const authPaths = new Set(graph?.auth.map((a) => a.path));
  for (const f of files) {
    if (f.change === 'create') {
      low += 1;
      high += 4;
      continue;
    }
    low += 1;
    high += 3;
    if ((f.lines ?? 0) > 300) {
      low += 1;
      high += 2;
      raise(1, `${f.path} is ${f.lines} lines long`);
    }
    const dependants = f.importedBy ?? 0;
    if (dependants >= 10) raise(2, `${dependants} files import ${f.path}`);
    else if (dependants >= 3) raise(1, `${dependants} files import ${f.path}`);
    if (dependants >= 3) {
      low += 1;
      high += 2;
    }
    if (authPaths.has(f.path)) raise(2, `${f.path} handles authentication`);
  }
  const untested = tests.filter((t) => !t.exists).length;
  low += tests.length * 0.5;
  high += tests.length * 1.5;
  if (untested > 0 && files.some((f) => f.change === 'modify')) raise(1, `${untested} changed files have no tests yet`);
  if (interfaces.api.some((a) => a.change === 'existing')) raise(1, 'changes an existing API route that callers may rely on');
  if (interfaces.database.some((d) => d.change === 'existing')) raise(2, 'changes an existing data model, which may need a migration');
  else if (interfaces.database.length > 0) raise(1, 'adds a data model');
  return {
    risk: { level: (['low', 'medium', 'high'] as const)[level] ?? 'low', reasons },
    effort: { low: round(low), high: round(high) },
  };
} // prettier-ignore

/** Runs every check and rule over a proposal and returns tasks ready to store. */
export function buildTasks(proposed: ProposedTask[], index: RepoIndex): { tasks: PlanTask[]; dropped: Verified['dropped'] } {
  const { tasks: verified, dropped } = verifyProposal(proposed, index);
  const ordered = orderTasks(verified, index);
  const ids = new Map(ordered.map((o, i) => [verified.indexOf(o.task), `task-${i + 1}`] as const));
  const tasks = ordered.map(({ task, dependsOn }, i): PlanTask => {
    const tests = suggestTests(task.files, index);
    const interfaces = matchInterfaces(task, index.graph);
    return {
      id: `task-${i + 1}`,
      order: i + 1,
      title: task.title,
      description: task.description,
      files: task.files,
      dependsOn: dependsOn.map((d) => ids.get(d) ?? '').filter(Boolean),
      ...interfaces,
      tests,
      ...estimate(task.files, tests, interfaces, index.graph),
      done: false,
    };
  });
  return { tasks, dropped };
} // prettier-ignore
