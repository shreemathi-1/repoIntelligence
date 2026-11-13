import type { Evidence, Modification, Runtime, Warning } from '@repointelligence/shared';
import { FRAMEWORKS, frameworkKey } from '../catalog.js';
import { profileEvidence, unavailable, type BreakingReason, type Check } from '../types.js';
import { majorOf, overlaps, satisfies, type VersionScheme } from '../versions.js';

const RUNTIME_NAMES: Record<Runtime, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
};
const MAX_DEPENDENCY_WARNINGS = 15;
const average = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/** Language and runtime: what each manifest asks for against the versions the user runs. */
export const runtimeCheck: Check = ({ requirements }, profile) => {
  if (requirements.runtimes.length === 0) {
    return unavailable('runtime', 'No manifest declares a language runtime.');
  }
  const scores: number[] = [];
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const breaking: BreakingReason[] = [];
  const evidence: Evidence[] = [];
  const parts: string[] = [];

  for (const req of requirements.runtimes) {
    const name = RUNTIME_NAMES[req.runtime];
    const mine = profile.runtimes[req.runtime];
    const wants = req.range === '*' ? name : `${name} ${req.range}`;
    evidence.push(...req.evidence);
    if (!mine) {
      scores.push(20);
      parts.push(`${wants} is not in your stack`);
      warnings.push({ id: `runtime-missing-${req.runtime}`, dimension: 'runtime', severity: 'major', message: `The repository needs ${wants}; your stack lists no ${name} runtime.`, evidence: req.evidence });
      modifications.push({ id: `runtime-add-${req.runtime}`, dimension: 'runtime', title: `Add a ${name} runtime`, detail: `Install ${wants}, or run the repository as its own service or container next to your stack.`, hours: { low: 2, high: 8 }, evidence: req.evidence });
      continue;
    }
    const yours = profileEvidence(`Your stack runs ${name} ${mine}`);
    if (req.range === '*') {
      scores.push(100);
      parts.push(`${name} is in your stack (no version declared)`);
      continue;
    }
    // Pins are already written as semver ranges; declared ranges use the ecosystem's own syntax.
    const ok = satisfies(req.pinned ? 'node' : req.runtime, mine, req.range);
    if (ok === null) {
      parts.push(`${wants} could not be compared with ${mine}`);
      warnings.push({ id: `runtime-unknown-${req.runtime}`, dimension: 'runtime', severity: 'info', message: `The ${name} requirement "${req.range}" could not be compared with your ${mine}; check it by hand.`, evidence: [...req.evidence, yours] });
    } else if (ok) {
      scores.push(100);
      parts.push(`${name} ${mine} satisfies ${req.range}`);
    } else if (req.pinned) {
      scores.push(70);
      parts.push(`pinned to ${name} ${req.range}, you run ${mine}`);
      warnings.push({ id: `runtime-pin-${req.runtime}`, dimension: 'runtime', severity: 'minor', message: `The repository is pinned to ${name} ${req.range} and declares no supported range; you run ${mine}.`, evidence: [...req.evidence, yours] });
      modifications.push({ id: `runtime-test-${req.runtime}`, dimension: 'runtime', title: `Test on ${name} ${mine}`, detail: `Only ${req.range} is known to work. Run the test suite on your version before adopting.`, hours: { low: 1, high: 4 }, evidence: req.evidence });
    } else {
      scores.push(35);
      parts.push(`${name} ${mine} does not satisfy ${req.range}`);
      const reason = `${name} ${mine} does not satisfy the required ${req.range}`;
      warnings.push({ id: `runtime-version-${req.runtime}`, dimension: 'runtime', severity: 'major', message: `The repository requires ${name} ${req.range}; you run ${mine}.`, evidence: [...req.evidence, yours] });
      modifications.push({ id: `runtime-upgrade-${req.runtime}`, dimension: 'runtime', title: `Move to ${name} ${req.range}`, detail: `Change your ${name} version from ${mine} to one that satisfies ${req.range}, or run the repository in its own container.`, hours: { low: 4, high: 16 }, evidence: req.evidence });
      breaking.push({ text: reason, evidence: [...req.evidence, yours] });
    }
  }
  if (scores.length === 0) return { ...unavailable('runtime', parts.join('; ')), warnings };
  return { dimension: { id: 'runtime', status: 'measured', score: average(scores), summary: parts.join('; '), evidence }, warnings, modifications, breaking };
}; // prettier-ignore

/** Shared dependencies whose version ranges cannot be met by one installed version. */
export const dependencyCheck: Check = (detected, profile) => {
  const { manifests } = detected;
  if (profile.dependencies.length === 0) {
    return unavailable('dependencies', 'Add your own dependencies to the profile to check for version conflicts.');
  }
  if (manifests.length === 0) return unavailable('dependencies', 'No dependency manifest was found.');
  const mine = new Map<string, (typeof profile.dependencies)[number]>(profile.dependencies.map((d) => [`${d.ecosystem}:${d.name.toLowerCase()}`, d]));
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const breaking: BreakingReason[] = [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  let shared = 0, major = 0, minor = 0, unknown = 0;

  for (const manifest of manifests) {
    const scheme: VersionScheme = manifest.ecosystem;
    for (const dep of manifest.dependencies) {
      const key = `${manifest.ecosystem}:${dep.name.toLowerCase()}`;
      const yours = mine.get(key);
      if (dep.scope === 'dev' || !yours || seen.has(key)) continue;
      seen.add(key);
      shared += 1;
      const ok = overlaps(scheme, dep.spec, yours.version);
      if (ok === null) unknown += 1;
      if (ok !== false) continue;
      const found = detected.dependencyEvidence(manifest, dep.name);
      const where = [found, profileEvidence(`Your stack uses ${dep.name} ${yours.version}`)];
      const a = majorOf(scheme, dep.spec);
      const b = majorOf(scheme, yours.version);
      const isMajor = a === null || b === null || a !== b;
      if (isMajor) major += 1;
      else minor += 1;
      evidence.push(found);
      if (warnings.length < MAX_DEPENDENCY_WARNINGS) {
        warnings.push({ id: `dependency-${dep.name}`, dimension: 'dependencies', severity: isMajor ? 'major' : 'minor', message: `${dep.name}: the repository needs ${dep.spec}, your stack has ${yours.version}. No single version satisfies both.`, evidence: where });
        modifications.push({ id: `dependency-align-${dep.name}`, dimension: 'dependencies', title: `Align ${dep.name}`, detail: `Move your ${dep.name} from ${yours.version} to a version in ${dep.spec}, or isolate the repository so both versions can be installed.`, hours: isMajor ? { low: 2, high: 8 } : { low: 0.5, high: 2 }, evidence: where });
      }
      if (isMajor) breaking.push({ text: `${dep.name} differs by a major version (${dep.spec} against ${yours.version})`, evidence: where });
    }
  }
  const summary =
    shared === 0
      ? 'You share no dependencies with the repository, so there are no version conflicts.'
      : `${shared} shared dependencies: ${major} major conflicts, ${minor} minor conflicts${unknown ? `, ${unknown} that could not be compared` : ''}.`;
  const score = Math.max(10, 100 - major * 25 - minor * 10);
  return { dimension: { id: 'dependencies', status: 'measured', score, summary, evidence }, warnings, modifications, breaking };
}; // prettier-ignore

const roleOf = (name: string) =>
  FRAMEWORKS.find((f) => frameworkKey(f.name) === frameworkKey(name))?.role ?? null;
const clash = (a: string | null, b: string | null): boolean =>
  a !== null &&
  b !== null &&
  (a === b || (a === 'fullstack' && b === 'server') || (a === 'server' && b === 'fullstack'));

/** Frameworks the repository is built on against the ones the user already runs. */
export const frameworkCheck: Check = ({ requirements }, profile) => {
  if (profile.frameworks.length === 0) return unavailable('framework', 'List your frameworks in the profile to compare them.');
  if (requirements.frameworks.length === 0) {
    return { dimension: { id: 'framework', status: 'measured', score: 100, summary: 'No framework was detected, so the code is not tied to one.', evidence: [] }, warnings: [], modifications: [] };
  }
  const scores: number[] = [];
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const breaking: BreakingReason[] = [];
  const parts: string[] = [];

  for (const fw of requirements.frameworks) {
    const same = profile.frameworks.find((f) => frameworkKey(f.name) === frameworkKey(fw.name));
    if (same) {
      const theirs = fw.version ? majorOf('npm', fw.version) : null;
      const yours = same.version ? Number(same.version.split('.')[0]) : null;
      if (theirs !== null && yours !== null && theirs !== yours) {
        const where = [...fw.evidence, profileEvidence(`Your stack uses ${same.name} ${same.version ?? ''}`.trim())];
        scores.push(50);
        parts.push(`${fw.name} ${theirs} against your ${yours}`);
        warnings.push({ id: `framework-version-${frameworkKey(fw.name)}`, dimension: 'framework', severity: 'major', message: `The repository is built for ${fw.name} ${fw.version ?? theirs}; you use ${fw.name} ${same.version ?? yours}.`, evidence: where });
        modifications.push({ id: `framework-migrate-${frameworkKey(fw.name)}`, dimension: 'framework', title: `Bridge ${fw.name} ${theirs} and ${yours}`, detail: `Check the ${fw.name} migration guide between major versions ${Math.min(theirs, yours)} and ${Math.max(theirs, yours)} for the APIs this repository uses.`, hours: { low: 4, high: 24 }, evidence: where });
        breaking.push({ text: `${fw.name} major version differs (${theirs} against ${yours})`, evidence: where });
      } else {
        scores.push(100);
        parts.push(`${fw.name} matches your stack`);
      }
      continue;
    }
    const rival = profile.frameworks.find((f) => clash(roleOf(fw.name), roleOf(f.name)));
    if (rival) {
      const where = [...fw.evidence, profileEvidence(`Your stack uses ${rival.name}`)];
      scores.push(30);
      parts.push(`built on ${fw.name}, you use ${rival.name}`);
      warnings.push({ id: `framework-different-${frameworkKey(fw.name)}`, dimension: 'framework', severity: 'major', message: `The repository is built on ${fw.name}; your stack uses ${rival.name}. Its handlers and middleware cannot be mounted directly.`, evidence: where });
      modifications.push({ id: `framework-port-${frameworkKey(fw.name)}`, dimension: 'framework', title: `Run beside ${rival.name} or port from ${fw.name}`, detail: `Run the repository as a separate service behind your ${rival.name} application, or port its ${fw.name}-specific code.`, hours: { low: 8, high: 40 }, evidence: where });
    } else {
      scores.push(70);
      parts.push(`${fw.name} is not in your stack`);
      warnings.push({ id: `framework-new-${frameworkKey(fw.name)}`, dimension: 'framework', severity: 'minor', message: `The repository brings ${fw.name}, which is not in your stack.`, evidence: fw.evidence.length ? fw.evidence : [profileEvidence('Your framework list')] });
    }
  }
  return { dimension: { id: 'framework', status: 'measured', score: average(scores), summary: parts.join('; '), evidence: requirements.frameworks.flatMap((f) => f.evidence) }, warnings, modifications, breaking };
}; // prettier-ignore
