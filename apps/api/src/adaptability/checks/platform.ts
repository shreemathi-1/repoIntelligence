import type { Evidence, Modification, Warning } from '@repointelligence/shared';
import { SERVICES } from '../catalog.js';
import { profileEvidence, unavailable, type Check, type CheckResult } from '../types.js';

/** External services: infrastructure the user must run and third-party accounts the code needs. */
export const servicesCheck: Check = ({ requirements }, profile) => {
  if (requirements.dependencyCount === 0 && requirements.envVars.length === 0) {
    return unavailable('services', 'No manifest or environment example was found to detect services from.');
  }
  const external = requirements.services.filter((s) => s.kind !== 'database');
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const missing: NonNullable<CheckResult['missingInfrastructure']> = [];
  let score = 100;
  for (const service of external) {
    if (service.kind === 'saas') {
      score -= 5;
      warnings.push({ id: `service-${service.id}`, dimension: 'services', severity: 'info', message: `Needs ${service.label}: an account and credentials for it.`, evidence: service.evidence });
      continue;
    }
    const covers = SERVICES.find((r) => r.id === service.id)?.infrastructure;
    if (covers && profile.infrastructure.includes(covers)) continue;
    score -= 15;
    missing.push({ id: service.id, label: service.label, evidence: service.evidence });
    warnings.push({ id: `service-${service.id}`, dimension: 'services', severity: 'major', message: `Needs ${service.label}, which your stack does not list.`, evidence: [...service.evidence, profileEvidence(`Your infrastructure: ${profile.infrastructure.join(', ') || 'none listed'}`)] });
    modifications.push({ id: `service-provision-${service.id}`, dimension: 'services', title: `Provision ${service.label}`, detail: `Run or subscribe to ${service.label} and configure its connection settings.`, hours: { low: 2, high: 8 }, evidence: service.evidence });
  }
  const have = external.length - missing.length;
  return {
    dimension: {
      id: 'services',
      status: 'measured',
      score: Math.max(20, score),
      summary: external.length === 0 ? 'No external services were detected.' : `${external.length} external services detected: ${missing.length} missing from your stack, ${have} covered or account-based.`,
      evidence: external.flatMap((s) => s.evidence.slice(0, 1)),
    },
    warnings,
    modifications,
    missingInfrastructure: missing,
  };
}; // prettier-ignore

/** Whether the way the repository is packaged fits where the user deploys. */
export const infrastructureCheck: Check = ({ signals }, profile) => {
  if (!profile.deployment) return unavailable('infrastructure', 'Choose a deployment target in the profile to compare it.');
  const target = profileEvidence(`You deploy to: ${profile.deployment}`);
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const evidence: Evidence[] = [signals.dockerfile, signals.compose, signals.server].filter((e) => e !== null);
  const parts: string[] = [];
  let score = 100;

  if (profile.deployment === 'serverless' && signals.server) {
    score = Math.min(score, 35);
    parts.push('a long-running server does not drop into a serverless function');
    warnings.push({ id: 'infrastructure-serverless', dimension: 'infrastructure', severity: 'major', message: 'The repository is a long-running HTTP server; your target is serverless. It needs an adapter or a container-based runtime.', evidence: [signals.server, target] });
    modifications.push({ id: 'infrastructure-adapter', dimension: 'infrastructure', title: 'Adapt the server for serverless', detail: 'Wrap the application in a serverless adapter for its framework, or deploy it on a container service instead.', hours: { low: 8, high: 24 }, evidence: [signals.server] });
  }
  if (profile.deployment === 'container') {
    if (signals.dockerfile) parts.push('ships a Dockerfile for your container target');
    else {
      score = Math.min(score, 75);
      parts.push('no Dockerfile for your container target');
      warnings.push({ id: 'infrastructure-no-dockerfile', dimension: 'infrastructure', severity: 'minor', message: 'You deploy containers, and the repository ships no Dockerfile.', evidence: [target] });
      modifications.push({ id: 'infrastructure-dockerfile', dimension: 'infrastructure', title: 'Write a Dockerfile', detail: 'Add an image build for the repository that matches its runtime and start command.', hours: { low: 1, high: 4 }, evidence: [] });
    }
  }
  if (signals.compose && !profile.infrastructure.includes('docker') && profile.deployment !== 'container') {
    score = Math.min(score, 70);
    parts.push('local setup expects Docker Compose');
    warnings.push({ id: 'infrastructure-compose', dimension: 'infrastructure', severity: 'minor', message: 'The repository sets up its services with Docker Compose, and your stack does not list Docker.', evidence: [signals.compose, target] });
  }
  if (parts.length === 0) parts.push(`nothing in the packaging conflicts with a ${profile.deployment} deployment`);
  return { dimension: { id: 'infrastructure', status: 'measured', score, summary: `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()), evidence }, warnings, modifications };
}; // prettier-ignore

/** Indicators for each operating system the user runs: shell-only scripts, native builds, CI coverage. */
export const osCheck: Check = ({ signals, manifests }, profile) => {
  const known = manifests.length > 0 || signals.ciSystems !== null || signals.shellFiles !== null || signals.dockerfile !== null;
  if (!known) return unavailable('os', 'Nothing in the repository indicates which operating systems it supports.');
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const evidence: Evidence[] = [];
  const parts: string[] = [];
  const scores = profile.os.map((os) => {
    let score = 100;
    if (os === 'windows') {
      if (signals.shellScripts.length > 0) {
        score = Math.min(score, 50);
        const where = signals.shellScripts.slice(0, 3);
        evidence.push(...where);
        warnings.push({ id: 'os-windows-scripts', dimension: 'os', severity: 'major', message: `${signals.shellScripts.length} package scripts use POSIX shell commands that do not run in a Windows shell.`, evidence: where });
        modifications.push({ id: 'os-windows-shell', dimension: 'os', title: 'Run the scripts on Windows', detail: 'Use WSL or Git Bash, or rewrite the scripts with cross-platform tools.', hours: { low: 1, high: 6 }, evidence: where });
      }
      if (signals.shellFiles && signals.windowsFiles === 0) {
        score = Math.min(score, 60);
        evidence.push(signals.shellFiles);
        warnings.push({ id: 'os-windows-sh', dimension: 'os', severity: 'minor', message: 'The repository has shell scripts and no Windows equivalents.', evidence: [signals.shellFiles] });
      }
    }
    if (signals.ciSystems && os !== 'linux' && !signals.ciSystems.systems.includes(os)) {
      score = Math.min(score, 90);
      warnings.push({ id: `os-untested-${os}`, dimension: 'os', severity: 'info', message: `The repository's CI does not run on ${os === 'macos' ? 'macOS' : 'Windows'}, so it is untested there.`, evidence: [signals.ciSystems.evidence] });
    }
    if (signals.ciSystems && os === 'linux' && !signals.ciSystems.systems.includes('ubuntu')) {
      score = Math.min(score, 90);
      warnings.push({ id: 'os-untested-linux', dimension: 'os', severity: 'info', message: "The repository's CI does not run on Linux, so it is untested there.", evidence: [signals.ciSystems.evidence] });
    }
    parts.push(`${os}: ${score === 100 ? 'no issues found' : score >= 90 ? 'untested in CI' : 'needs changes'}`);
    return score;
  });
  if (signals.nativePackages.length > 0) {
    const where = signals.nativePackages.slice(0, 3);
    evidence.push(...where);
    warnings.push({ id: 'os-native', dimension: 'os', severity: 'minor', message: `${signals.nativePackages.length} dependencies compile native code on install, which needs a C/C++ build toolchain on every machine.`, evidence: where });
  }
  if (signals.ciSystems) evidence.push(signals.ciSystems.evidence);
  const native = signals.nativePackages.length > 0 ? 10 : 0;
  const score = Math.max(0, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) - native);
  return { dimension: { id: 'os', status: 'measured', score, summary: parts.join('; '), evidence }, warnings, modifications };
}; // prettier-ignore

/** Configuration the user must supply before the code starts. */
export const configurationCheck: Check = ({ requirements }) => {
  const vars = requirements.envVars;
  if (vars.length === 0) return unavailable('configuration', 'No environment example file was found.');
  const required = vars.filter((v) => v.required);
  const n = required.length;
  const score = n <= 3 ? 100 : n <= 8 ? 80 : n <= 15 ? 60 : 40;
  const where = required.slice(0, 5).map((v) => v.evidence);
  const warnings: Warning[] = n === 0 ? [] : [{ id: 'configuration-required', dimension: 'configuration', severity: n > 8 ? 'minor' : 'info', message: `${n} environment variables have no default and must be set: ${required.slice(0, 8).map((v) => v.name).join(', ')}${n > 8 ? ', …' : ''}.`, evidence: where }];
  const modifications: Modification[] = n === 0 ? [] : [{ id: 'configuration-set', dimension: 'configuration', title: `Set ${n} environment variables`, detail: `Provide values for ${required.map((v) => v.name).join(', ')}.`, hours: { low: Math.max(0.5, n * 0.25), high: Math.max(1, n * 0.5) }, evidence: where }];
  return {
    dimension: { id: 'configuration', status: 'measured', score, summary: `${vars.length} environment variables documented, ${n} without a default.`, evidence: vars.slice(0, 5).map((v) => v.evidence) },
    warnings,
    modifications,
  };
}; // prettier-ignore
