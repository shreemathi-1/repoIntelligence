import type {
  Evidence,
  LicenseInfo,
  Modification,
  StackProfileInput,
  Warning,
  WarningSeverity,
} from '@repointelligence/shared';
import { ORMS } from '../catalog.js';
import { profileEvidence, unavailable, type BreakingReason, type Check } from '../types.js';

type Policy = StackProfileInput['license'];

const TOLERANCE: Record<Policy['copyleft'], number> = { none: 0, weak: 1, strong: 2 };
const USE_TEXT: Record<Policy['use'], string> = {
  internal: 'internal use only',
  saas: 'running it as a hosted service',
  distributed: 'shipping it to others',
};
const SEVERITY_SCORE: Record<WarningSeverity, number> = {
  blocker: 0,
  major: 40,
  minor: 70,
  info: 85,
};

/**
 * Whether a license category fits how the user will use the code. Rule-based guidance on common
 * open-source terms; it does not replace reading the license.
 */
export function licenseVerdict(
  category: LicenseInfo['category'],
  policy: Policy,
): { severity: WarningSeverity; message: string } | null {
  const accepts = TOLERANCE[policy.copyleft];
  switch (category) {
    case 'permissive':
    case 'public-domain':
      return null;
    case 'none':
      return { severity: 'blocker', message: 'The repository has no license, so there is no permission to use, copy or modify it.' };
    case 'unknown':
      return { severity: 'major', message: 'The license could not be identified. Read it before adopting the code.' };
    case 'weak-copyleft':
      if (accepts >= 1) return null;
      return policy.use === 'internal'
        ? { severity: 'minor', message: 'Weak copyleft: changes to the licensed files must be shared if you ever distribute them. Internal use does not trigger this.' }
        : { severity: 'major', message: 'Weak copyleft: changes to the licensed files must be shared under the same license, which your policy does not accept.' };
    case 'strong-copyleft':
      if (accepts >= 2) return null;
      return policy.use === 'distributed'
        ? { severity: 'blocker', message: 'Strong copyleft: software you ship that includes this code must be released under the same license, which your policy does not accept.' }
        : { severity: 'minor', message: 'Strong copyleft: the obligations apply when software including this code is distributed. Your stated use does not distribute it, but that must stay true.' };
    case 'network-copyleft':
      if (accepts >= 2) return null;
      return policy.use === 'internal'
        ? { severity: 'minor', message: 'Network copyleft: offering a modified version to users over a network requires releasing its source. Internal use does not trigger this.' }
        : { severity: 'blocker', message: 'Network copyleft: running a modified version as a service, or shipping it, requires releasing the source, which your policy does not accept.' };
  }
} // prettier-ignore

export const licenseCheck: Check = ({ requirements }, profile) => {
  const { license } = requirements;
  const reported: Evidence = { source: 'github', path: null, line: null, text: `GitHub reports the license as ${license.spdxId ?? 'none'} (${license.category})` };
  const policy = profileEvidence(`Your policy: ${USE_TEXT[profile.license.use]}, copyleft accepted: ${profile.license.copyleft}`);
  const verdict = licenseVerdict(license.category, profile.license);
  const warnings: Warning[] = verdict
    ? [{ id: `license-${license.category}`, dimension: 'license', severity: verdict.severity, message: verdict.message, evidence: [reported, policy] }]
    : [];
  return {
    dimension: {
      id: 'license',
      status: 'measured',
      score: verdict ? SEVERITY_SCORE[verdict.severity] : 100,
      summary: `${verdict ? verdict.message : `${license.spdxId ?? 'The license'} fits ${USE_TEXT[profile.license.use]}.`} Rule-based guidance, not legal advice.`,
      evidence: [reported],
    },
    warnings,
    modifications: [],
  };
}; // prettier-ignore

const ENGINE_NAMES = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', mssql: 'SQL Server' } as const; // prettier-ignore

/** The database the code talks to, how firmly it is tied to it, and the migrations to run. */
export const databaseCheck: Check = ({ requirements }, profile) => {
  const db = requirements.database;
  if (db.engines.length === 0 && db.orms.length === 0 && db.models === 0) {
    if (requirements.dependencyCount === 0 && db.evidence.length === 0) {
      return unavailable('database', 'No manifest or data model was found to read database needs from.');
    }
    const generic = db.evidence.length > 0;
    return {
      dimension: { id: 'database', status: 'measured', score: generic ? 80 : 100, summary: generic ? 'A database connection is configured, but the engine could not be identified.' : 'No database was detected.', evidence: db.evidence },
      warnings: generic ? [{ id: 'database-unidentified', dimension: 'database', severity: 'info', message: 'The repository reads a database connection setting, but the engine could not be identified from its files.', evidence: db.evidence }] : [],
      modifications: [],
    };
  }
  const warnings: Warning[] = [];
  const modifications: Modification[] = [];
  const breaking: BreakingReason[] = [];
  const names = db.engines.map((e) => ENGINE_NAMES[e]).join(' or ') || 'a database';
  const through = db.orms.length ? ` through ${db.orms.join(', ')}` : '';
  const evidence = db.evidence.length ? db.evidence : [profileEvidence('Your database list')];
  const mine = profile.databases.map((d) => d.engine);
  let score = 100;
  let summary = `Uses ${names}${through}, which is in your stack.`;

  if (db.engines.length > 0 && !db.engines.some((e) => mine.includes(e))) {
    const yours = profileEvidence(mine.length ? `Your stack runs ${mine.map((e) => ENGINE_NAMES[e]).join(', ')}` : 'Your stack lists no database');
    const portable = db.orms.length > 0 && mine.some((e) => Object.values(ORMS).some((o) => db.orms.includes(o.label) && o.engines.includes(e)));
    if (mine.length === 0) {
      score = 40;
      summary = `Needs ${names}${through}; your stack lists no database.`;
      warnings.push({ id: 'database-missing', dimension: 'database', severity: 'major', message: summary, evidence: [...evidence, yours] });
      modifications.push({ id: 'database-provision', dimension: 'database', title: `Provision ${names}`, detail: `Stand up ${names} and point the repository's connection settings at it.`, hours: { low: 2, high: 8 }, evidence });
    } else if (portable) {
      score = 60;
      summary = `Uses ${names}${through}; the ORM also supports your database, so the dialect can be switched.`;
      warnings.push({ id: 'database-dialect', dimension: 'database', severity: 'minor', message: `${summary} ${db.models} models and ${db.migrations} migrations need re-checking.`, evidence: [...evidence, yours] });
      modifications.push({ id: 'database-switch', dimension: 'database', title: 'Switch the database dialect', detail: `Change the ORM configuration to your database and regenerate or review ${db.migrations} migrations.`, hours: { low: 4, high: 16 }, evidence });
    } else {
      score = 25;
      summary = `Tied to ${names}${through}, which is not in your stack.`;
      warnings.push({ id: 'database-engine', dimension: 'database', severity: 'major', message: `${summary} Provision it, or port ${db.models} data models.`, evidence: [...evidence, yours] });
      modifications.push({ id: 'database-add-or-port', dimension: 'database', title: `Provision ${names} or port the data layer`, detail: `Run ${names} alongside your database, or rewrite ${db.models} models and their queries for your engine.`, hours: { low: 4, high: 60 }, evidence });
      breaking.push({ text: `The data layer is tied to ${names}`, evidence: [...evidence, yours] });
    }
  }
  if (db.migrations > 0) {
    warnings.push({ id: 'database-migrations', dimension: 'database', severity: 'info', message: `${db.migrations} database migrations must be applied before the code runs.`, evidence });
    modifications.push({ id: 'database-migrate', dimension: 'database', title: 'Apply the migrations', detail: `Run the repository's ${db.migrations} migrations against your database.`, hours: { low: 0.5, high: 2 }, evidence });
  }
  return { dimension: { id: 'database', status: 'measured', score, summary, evidence: db.evidence }, warnings, modifications, breaking };
}; // prettier-ignore

const AUTH_NAMES = { none: 'no authentication', session: 'server sessions', jwt: 'JSON Web Tokens', oauth: 'OAuth / OpenID Connect', saml: 'SAML', hosted: 'a hosted identity provider' } as const; // prettier-ignore

/** How the repository authenticates requests against the user's approach. */
export const authCheck: Check = ({ requirements, signals }, profile) => {
  const found = requirements.auth;
  const yours = profileEvidence(`Your stack uses ${AUTH_NAMES[profile.auth]}`);
  if (found.length === 0) {
    if (!signals.hasGraph && requirements.dependencyCount === 0) {
      return unavailable('auth', 'No manifest or architecture graph was available to detect authentication.');
    }
    const exposed = profile.auth !== 'none';
    return {
      dimension: { id: 'auth', status: 'measured', score: exposed ? 85 : 100, summary: exposed ? `No authentication was detected; it must sit behind your ${AUTH_NAMES[profile.auth]}.` : 'No authentication was detected, and your stack uses none.', evidence: [] },
      warnings: exposed ? [{ id: 'auth-none', dimension: 'auth', severity: 'info', message: `No authentication was detected in the repository. Anything it exposes must be protected by your ${AUTH_NAMES[profile.auth]}.`, evidence: [yours] }] : [],
      modifications: [],
    };
  }
  const evidence = found.map((a) => a.evidence);
  const labels = [...new Set(found.map((a) => a.label))].join(', ');
  if (found.some((a) => a.approach === profile.auth)) {
    return { dimension: { id: 'auth', status: 'measured', score: 100, summary: `Uses ${labels}, the same approach as your stack.`, evidence }, warnings: [], modifications: [] };
  }
  const none = profile.auth === 'none';
  const message = none
    ? `The repository authenticates with ${labels}; your stack has no authentication, so you must issue and manage its credentials.`
    : `The repository authenticates with ${labels}; your stack uses ${AUTH_NAMES[profile.auth]}. The two must be bridged.`;
  return {
    dimension: { id: 'auth', status: 'measured', score: none ? 60 : 50, summary: message, evidence },
    warnings: [{ id: 'auth-mismatch', dimension: 'auth', severity: none ? 'minor' : 'major', message, evidence: [...evidence, yours] }],
    modifications: [{ id: 'auth-bridge', dimension: 'auth', title: none ? `Set up ${labels}` : `Bridge ${labels} to ${AUTH_NAMES[profile.auth]}`, detail: none ? 'Configure the secrets and the way users obtain credentials.' : 'Exchange your existing credentials for the ones the repository checks, or replace its auth middleware with yours.', hours: none ? { low: 2, high: 8 } : { low: 8, high: 24 }, evidence }],
  };
}; // prettier-ignore
