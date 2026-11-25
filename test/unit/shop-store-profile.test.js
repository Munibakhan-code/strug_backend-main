import { describe, it, expect, vi } from 'vitest';
import { parseStorePrepTime, ensureStoreProfile } from '../../utils/shop-store-profile.js';

describe('parseStorePrepTime', () => {
  it('parses policy JSON', () => {
    expect(parseStorePrepTime('{"returnPolicy":"30d","shippingInfo":"local"}')).toEqual({
      returnPolicy: '30d',
      shippingInfo: 'local',
      description: '',
    });
  });

  it('treats plain strings as description', () => {
    expect(parseStorePrepTime('legacy note').description).toBe('legacy note');
  });
});

describe('ensureStoreProfile', () => {
  it('returns existing profile without create', async () => {
    const existing = { user_id: 1, store_name: 'Acme' };
    const prisma = {
      store_profile: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(),
      },
    };
    const result = await ensureStoreProfile(prisma, 1);
    expect(result).toBe(existing);
    expect(prisma.store_profile.create).not.toHaveBeenCalled();
  });

  it('creates a minimal profile when missing', async () => {
    const created = { user_id: 2, store_name: 'My Store' };
    const prisma = {
      store_profile: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => created),
      },
    };
    const result = await ensureStoreProfile(prisma, 2, { store_name: 'My Store' });
    expect(result).toBe(created);
    expect(prisma.store_profile.create).toHaveBeenCalledWith({
      data: {
        user_id: 2,
        store_name: 'My Store',
        is_active: true,
        is_open: true,
      },
    });
  });
});
