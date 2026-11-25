import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({ default: {} }));
vi.mock('../../utils/platform-blocks.js', () => ({
  areUsersBlockedOnPlatform: vi.fn(),
  blockedGraphForUser: vi.fn(),
}));

import { verticalForContextType } from '../../services/chat-service.js';

describe('verticalForContextType (DM source → identity)', () => {
  it('maps tempstay context to tempstay vertical profile, not hosting', () => {
    expect(verticalForContextType('tempstay')).toBe('tempstay');
    expect(verticalForContextType('tempstay')).not.toBe('hosting');
  });

  it('maps preconstruct and reservations allowed DM sources', () => {
    expect(verticalForContextType('preconstruct')).toBe('preconstruct');
    expect(verticalForContextType('reservations')).toBe('reservations');
  });

  it('returns null for unknown context types', () => {
    expect(verticalForContextType('unknown_vertical')).toBeNull();
    expect(verticalForContextType(null)).toBeNull();
  });
});
