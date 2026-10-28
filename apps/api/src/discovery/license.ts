import type { LicenseInfo } from '@repointelligence/shared';

type Category = LicenseInfo['category'];

const PERMISSIVE = new Set([
  'MIT',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  '0BSD',
  'ZLIB',
  'BSL-1.0',
]);
const PUBLIC_DOMAIN = new Set(['UNLICENSE', 'CC0-1.0']);
const WEAK = new Set(['MPL-2.0', 'EPL-1.0', 'EPL-2.0', 'LGPL-2.1', 'LGPL-3.0']);

const FLAGS: Record<Category, string[]> = {
  permissive: [],
  'public-domain': [],
  'weak-copyleft': ['Changes to the licensed files must be shared under the same license'],
  'strong-copyleft': [
    'Software that includes this code must be released under the same license',
    'May not be compatible with closed-source products',
  ],
  'network-copyleft': [
    'Running a modified version as a network service also requires releasing its source',
    'May not be compatible with closed-source products',
  ],
  none: ['No license: all rights are reserved, so you have no permission to reuse the code'],
  unknown: ['The license could not be identified automatically, read it before adopting'],
};

function normalize(spdxId: string): string {
  // GPL-3.0-only, GPL-3.0-or-later and the older GPL-3.0 are all treated the same.
  return spdxId.toUpperCase().replace(/-(ONLY|OR-LATER)$/, '');
}

function categoryOf(id: string): Category {
  if (PERMISSIVE.has(id)) return 'permissive';
  if (PUBLIC_DOMAIN.has(id)) return 'public-domain';
  if (WEAK.has(id)) return 'weak-copyleft';
  if (id.startsWith('AGPL-')) return 'network-copyleft';
  if (id.startsWith('LGPL-')) return 'weak-copyleft';
  if (id.startsWith('GPL-')) return 'strong-copyleft';
  return 'unknown';
}

/** `spdxId` is what GitHub reports: null when no license file was found. */
export function classifyLicense(spdxId: string | null | undefined): LicenseInfo {
  if (spdxId === null || spdxId === undefined) {
    return { spdxId: null, category: 'none', flags: FLAGS.none };
  }
  if (spdxId === 'NOASSERTION') {
    return { spdxId, category: 'unknown', flags: FLAGS.unknown };
  }
  const category = categoryOf(normalize(spdxId));
  return { spdxId, category, flags: FLAGS[category] };
}
