import prisma from './prisma-client.js';

/**
 * Resolve the delivery-capable driver row for a user: driver_profile joined to its
 * driver_delivery_profile extension, flattened into the shape the old delivery_driver
 * table used to return (driver_id, current_lat, current_long, vendor_type_id, is_online)
 * plus driver_profile_id as the canonical id. Returns null if the user has no
 * driver_profile, or has one but never opted into delivery.
 * Presence (is_online/current_lat/current_long) comes from driver_profile — one online
 * status per driver, shared with rideshare/courier — not from driver_delivery_profile,
 * which only holds delivery-specific attributes (vendor_type_id) now.
 */
export async function resolveDeliveryDriverForUser(userId) {
  const profile = await prisma.driver_profile.findFirst({
    where: { user_id: userId, driver_delivery_profile: { isNot: null } },
    include: { driver_delivery_profile: true },
  });
  if (!profile?.driver_delivery_profile) return null;

  return {
    driver_profile_id: profile.driver_profile_id,
    driver_id: profile.driver_profile_id, // back-compat alias for call sites still reading .driver_id
    user_id: profile.user_id,
    is_online: profile.is_online,
    current_lat: profile.current_lat,
    current_long: profile.current_long,
    accepts_food: profile.accepts_food,
    accepts_product: profile.accepts_product,
    vendor_type_id: profile.driver_delivery_profile.vendor_type_id,
  };
}

/**
 * Resolve the courier-capable driver row for a user: driver_profile joined to its
 * driver_courier_profile extension. Presence status comes from driver_profile.is_online
 * (courier has always shared that field, never had its own).
 */
export async function resolveCourierDriverForUser(userId) {
  const profile = await prisma.driver_profile.findFirst({
    where: { user_id: userId, driver_courier_profile: { isNot: null } },
    include: { driver_courier_profile: true },
  });
  if (!profile?.driver_courier_profile) return null;

  return {
    driver_profile_id: profile.driver_profile_id,
    courier_service_provider_id: profile.driver_profile_id, // back-compat alias
    user_id: profile.user_id,
    is_online: profile.is_online,
    current_lat: profile.current_lat,
    current_long: profile.current_long,
    accepts_courier: profile.accepts_courier,
    display_name: profile.driver_courier_profile.display_name,
    price_per_km: profile.driver_courier_profile.price_per_km,
  };
}
