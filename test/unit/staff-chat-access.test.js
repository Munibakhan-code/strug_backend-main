import { describe, it, expect } from 'vitest';
import { canAccessChannel, dmKey } from '../../services/staff-chat-service.js';

const company = { kind: 'company', dashboard_key: 'general' };
const teamFinance = { kind: 'team', dashboard_key: 'finance' };
const topic = { kind: 'topic', dashboard_key: null };
const dm = { kind: 'dm', dashboard_key: null };

describe('canAccessChannel — per-channel access core', () => {
  it('company channels are open to every member', () => {
    expect(canAccessChannel(company, { access: {} })).toBe(true);
  });

  it('team channels require read access to their dashboard_key', () => {
    expect(canAccessChannel(teamFinance, { access: { finance: 'read' } })).toBe(true);
    expect(canAccessChannel(teamFinance, { access: { finance: 'write' } })).toBe(true);
    expect(canAccessChannel(teamFinance, { access: { operations: 'read' } })).toBe(false);
    expect(canAccessChannel(teamFinance, { access: {} })).toBe(false);
  });

  it('super-admins can access any team channel regardless of the access map', () => {
    expect(canAccessChannel(teamFinance, { access: {}, isSuperAdmin: true })).toBe(true);
  });

  it('dm / topic / incident require an active participant row', () => {
    expect(canAccessChannel(topic, { isParticipant: true })).toBe(true);
    expect(canAccessChannel(topic, { isParticipant: false })).toBe(false);
    expect(canAccessChannel(dm, { isParticipant: true })).toBe(true);
    expect(canAccessChannel(dm, { isParticipant: false })).toBe(false);
    // a super-admin is NOT auto-added to private channels they haven't joined
    expect(canAccessChannel(topic, { isSuperAdmin: true, isParticipant: false })).toBe(false);
  });

  it('archived or missing channels are never accessible', () => {
    expect(canAccessChannel({ ...company, archived_at: new Date() }, { access: {} })).toBe(false);
    expect(canAccessChannel(null, { access: {} })).toBe(false);
  });
});

describe('dmKey — deterministic 1:1 dedupe', () => {
  it('is order-independent', () => {
    expect(dmKey(3, 7)).toBe('dm_3_7');
    expect(dmKey(7, 3)).toBe('dm_3_7');
  });
  it('differs per pair', () => {
    expect(dmKey(1, 2)).not.toBe(dmKey(1, 3));
  });
});
