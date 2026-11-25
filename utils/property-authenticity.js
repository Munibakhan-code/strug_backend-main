/**
 * Real-estate / preconstruction seller helpers.
 *
 * Agents and developers are granted immediately (no KYC / staff review).
 * Listings publish when they have an address + photo. Owners still cannot
 * self-set is_verified / is_featured.
 */

export const AUTH_CAPABILITIES = new Set(['is_realtor', 'is_precon_developer']);

const AGENT_TYPES = new Set(['agent', 'individual']);
const DEVELOPER_TYPES = new Set(['developer', 'company']);

export function normalizeSellerType(capability, raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (capability === 'is_realtor') {
    if (AGENT_TYPES.has(v)) return v;
    return 'individual';
  }
  if (capability === 'is_precon_developer') {
    if (DEVELOPER_TYPES.has(v)) return v;
    return 'developer';
  }
  return v || null;
}

/**
 * Whitelist optional professional fields from an apply request.
 * Stored on seller_capability.metadata.
 */
export function sanitizeCapabilityMetadata(capability, body = {}) {
  const seller_type = normalizeSellerType(capability, body.seller_type);
  const meta = {
    seller_type,
    phone: body.phone ? String(body.phone).trim().slice(0, 40) : null,
    notes: body.notes ? String(body.notes).trim().slice(0, 500) : null,
  };

  if (capability === 'is_realtor') {
    meta.license_number = body.license_number ? String(body.license_number).trim().slice(0, 80) : null;
    meta.brokerage_name = body.brokerage_name ? String(body.brokerage_name).trim().slice(0, 160) : null;
  }
  if (capability === 'is_precon_developer') {
    meta.company_name = body.company_name ? String(body.company_name).trim().slice(0, 160) : null;
    meta.registration_number = body.registration_number
      ? String(body.registration_number).trim().slice(0, 80)
      : null;
    meta.project_address = body.project_address ? String(body.project_address).trim().slice(0, 255) : null;
  }

  // Drop nulls for cleaner JSON
  for (const key of Object.keys(meta)) {
    if (meta[key] == null || meta[key] === '') delete meta[key];
  }
  return meta;
}

/** Professional fields are optional — KYC / license review is not a gate. */
export function validateCapabilityApplication(_capability, _metadata = {}) {
  return null;
}

export function isIndividualSeller(metadata) {
  return metadata?.seller_type === 'individual';
}

export function stripOwnerTrustFields(data = {}) {
  const next = { ...data };
  delete next.is_featured;
  delete next.is_verified;
  delete next.is_published;
  return next;
}

export function listingHasPublishRequirements(property, { imageCount = 0 } = {}) {
  const address = (property?.address || '').trim();
  if (!address || address.length < 5) return false;
  const hasCover = !!(property?.image && String(property.image).trim());
  return hasCover || imageCount > 0;
}

function isBlockedCapability(capability) {
  return capability?.status === 'rejected' || capability?.status === 'suspended';
}

/**
 * Grant (or refresh) a capability. Realtor / precon are active immediately.
 * Never demotes an already-active capability. Suspended stays suspended.
 */
export async function requestCapability(prisma, user_id, capability, metadata = {}) {
  const existing = await prisma.seller_capability.findUnique({
    where: { user_id_capability: { user_id, capability } },
  });

  if (existing?.status === 'active') {
    return prisma.seller_capability.update({
      where: { capability_id: existing.capability_id },
      data: { metadata: { ...(existing.metadata || {}), ...metadata } },
    });
  }

  if (existing?.status === 'suspended') {
    return existing;
  }

  return prisma.seller_capability.upsert({
    where: { user_id_capability: { user_id, capability } },
    create: { user_id, capability, status: 'active', metadata },
    update: { status: 'active', metadata },
  });
}

/**
 * Instant grant for marketplace verticals (host/hotel/restaurant/realtor/precon).
 */
export async function ensureLegacyCapability(prisma, user_id, capability) {
  if (AUTH_CAPABILITIES.has(capability)) {
    return requestCapability(prisma, user_id, capability, {});
  }
  return prisma.seller_capability.upsert({
    where: { user_id_capability: { user_id, capability } },
    create: { user_id, capability, status: 'active' },
    update: { status: 'active' },
  });
}

export async function getAuthCapability(prisma, user_id, vertical) {
  const capability = vertical === 'preconstruction' ? 'is_precon_developer' : 'is_realtor';
  return prisma.seller_capability.findUnique({
    where: { user_id_capability: { user_id, capability } },
  });
}

async function activatePendingCapability(prisma, cap) {
  if (!cap || cap.status !== 'pending') return cap;
  return prisma.seller_capability.update({
    where: { capability_id: cap.capability_id },
    data: { status: 'active' },
  });
}

/**
 * Gate property creation. Returns { ok: true, capability } or { ok: false, status, message }.
 */
export async function assertCanCreateProperty(prisma, user_id, vertical) {
  const capabilityName = vertical === 'preconstruction' ? 'is_precon_developer' : 'is_realtor';
  let cap = await prisma.seller_capability.findUnique({
    where: { user_id_capability: { user_id, capability: capabilityName } },
  });

  if (!cap) {
    cap = await requestCapability(prisma, user_id, capabilityName, {
      seller_type: vertical === 'preconstruction' ? 'developer' : 'agent',
    });
  } else {
    cap = await activatePendingCapability(prisma, cap);
  }

  if (isBlockedCapability(cap)) {
    return {
      ok: false,
      status: 403,
      message: 'Your seller application was not approved. Contact support if this is a mistake.',
      capability: cap,
    };
  }

  return { ok: true, capability: cap, publishAllowed: true };
}

/**
 * Gate self-publish. Owners never set is_verified/is_featured.
 * Agents, developers, and individuals can publish with address + photo.
 */
export async function assertCanPublish(prisma, user_id, property, capability) {
  let cap = capability;
  if (cap?.status === 'pending' && prisma && cap.capability_id) {
    cap = await activatePendingCapability(prisma, cap);
  }

  if (isBlockedCapability(cap)) {
    return {
      ok: false,
      status: 403,
      message: 'Your seller account cannot publish listings. Contact support if this is a mistake.',
    };
  }

  const imageCount = property?.property_id
    ? await prisma.property_image.count({ where: { property_id: property.property_id } })
    : 0;
  if (!listingHasPublishRequirements(property, { imageCount })) {
    const address = (property?.address || '').trim();
    if (!address || address.length < 5) {
      return { ok: false, status: 400, message: 'A real street address is required before publishing.' };
    }
    return { ok: false, status: 400, message: 'Add at least one photo before publishing.' };
  }

  return { ok: true, capability: cap };
}

export function trustLabelForListing(property, capability) {
  if (property?.is_verified) return 'verified';
  if (capability && !isBlockedCapability(capability) && !isIndividualSeller(capability?.metadata)) {
    return 'approved_seller';
  }
  return 'unverified';
}
