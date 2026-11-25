/**
 * Shop store_profile helpers (Phase 5).
 * Ensure sellers always have a store_profile row when granted seller access.
 */

/** Parse prep_time JSON used for return/shipping policy (bio lives on bio column). */
export function parseStorePrepTime(prepTime) {
  if (!prepTime) return { returnPolicy: '', shippingInfo: '', description: '' };
  if (typeof prepTime !== 'string') {
    return {
      returnPolicy: prepTime.returnPolicy || '',
      shippingInfo: prepTime.shippingInfo || '',
      description: prepTime.description || '',
    };
  }
  try {
    const parsed = JSON.parse(prepTime);
    if (parsed && typeof parsed === 'object') {
      return {
        returnPolicy: parsed.returnPolicy || '',
        shippingInfo: parsed.shippingInfo || '',
        description: parsed.description || '',
      };
    }
  } catch {
    return { returnPolicy: '', shippingInfo: '', description: prepTime };
  }
  return { returnPolicy: '', shippingInfo: '', description: '' };
}

/**
 * Upsert a minimal store_profile for a newly activated seller.
 * Safe to call repeatedly — does not wipe existing branding/address.
 */
export async function ensureStoreProfile(prisma, userId, { store_name } = {}) {
  if (!prisma || !userId) return null;
  const existing = await prisma.store_profile.findUnique({ where: { user_id: userId } });
  if (existing) return existing;
  return prisma.store_profile.create({
    data: {
      user_id: userId,
      store_name: store_name || 'My Store',
      is_active: true,
      is_open: true,
    },
  });
}
