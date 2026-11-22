import { describe, expect, it } from 'vitest';
import { ROLES, roleCan } from './roles.js';

describe('roleCan', () => {
  it('lets an Operator and an Admin read program files, but not a Viewer', () => {
    expect(ROLES.map(role => [role, roleCan(role, 'read-files')])).toEqual([
      ['viewer', false],
      ['operator', true],
      ['admin', true],
    ]);
  });

  it('gives each role that can send files also the right to read them', () => {
    for (const role of ROLES) {
      if (roleCan(role, 'send-files')) expect(roleCan(role, 'read-files'), role).toBe(true);
    }
  });
});
