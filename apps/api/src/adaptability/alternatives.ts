import type {
  Alternatives,
  Runtime,
  SimilarResponse,
  StackProfileInput,
} from '@repointelligence/shared';
import { licenseVerdict } from './checks/policy.js';

const MAX_ALTERNATIVES = 5;

const RUNTIME_OF_LANGUAGE: Record<string, Runtime> = {
  javascript: 'node',
  typescript: 'node',
  python: 'python',
  java: 'java',
  kotlin: 'java',
  go: 'go',
};
const RUNTIME_NAMES: Record<Runtime, string> = { node: 'Node.js', python: 'Python', java: 'Java', go: 'Go' }; // prettier-ignore

/**
 * Similar repositories that pass the same license and runtime rules as the evaluated one. The
 * candidates come from GitHub search; nothing here is suggested by a model.
 */
export function pickAlternatives(similar: SimilarResponse, profile: StackProfileInput): Alternatives {
  const runtimes = Object.keys(profile.runtimes) as Runtime[];
  const items: Alternatives['items'] = [];
  let filtered = 0;
  for (const { repo, similarity } of similar.items) {
    const verdict = licenseVerdict(repo.license.category, profile.license);
    const runtime = repo.language ? RUNTIME_OF_LANGUAGE[repo.language.toLowerCase()] : undefined;
    const blocked = verdict?.severity === 'blocker' || verdict?.severity === 'major';
    const foreign = runtimes.length > 0 && runtime !== undefined && !runtimes.includes(runtime);
    if (blocked || foreign || repo.archived) {
      filtered += 1;
      continue;
    }
    const reasons = [
      verdict ? `${repo.license.spdxId ?? 'License'}: usable under your policy with care` : `${repo.license.spdxId ?? 'License'} fits your license policy`,
    ];
    if (runtime && runtimes.includes(runtime)) reasons.push(`Written in ${repo.language ?? ''}, which runs on your ${RUNTIME_NAMES[runtime]} runtime`);
    items.push({ repo, similarity, reasons });
  }
  return { basis: similar.basis, items: items.slice(0, MAX_ALTERNATIVES), filtered };
} // prettier-ignore
