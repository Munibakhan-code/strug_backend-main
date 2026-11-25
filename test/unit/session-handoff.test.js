/**
 * One-time session handoff for proxied login → app cookie claim.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSessionHandoff,
  consumeSessionHandoff,
  _resetSessionHandoffMemForTests,
} from '../../utils/session-handoff.js';

describe('session-handoff', () => {
  beforeEach(() => {
    _resetSessionHandoffMemForTests();
  });

  it('creates a handoff that can be consumed once', async () => {
    const id = await createSessionHandoff('refresh.jwt.here', 42);
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThanOrEqual(16);

    const first = await consumeSessionHandoff(id);
    expect(first).toEqual({ refreshToken: 'refresh.jwt.here', userId: 42 });

    const second = await consumeSessionHandoff(id);
    expect(second).toBeNull();
  });

  it('rejects missing refresh token', async () => {
    expect(await createSessionHandoff('', 1)).toBeNull();
    expect(await createSessionHandoff(null, 1)).toBeNull();
  });

  it('rejects missing user id', async () => {
    expect(await createSessionHandoff('tok', null)).toBeNull();
    expect(await createSessionHandoff('tok', '')).toBeNull();
  });

  it('rejects malformed or short handoff ids on consume', async () => {
    expect(await consumeSessionHandoff('')).toBeNull();
    expect(await consumeSessionHandoff('short')).toBeNull();
    expect(await consumeSessionHandoff(null)).toBeNull();
    expect(await consumeSessionHandoff(123)).toBeNull();
  });

  it('rejects unknown handoff ids', async () => {
    expect(await consumeSessionHandoff('abcdefghijklmnopqrstuvwxyz012345')).toBeNull();
  });
});
