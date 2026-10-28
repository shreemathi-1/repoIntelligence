import { describe, expect, it } from 'vitest';
import { classifyLicense } from './license.js';

describe('classifyLicense', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['Unlicense', 'public-domain'],
    ['MPL-2.0', 'weak-copyleft'],
    ['LGPL-3.0-or-later', 'weak-copyleft'],
    ['GPL-3.0', 'strong-copyleft'],
    ['GPL-2.0-only', 'strong-copyleft'],
    ['AGPL-3.0', 'network-copyleft'],
    ['SomethingNew-1.0', 'unknown'],
  ])('%s is %s', (id, category) => {
    expect(classifyLicense(id).category).toBe(category);
  });

  it('flags a missing license as all rights reserved', () => {
    const info = classifyLicense(null);
    expect(info.category).toBe('none');
    expect(info.flags[0]).toMatch(/no permission to reuse/);
  });

  it('treats NOASSERTION as unknown, not as missing', () => {
    expect(classifyLicense('NOASSERTION').category).toBe('unknown');
  });

  it('adds adoption flags only for restrictive licenses', () => {
    expect(classifyLicense('MIT').flags).toEqual([]);
    expect(classifyLicense('GPL-3.0').flags.join(' ')).toMatch(/closed-source/);
    expect(classifyLicense('AGPL-3.0').flags.join(' ')).toMatch(/network service/);
  });
});
