import prisma from './prisma-client.js';
import { haversineKm } from './ride-fare.js';
import { notify } from '../services/notify.js';
import { driverPresenceCutoff } from './driver-presence.js';
import { getBusyDriverProfileIds } from './driver-busy.js';
import { geocodeAddress } from './google-maps.js';
import {
  resolveFoodCourierDispatchWhere,
  isFoodPickupOrder,
  isReservedPickupSentinel,
  publicDeliverLocation,
} from './food-fulfillment.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from './cron-lock.js';

/**
 * Shared sequential-offer dispatch engine for delivery-capable verticals
 * (food_order, product_order), backed by driver_profile + driver_delivery_profile.
 * Generalizes ride-dispatch.js's nearest-driver / offer-timeout / decline / re-offer
 * pattern so drivers get one scored offer at a time instead of a
 * broadcast-to-everyone-first-to-claim-wins race.
 *
 * Presence (is_online/current_lat/current_long) now lives on driver_profile — the same
 * field ride-dispatch and courier read — gated per-vertical by accepts_food/accepts_product
 * (driver_delivery_profile row existence remains the capability gate; the accepts_* flag is
 * the on-top-of-that preference gate).
 *
 * Courier orders now share the same driver_profile identity (via
 * driver_courier_profile) but keep their own dispatch path in courier-order-routes.js —
 * out of scope here, not because the identity model differs anymore.
 */

export const DELIVERY_OFFER_TIMEOUT_SEC = Number(process.env.DELIVERY_DRIVER_OFFER_TIMEOUT_SEC || 90);
const SEARCH_RADIUS_KM = 10;
const DEFAULT_MAX_BATCH_ORDERS = Math.max(1, Number(process.env.GROCERY_DEFAULT_MAX_BATCH_ORDERS || 2) || 2);
const DEFAULT_MAX_BATCH_DISTANCE_KM = Math.max(1, Number(process.env.GROCERY_DEFAULT_MAX_BATCH_DISTANCE_KM || 8) || 8);
const HEAVY_ITEM_KG_THRESHOLD = Math.max(1, Number(process.env.GROCERY_HEAVY_ITEM_KG_THRESHOLD || 8) || 8);
const DELIVERY_RUN_OFFER_TIMEOUT_SEC = Math.max(30, Number(process.env.DELIVERY_RUN_OFFER_TIMEOUT_SEC || 120) || 120);
const HOT_FOOD_MAX_BUNDLE_DELAY_MIN = Math.max(5, Number(process.env.HOT_FOOD_MAX_BUNDLE_DELAY_MIN || 12) || 12);
const SCHEDULED_DISPATCH_LEAD_MIN = Math.max(
  10,
  Number(process.env.GROCERY_SCHEDULED_DISPATCH_LEAD_MIN || 45) || 45
);

/**
 * Statuses during which an order may legitimately hold (or be waiting for) a live courier offer.
 * Food orders are driven forward by the *vendor* (confirmed → preparing → ready_for_pickup)
 * independently of the courier hand-off, so the offer/accept/re-offer machinery must recognize
 * all of those, not just the single legacy `pendingStatus` gate — otherwise every seller-accepted
 * order silently falls out of the driver pool the instant the kitchen starts cooking.
 * Falls back to `[pendingStatus]` for verticals that don't declare a set (product).
 */
function offerableStatusesFor(type) {
  return Array.isArray(type.offerableStatuses) && type.offerableStatuses.length
    ? type.offerableStatuses
    : [type.pendingStatus];
}

function isValidCoord(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
}

function formatDistanceKm(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function formatEtaFromDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return '—';
  const etaMin = (distanceKm / 30) * 60;
  return `~${Math.max(1, Math.round(etaMin))} min`;
}

function foodOrderFlow(order) {
  const raw = String(
    order?.order_flow
      || order?.vendor_type?.vendor_type
      || order?.food_vendor?.vendor_type?.vendor_type
      || ''
  ).toLowerCase();
  return raw === 'grocery' || raw === 'groceries' ? 'grocery' : 'food';
}

const DELIVERY_CANDIDATE_SELECT = {
  driver_profile_id: true,
  user_id: true,
  current_lat: true,
  current_long: true,
  last_ping: true,
  rating: true,
  accept_count: true,
  decline_count: true,
  accepts_food: true,
  accepts_product: true,
  accepts_rides: true,
  accepts_courier: true,
  booking_type: { select: { booking_type: true } },
  vehicle: {
    take: 1,
    select: {
      vehicle_type: true,
      make: true,
      model: true,
      max_passengers: true,
    },
  },
  driver_delivery_profile: {
    select: {
      has_cold_bag: true,
      supports_heavy_items: true,
      max_heavy_item_kg: true,
      max_batch_orders: true,
      max_batch_distance_km: true,
      delivery_vehicle_class: true,
    },
  },
};

/** Flatten onto the shape the rest of this module expects, keyed like the old delivery_driver shape. */
function flattenDeliveryCandidate(row) {
  const deliveryProfile = row.driver_delivery_profile || {};
  const vehicleType = deliveryProfile.delivery_vehicle_class || row.vehicle?.[0]?.vehicle_type || row.booking_type?.booking_type || null;
  return {
    driver_id: row.driver_profile_id,
    user_id: row.user_id,
    current_lat: row.current_lat ?? null,
    current_long: row.current_long ?? null,
    last_ping: row.last_ping ?? null,
    rating: row.rating ?? null,
    accept_count: row.accept_count ?? 0,
    decline_count: row.decline_count ?? 0,
    accepts_food: row.accepts_food ?? false,
    accepts_product: row.accepts_product ?? false,
    accepts_rides: row.accepts_rides ?? false,
    accepts_courier: row.accepts_courier ?? false,
    booking_type: row.booking_type?.booking_type ?? null,
    vehicle_type: vehicleType,
    vehicle_label: [row.vehicle?.[0]?.make, row.vehicle?.[0]?.model].filter(Boolean).join(' ') || row.vehicle?.[0]?.vehicle_type || null,
    has_cold_bag: deliveryProfile.has_cold_bag === true,
    supports_heavy_items: deliveryProfile.supports_heavy_items === true,
    max_heavy_item_kg: Number.isFinite(Number(deliveryProfile.max_heavy_item_kg)) ? Number(deliveryProfile.max_heavy_item_kg) : null,
    max_batch_orders: Math.max(1, Number(deliveryProfile.max_batch_orders) || DEFAULT_MAX_BATCH_ORDERS),
    max_batch_distance_km: Math.max(1, Number(deliveryProfile.max_batch_distance_km) || DEFAULT_MAX_BATCH_DISTANCE_KM),
    delivery_vehicle_class: deliveryProfile.delivery_vehicle_class || null,
    active_workload: 0,
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function driverAcceptanceRate(driver) {
  const accepted = Number(driver?.accept_count) || 0;
  const declined = Number(driver?.decline_count) || 0;
  const total = accepted + declined;
  if (total <= 0) return 0.7;
  return clamp01(accepted / total);
}

function driverPresenceScore(lastPing) {
  const ping = lastPing ? new Date(lastPing).getTime() : 0;
  if (!ping) return 0;
  const minutes = (Date.now() - ping) / 60000;
  if (!Number.isFinite(minutes) || minutes < 0) return 0.8;
  return clamp01(1 - minutes / 30);
}

function driverWorkloadScore(driver) {
  const active = Number(driver?.active_workload) || 0;
  return clamp01(1 - active / 4);
}

function vehicleCapabilitySignals(driver) {
  const label = String(driver?.vehicle_type || driver?.booking_type || driver?.vehicle_label || '').toLowerCase();
  const carLike = /(car|sedan|suv|van|truck|wagon|auto)/.test(label);
  const bikeLike = /(bike|bicycle|cycle|motorcycle|scooter)/.test(label);
  const coldBag = driver?.has_cold_bag === true;
  const heavyCapable = driver?.supports_heavy_items === true && !bikeLike;
  return {
    vehicle_type: driver?.vehicle_type || driver?.booking_type || null,
    vehicle_class: carLike ? 'car' : bikeLike ? 'bike' : 'unknown',
    cold_capability: coldBag ? 'cold_bag' : 'not_declared',
    heavy_capability: heavyCapable ? 'declared' : carLike ? 'vehicle_only' : bikeLike ? 'limited' : 'not_declared',
    max_heavy_item_kg: driver?.max_heavy_item_kg ?? null,
    max_batch_orders: driver?.max_batch_orders ?? DEFAULT_MAX_BATCH_ORDERS,
    max_batch_distance_km: driver?.max_batch_distance_km ?? DEFAULT_MAX_BATCH_DISTANCE_KM,
  };
}

function textIncludesAny(text, needles) {
  const haystack = String(text || '').toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function groceryHandlingLabels(order) {
  if (foodOrderFlow(order) !== 'grocery') return [];
  const labels = new Set();
  const items = Array.isArray(order?.food_order_items) ? order.food_order_items : [];
  for (const item of items) {
    const food = item?.food_item || {};
    const text = [food.name, food.allergen_info, food.food_category?.name].filter(Boolean).join(' ');
    if (textIncludesAny(text, ['frozen', 'ice cream', 'ice-cream'])) labels.add('frozen');
    if (textIncludesAny(text, ['cold', 'chilled', 'milk', 'cheese', 'yogurt', 'cream'])) labels.add('cold');
    if (textIncludesAny(text, ['fragile', 'glass', 'eggs', 'egg'])) labels.add('fragile');
    if (textIncludesAny(text, ['heavy', 'bulk', 'case of water', 'water case'])) labels.add('heavy');
    if (textIncludesAny(text, ['alcohol', 'beer', 'wine', 'liquor'])) labels.add('age_restricted');
    if (textIncludesAny(text, ['pharmacy', 'medicine', 'prescription'])) labels.add('pharmacy');
  }
  return Array.from(labels);
}

function parseWeightKg(text) {
  const source = String(text || '').toLowerCase();
  const matches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(kg|kilogram|kilograms|g|gram|grams|lb|lbs|pound|pounds|oz|ounce|ounces)\b/g)];
  let maxKg = 0;
  for (const match of matches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2];
    const kg = unit.startsWith('kg') || unit.startsWith('kilogram')
      ? value
      : unit === 'g' || unit.startsWith('gram')
        ? value / 1000
        : unit.startsWith('lb') || unit.startsWith('pound')
          ? value * 0.453592
          : value * 0.0283495;
    if (kg > maxKg) maxKg = kg;
  }
  return maxKg;
}

function groceryCapacityRequirements(order) {
  const labels = groceryHandlingLabels(order);
  const items = Array.isArray(order?.food_order_items) ? order.food_order_items : [];
  let estimatedHeaviestKg = 0;
  let estimatedTotalKg = 0;
  let itemCount = 0;
  for (const item of items) {
    const qty = Math.max(1, Number(item?.quantity) || 1);
    const food = item?.food_item || {};
    const text = [food.name, food.allergen_info, food.food_category?.name].filter(Boolean).join(' ');
    const kg = parseWeightKg(text);
    if (kg > estimatedHeaviestKg) estimatedHeaviestKg = kg;
    estimatedTotalKg += kg * qty;
    itemCount += qty;
  }
  const requiresHeavy = labels.includes('heavy')
    || estimatedHeaviestKg >= HEAVY_ITEM_KG_THRESHOLD
    || estimatedTotalKg >= HEAVY_ITEM_KG_THRESHOLD * 1.5;
  const requiresColdBag = labels.includes('cold') || labels.includes('frozen');
  const requiresCar = labels.includes('frozen') || requiresHeavy || labels.includes('age_restricted') || labels.includes('pharmacy');
  return {
    labels,
    requires_cold_bag: requiresColdBag,
    requires_heavy_capacity: requiresHeavy,
    requires_car: requiresCar,
    estimated_heaviest_item_kg: estimatedHeaviestKg ? Number(estimatedHeaviestKg.toFixed(2)) : null,
    estimated_total_weight_kg: estimatedTotalKg ? Number(estimatedTotalKg.toFixed(2)) : null,
    item_count: itemCount,
  };
}

function driverMatchesCapacity(driver, requirements = {}) {
  const capability = vehicleCapabilitySignals(driver);
  if (requirements.requires_cold_bag && driver?.has_cold_bag !== true) return false;
  if (requirements.requires_car && capability.vehicle_class !== 'car') return false;
  if (requirements.requires_heavy_capacity) {
    if (driver?.supports_heavy_items !== true) return false;
    const maxHeavy = Number(driver?.max_heavy_item_kg);
    if (Number.isFinite(maxHeavy) && maxHeavy > 0) {
      const heaviest = Number(requirements.estimated_heaviest_item_kg);
      if (Number.isFinite(heaviest) && heaviest > maxHeavy) return false;
    }
  }
  return true;
}

function driverMatchesHandlingLabels(driver, labels = [], order = null) {
  const requirements = order ? groceryCapacityRequirements(order) : {
    labels,
    requires_cold_bag: labels.includes('cold') || labels.includes('frozen'),
    requires_heavy_capacity: labels.includes('heavy') || labels.includes('frozen'),
    requires_car: labels.includes('heavy') || labels.includes('frozen') || labels.includes('age_restricted') || labels.includes('pharmacy'),
  };
  if (!order && !labels.length) return true;
  const capability = vehicleCapabilitySignals(driver);
  if (!driverMatchesCapacity(driver, requirements)) return false;
  const protectedGoodsNeed = requirements.labels?.includes('age_restricted') || requirements.labels?.includes('pharmacy');
  if (protectedGoodsNeed) return capability.vehicle_type != null && capability.vehicle_class === 'car';
  return true;
}

function scoreDeliveryCandidate(driver, handlingLabels = [], order = null) {
  const distanceScore = Number.isFinite(driver.distance_km)
    ? clamp01(1 - driver.distance_km / SEARCH_RADIUS_KM)
    : 0;
  const rating = Number(driver.rating);
  const ratingScore = Number.isFinite(rating) ? clamp01(rating / 5) : 0.7;
  const acceptanceScore = driverAcceptanceRate(driver);
  const presenceScore = driverPresenceScore(driver.last_ping);
  const workloadScore = driverWorkloadScore(driver);
  const capability = vehicleCapabilitySignals(driver);
  const handlingScore = driverMatchesHandlingLabels(driver, handlingLabels, order)
    ? capability.heavy_capability === 'declared' || capability.cold_capability === 'cold_bag'
      ? 1
      : 0.72
    : 0;
  return Number((
    distanceScore * 0.32
    + ratingScore * 0.18
    + acceptanceScore * 0.2
    + presenceScore * 0.1
    + workloadScore * 0.12
    + handlingScore * 0.08
  ).toFixed(3));
}

function assignmentFactors(driver, handlingLabels = [], order = null) {
  const distance = Number.isFinite(driver.distance_km) && driver.distance_km < 1e6
    ? Number(driver.distance_km.toFixed(2))
    : null;
  const rating = Number(driver.rating);
  return {
    distance_km: distance,
    rating: Number.isFinite(rating) ? rating : null,
    acceptance_rate: Number(driverAcceptanceRate(driver).toFixed(2)),
    live_presence: Number(driverPresenceScore(driver.last_ping).toFixed(2)),
    active_workload: Number(driver?.active_workload) || 0,
    workload_score: Number(driverWorkloadScore(driver).toFixed(2)),
    handling_labels: handlingLabels,
    handling_fit: driverMatchesHandlingLabels(driver, handlingLabels, order) ? 'eligible' : 'capacity_mismatch',
    capacity_requirements: order ? groceryCapacityRequirements(order) : null,
    ...vehicleCapabilitySignals(driver),
  };
}

function safeOfferEvents(order) {
  return Array.isArray(order?.delivery_offer_events) ? order.delivery_offer_events : [];
}

function deliveryOfferEvent(order, driver, status, extra = {}) {
  const driverId = Number(driver?.driver_id ?? driver?.driver_profile_id ?? driver);
  const payout = Number(order?.driver_earning ?? order?.delivery_fee);
  return {
    id: `${Date.now()}-${Number.isInteger(driverId) ? driverId : 'driver'}`,
    status,
    driver_profile_id: Number.isInteger(driverId) ? driverId : null,
    user_id: Number(driver?.user_id) || null,
    reason: extra.reason || null,
    distance_km: Number.isFinite(driver?.distance_km) ? Number(driver.distance_km.toFixed(2)) : null,
    payout: Number.isFinite(payout) ? payout : null,
    batch_id: order?.batch_id ?? null,
    handling_labels: groceryHandlingLabels(order),
    assignment_score: driver?.assignment_score ?? null,
    assignment_factors: driver?.assignment_factors ?? null,
    created_at: new Date().toISOString(),
  };
}

async function driverOfferAuditDriver(driverProfileId, type, order) {
  const id = Number(driverProfileId);
  if (!Number.isInteger(id) || id <= 0) return { driver_id: null };

  const row = await prisma.driver_profile.findUnique({
    where: { driver_profile_id: id },
    select: DELIVERY_CANDIDATE_SELECT,
  }).catch(() => null);
  const driver = row ? flattenDeliveryCandidate(row) : { driver_id: id };
  const pickup = typeof type.getPickupCoords === 'function' ? type.getPickupCoords(order) : null;
  const labels = typeof type.getHandlingLabels === 'function' ? type.getHandlingLabels(order) : [];
  const withDistance = {
    ...driver,
    distance_km: pickup && isValidCoord(driver.current_lat, driver.current_long)
      ? haversineKm(pickup.lat, pickup.long, driver.current_lat, driver.current_long)
      : null,
  };

  return {
    ...withDistance,
    assignment_score: Number.isFinite(withDistance.assignment_score)
      ? withDistance.assignment_score
      : scoreDeliveryCandidate(withDistance, labels, order),
    assignment_factors: withDistance.assignment_factors || assignmentFactors(withDistance, labels, order),
  };
}

function scheduledDispatchWindow(order) {
  const anchor = order?.delivery_window_start || order?.scheduled_time || null;
  if (!anchor) return { ready: true, dispatch_after: null, minutes_until_dispatch: 0 };
  const anchorTime = new Date(anchor).getTime();
  if (!Number.isFinite(anchorTime)) return { ready: true, dispatch_after: null, minutes_until_dispatch: 0 };
  const dispatchAfter = new Date(anchorTime - SCHEDULED_DISPATCH_LEAD_MIN * 60_000);
  const msUntil = dispatchAfter.getTime() - Date.now();
  return {
    ready: msUntil <= 0,
    dispatch_after: dispatchAfter,
    minutes_until_dispatch: Math.max(0, Math.ceil(msUntil / 60_000)),
  };
}

/** One row per user — lowest driver_id is canonical (a user can hold duplicate driver rows). */
function dedupeToCanonicalDrivers(drivers) {
  const byUser = new Map();
  for (const d of drivers) {
    if (!d.user_id) continue;
    const cur = byUser.get(d.user_id);
    if (!cur || d.driver_id < cur.driver_id) byUser.set(d.user_id, d);
  }
  return [...byUser.values()];
}

/**
 * acceptsField: which driver_profile preference flag ('accepts_food' | 'accepts_product')
 * gates this vertical — threaded through from foodDeliveryType/productDeliveryType so this
 * one candidate query serves both. Same-vertical stacking (claim-additional) is a separate,
 * driver-initiated endpoint and deliberately does not go through this busy-checked query.
 */
export async function findDeliveryDriverCandidates(pickupLat, pickupLong, excludedDriverIds = [], acceptsField = null) {
  const busy = await getBusyDriverProfileIds();
  const excluded = [...new Set([...(excludedDriverIds || []).map(Number), ...busy].filter((id) => !Number.isNaN(id)))];
  const latDelta = SEARCH_RADIUS_KM / 111;
  const longDelta = SEARCH_RADIUS_KM / (111 * Math.cos((pickupLat * Math.PI) / 180));

  const baseWhere = {
    driver_profile_id: { notIn: excluded.length ? excluded : [-1] },
    is_online: true,
    last_ping: { gte: driverPresenceCutoff() },
    driver_delivery_profile: { isNot: null },
    ...(acceptsField ? { [acceptsField]: true } : {}),
  };

  let candidates = await prisma.driver_profile.findMany({
    where: {
      ...baseWhere,
      current_lat: { gte: pickupLat - latDelta, lte: pickupLat + latDelta },
      current_long: { gte: pickupLong - longDelta, lte: pickupLong + longDelta },
    },
    select: DELIVERY_CANDIDATE_SELECT,
  });

  if (candidates.length === 0) {
    candidates = await prisma.driver_profile.findMany({
      where: baseWhere,
      select: DELIVERY_CANDIDATE_SELECT,
    });
  }

  let drivers = dedupeToCanonicalDrivers(candidates.map(flattenDeliveryCandidate));
  const driverIds = drivers.map((d) => d.driver_id).filter((id) => Number.isInteger(id) && id > 0);
  if (driverIds.length) {
    const workloadRows = await prisma.food_order.groupBy({
      by: ['driver_id'],
      where: {
        driver_id: { in: driverIds },
        OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
      },
      _count: { _all: true },
    }).catch(() => []);
    const workload = new Map(workloadRows.map((row) => [row.driver_id, row._count?._all || 0]));
    drivers = drivers.map((driver) => ({ ...driver, active_workload: workload.get(driver.driver_id) || 0 }));
  }

  return drivers
    .map((d) => {
      const withDistance = {
        ...d,
        distance_km: isValidCoord(d.current_lat, d.current_long)
          ? haversineKm(pickupLat, pickupLong, d.current_lat, d.current_long)
          : Number.POSITIVE_INFINITY,
      };
      return {
        ...withDistance,
        assignment_score: scoreDeliveryCandidate(withDistance),
        assignment_factors: assignmentFactors(withDistance),
      };
    })
    .sort((a, b) => (b.assignment_score - a.assignment_score) || (a.distance_km - b.distance_km));
}

export async function countAvailableDeliveryDriversExcluding(excludedDriverIds = [], acceptsField = null) {
  const excluded = new Set((excludedDriverIds || []).map(Number).filter((id) => !Number.isNaN(id)));
  const busy = await getBusyDriverProfileIds();
  const rows = await prisma.driver_profile.findMany({
    where: {
      is_online: true,
      last_ping: { gte: driverPresenceCutoff() },
      driver_delivery_profile: { isNot: null },
      ...(acceptsField ? { [acceptsField]: true } : {}),
    },
    select: { driver_profile_id: true, user_id: true },
  });
  const seenUsers = new Set();
  let count = 0;
  for (const row of rows) {
    if (!row.user_id || seenUsers.has(row.user_id)) continue;
    if (busy.has(row.driver_profile_id)) continue;
    seenUsers.add(row.user_id);
    if (!excluded.has(row.driver_profile_id)) count += 1;
  }
  return count;
}

/**
 * Per-vertical wiring. Two concrete instances (food, product) — kept as plain
 * objects rather than a registry since there are only two, and courier isn't
 * a third until it shares the delivery_driver identity model.
 */
export const foodDeliveryType = {
  vertical: 'food',
  acceptsField: 'accepts_food',
  idField: 'food_order_id',
  statusField: 'order_status',
  pendingStatus: 'confirmed',
  // The vendor advances a food order through these while it still needs a courier — see
  // offerableStatusesFor(). Kept in kitchen-timeline order.
  offerableStatuses: ['confirmed', 'preparing', 'ready_for_pickup'],
  model: () => prisma.food_order,
  include: {
    food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
    vendor_type: { select: { vendor_type: true } },
    food_order_items: {
      include: {
        food_item: {
          select: {
            name: true,
            allergen_info: true,
            food_category: { select: { name: true } },
          },
        },
      },
    },
  },
  /** Self-pickup never enters the courier pool — keyed off fulfillment_mode, not the address field. */
  async dispatchWhere() {
    return resolveFoodCourierDispatchWhere(prisma);
  },
  isDispatchable(order) {
    return !isFoodPickupOrder(order) && !isReservedPickupSentinel(order?.deliver_location);
  },
  async findOrder(orderId) {
    return prisma.food_order.findUnique({
      where: { food_order_id: orderId },
      include: this.include,
    });
  },
  async updateOrder(orderId, data) {
    return prisma.food_order.update({ where: { food_order_id: orderId }, data });
  },
  getPickupCoords(order) {
    const lat = order.food_vendor?.lat;
    const long = order.food_vendor?.long;
    return isValidCoord(lat, long) ? { lat, long } : null;
  },
  getPickupLabel(order) {
    return order.food_vendor?.location || order.food_vendor?.vendor_name || 'Pickup';
  },
  getDropoffLabel(order) {
    return publicDeliverLocation(order) || 'Delivery address';
  },
  getPayout(order) {
    return order.driver_earning ?? order.delivery_fee ?? null;
  },
  getVertical(order) {
    return foodOrderFlow(order);
  },
  getOfferTitle(order) {
    return foodOrderFlow(order) === 'grocery' ? 'Incoming grocery delivery' : 'Incoming delivery order';
  },
  getHandlingLabels(order) {
    return groceryHandlingLabels(order);
  },
};

/** Food kitchen statuses that may still hold a live courier offer. */
export function foodCourierOfferableStatuses() {
  return offerableStatusesFor(foodDeliveryType);
}

export const productDeliveryType = {
  vertical: 'ecommerce',
  acceptsField: 'accepts_product',
  idField: 'order_id',
  statusField: 'status',
  pendingStatus: 'confirmed',
  offerableStatuses: ['confirmed'],
  model: () => prisma.product_order,
  include: { user_product_order_seller_idTouser: { include: { storeProfile: true } } },
  async findOrder(orderId) {
    return prisma.product_order.findUnique({
      where: { order_id: orderId },
      include: this.include,
    });
  },
  async updateOrder(orderId, data) {
    return prisma.product_order.update({ where: { order_id: orderId }, data });
  },
  getPickupCoords(order) {
    const profile = order.user_product_order_seller_idTouser?.storeProfile;
    const lat = profile?.lat;
    const long = profile?.lng;
    return isValidCoord(lat, long) ? { lat, long } : null;
  },
  getPickupLabel(order) {
    return order.user_product_order_seller_idTouser?.storeProfile?.address || 'Seller location';
  },
  getDropoffLabel(order) {
    return order.delivery_address || 'Buyer location';
  },
  getPayout(order) {
    return order.delivery_fee ?? null;
  },
};

export const deliveryTypesById = {
  food_order: foodDeliveryType,
  product_order: productDeliveryType,
};

/**
 * Poll fallback for a driver's own currently-offered food/product orders — mirrors
 * ride-dispatch.js's getIncomingOffersForDriver so a dropped socket doesn't lose the offer.
 */
export async function getIncomingDeliveryOffersForDriver(driverProfileId) {
  const now = new Date();
  const offers = [];
  for (const [orderTypeKey, type] of Object.entries(deliveryTypesById)) {
    const rows = await type.model().findMany({
      where: {
        driver_id: driverProfileId,
        [type.statusField]: { in: offerableStatusesFor(type) },
        offer_expires_at: { gt: now },
      },
      include: type.include,
    });
    for (const order of rows) {
      offers.push(buildOfferPayload(type, { ...order, __typeKey: orderTypeKey }, null));
    }
  }
  return offers;
}

export function buildOfferPayload(type, order, driverDistanceKm, candidate = null) {
  const vertical = typeof type.getVertical === 'function' ? type.getVertical(order) : type.vertical;
  const handlingLabels = typeof type.getHandlingLabels === 'function' ? type.getHandlingLabels(order) : [];
  const payload = {
    order_type: order.__typeKey,
    order_id: order[type.idField],
    vertical,
    order_flow: vertical,
    offer_title: typeof type.getOfferTitle === 'function' ? type.getOfferTitle(order) : null,
    pickup_location: type.getPickupLabel(order),
    dropoff_location: type.getDropoffLabel(order),
    payout: type.getPayout(order),
    scheduled_time: order.scheduled_time?.toISOString?.() ?? null,
    delivery_window_start: order.delivery_window_start?.toISOString?.() ?? null,
    delivery_window_end: order.delivery_window_end?.toISOString?.() ?? null,
    delivery_offer_events: Array.isArray(order.delivery_offer_events) ? order.delivery_offer_events : [],
    payment_method: order.payment_method ?? null,
    expires_at: order.offer_expires_at?.toISOString?.() ?? null,
    offer_timeout_sec: DELIVERY_OFFER_TIMEOUT_SEC,
    scheduled_dispatch: scheduledDispatchWindow(order),
  };
  if (handlingLabels.length) payload.handling_labels = handlingLabels;
  if (Number.isFinite(driverDistanceKm) && driverDistanceKm >= 0) {
    payload.pickup_distance = formatDistanceKm(driverDistanceKm);
    payload.pickup_eta = formatEtaFromDistanceKm(driverDistanceKm);
  }
  if (candidate?.assignment_score != null) payload.assignment_score = candidate.assignment_score;
  if (candidate?.assignment_factors) payload.assignment_factors = candidate.assignment_factors;
  return payload;
}

function emitOfferToDriver(io, type, userId, payload) {
  const vertical = payload.vertical || type.vertical;
  io?.to(`user-${userId}`).emit(`delivery-offer-${userId}`, payload);
  notify(io, {
    userId,
    vertical,
    type: 'delivery.offer',
    urgency: 'actionable',
    title: payload.offer_title || (vertical === 'food' ? 'Incoming delivery order' : 'Delivery available'),
    body: `${payload.pickup_location} → ${payload.dropoff_location}`,
    entityType: type.orderTypeKey,
    entityId: payload.order_id,
    // Offers now surface inside the unified driver inbox (SellerDriveDashboard) regardless
    // of vertical — sd-ecommerce is the seller-side dashboard, not a driver screen.
    actionUrl: 'sd-drive',
    data: payload,
    expiresAt: payload.expires_at ? new Date(payload.expires_at) : null,
  });
}

/** Tell one driver's UI to drop an offer (declined, expired, or claimed elsewhere). */
export async function notifyDeliveryOfferClosed(io, type, driverUserId, orderTypeKey, orderId, reason = 'no_longer_available') {
  if (!io || !driverUserId) return;
  io.to(`user-${driverUserId}`).emit(`delivery-offer-closed-${driverUserId}`, {
    order_type: orderTypeKey,
    order_id: orderId,
    reason,
  });
}

async function assignAndEmitOffer(io, orderTypeKey, type, order, candidates) {
  if (!candidates.length) return null;
  const nearest = candidates[0];
  const offerExpiresAt = new Date(Date.now() + DELIVERY_OFFER_TIMEOUT_SEC * 1000);

  await type.updateOrder(order[type.idField], {
    driver_id: nearest.driver_id,
    offer_expires_at: offerExpiresAt,
    delivery_offer_events: [...safeOfferEvents(order), deliveryOfferEvent(order, nearest, 'offered')].slice(-50),
  });
  // Reuse the already-loaded `order` (with its vendor/seller include) rather than the bare
  // update() result, which drops relations not re-included on write.
  const updated = { ...order, driver_id: nearest.driver_id, offer_expires_at: offerExpiresAt, __typeKey: orderTypeKey };

  if (nearest.user_id) {
    const driverKm = Number.isFinite(nearest.distance_km) && nearest.distance_km < 1e6
      ? nearest.distance_km
      : null;
    emitOfferToDriver(io, { ...type, orderTypeKey }, nearest.user_id, buildOfferPayload(type, updated, driverKm, nearest));
  }

  return nearest.driver_id;
}

/** Dispatch a newly-confirmed order to the nearest available driver. Call this when the order enters its "pending" status. */
export async function dispatchDeliveryOrder(io, orderTypeKey, orderId, excludedDriverIds = []) {
  const type = deliveryTypesById[orderTypeKey];
  const order = await type.findOrder(orderId);
  if (!order) return null;
  const dispatchWindow = scheduledDispatchWindow(order);
  if (!dispatchWindow.ready) return null;

  // Self-pickup / non-courier orders never enter the driver pool.
  if (typeof type.isDispatchable === 'function' && !type.isDispatchable(order)) return null;

  if (!offerableStatusesFor(type).includes(order[type.statusField])) return null;

  // Idempotent by design: this fires from several triggers (payment-confirm, vendor accept,
  // ready-for-pickup, orphan sweep). If the order already holds a live offer or an accepted
  // driver, don't stomp it with a fresh assignment. Re-offer/expiry paths always clear driver_id
  // *before* calling here, so they're unaffected by this guard.
  if (order.driver_id != null) return null;

  let pickup = type.getPickupCoords(order);
  // If the storefront address was updated without coordinates (legacy rows), geocode once so
  // dispatch doesn't silently no-op and leave the guest without a courier / OTP path.
  if (!pickup && orderTypeKey === 'food_order' && order.food_vendor?.location) {
    const geo = await geocodeAddress(order.food_vendor.location);
    if (geo?.lat != null && geo?.lng != null) {
      pickup = { lat: geo.lat, long: geo.lng };
      const vendorId = order.vendor_id ?? order.food_vendor?.vendor_id;
      if (vendorId) {
        await prisma.food_vendor.update({
          where: { vendor_id: vendorId },
          data: { lat: geo.lat, long: geo.lng },
        }).catch(() => { /* best-effort backfill */ });
      }
    }
  }
  if (!pickup) return null;

  const labels = typeof type.getHandlingLabels === 'function' ? type.getHandlingLabels(order) : [];
  const candidates = await findDeliveryDriverCandidates(pickup.lat, pickup.long, excludedDriverIds, type.acceptsField);
  if (candidates.length === 0) return null;
  const eligibleCandidates = candidates.filter((candidate) => driverMatchesHandlingLabels(candidate, labels, order));
  if (labels.length && eligibleCandidates.length === 0) return null;
  const rankedCandidates = (eligibleCandidates.length ? eligibleCandidates : candidates)
    .map((candidate) => ({
      ...candidate,
      assignment_score: scoreDeliveryCandidate(candidate, labels, order),
      assignment_factors: assignmentFactors(candidate, labels, order),
    }))
    .sort((a, b) => (b.assignment_score - a.assignment_score) || (a.distance_km - b.distance_km));

  return assignAndEmitOffer(io, orderTypeKey, type, order, rankedCandidates);
}

export async function canDriverHandleFoodOrder(tx, driverProfileId, order) {
  const db = tx || prisma;
  const row = await db.driver_profile.findUnique({
    where: { driver_profile_id: Number(driverProfileId) },
    select: DELIVERY_CANDIDATE_SELECT,
  });
  if (!row) return { ok: false, reason: 'driver_not_found' };
  const driver = flattenDeliveryCandidate(row);
  const labels = groceryHandlingLabels(order);
  const ok = driverMatchesHandlingLabels(driver, labels, order);
  return {
    ok,
    reason: ok ? null : 'capacity_mismatch',
    handling_labels: labels,
    assignment_factors: assignmentFactors(driver, labels, order),
  };
}

function foodOrderStop(order) {
  const pickupLat = order?.food_vendor?.lat;
  const pickupLong = order?.food_vendor?.long;
  const dropLat = order?.delivery_lat;
  const dropLong = order?.delivery_lng;
  return {
    order_id: order?.food_order_id,
    pickup: isValidCoord(pickupLat, pickupLong)
      ? { lat: pickupLat, long: pickupLong, label: order?.food_vendor?.vendor_name || 'Store pickup' }
      : null,
    dropoff: isValidCoord(dropLat, dropLong)
      ? { lat: dropLat, long: dropLong, label: publicDeliverLocation(order) || 'Customer drop-off' }
      : { lat: null, long: null, label: publicDeliverLocation(order) || 'Customer drop-off' },
    delivery_window_start: order?.delivery_window_start?.toISOString?.() ?? null,
    delivery_window_end: order?.delivery_window_end?.toISOString?.() ?? null,
    handling_labels: groceryHandlingLabels(order),
  };
}

function courierOrderStop(order) {
  const pickupLat = order?.start_location_lat;
  const pickupLong = order?.start_location_long;
  const dropLat = order?.end_location_lat;
  const dropLong = order?.end_location_long;
  return {
    order_type: 'courier_order',
    order_id: order?.courier_order_id,
    pickup: isValidCoord(pickupLat, pickupLong)
      ? { lat: pickupLat, long: pickupLong, label: order?.start_location_address || 'Courier pickup' }
      : null,
    dropoff: isValidCoord(dropLat, dropLong)
      ? { lat: dropLat, long: dropLong, label: order?.end_location_address || 'Courier drop-off' }
      : { lat: null, long: null, label: order?.end_location_address || 'Courier drop-off' },
    delivery_window_start: order?.pickup_date?.toISOString?.() ?? null,
    delivery_window_end: order?.deliver_date?.toISOString?.() ?? null,
    handling_labels: [],
  };
}

function productOrderStop(order) {
  const pickup = productDeliveryType.getPickupCoords(order);
  return {
    order_type: 'product_order',
    order_id: order?.order_id,
    pickup: pickup ? { ...pickup, label: productDeliveryType.getPickupLabel(order) } : null,
    dropoff: isValidCoord(order?.delivery_lat, order?.delivery_lng)
      ? { lat: order.delivery_lat, long: order.delivery_lng, label: productDeliveryType.getDropoffLabel(order) }
      : { lat: null, long: null, label: productDeliveryType.getDropoffLabel(order) },
    delivery_window_start: null,
    delivery_window_end: null,
    handling_labels: [],
    driver_payout: productDeliveryType.getPayout(order),
  };
}

function nearestNeighborDropoffRoute(start, stops) {
  const remaining = stops.filter((stop) => isValidCoord(stop.dropoff?.lat, stop.dropoff?.long));
  const missing = stops.filter((stop) => !isValidCoord(stop.dropoff?.lat, stop.dropoff?.long));
  const ordered = [];
  let cursor = start;
  let totalKm = 0;
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const stop = remaining[i];
      const distance = haversineKm(cursor.lat, cursor.long, stop.dropoff.lat, stop.dropoff.long);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    totalKm += Number.isFinite(bestDistance) ? bestDistance : 0;
    ordered.push({ ...next, sequence: ordered.length + 1, leg_distance_km: Number(bestDistance.toFixed(2)) });
    cursor = { lat: next.dropoff.lat, long: next.dropoff.long };
  }
  return {
    ordered: [
      ...ordered,
      ...missing.map((stop, index) => ({ ...stop, sequence: ordered.length + index + 1, leg_distance_km: null })),
    ],
    totalKm,
    complete: missing.length === 0,
  };
}

function nearestNeighborWaypointRoute(start, waypoints) {
  const remaining = waypoints.filter((point) => isValidCoord(point?.lat, point?.long));
  const missing = waypoints.filter((point) => !isValidCoord(point?.lat, point?.long));
  const ordered = [];
  let cursor = start;
  let totalKm = 0;
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const point = remaining[i];
      const distance = haversineKm(cursor.lat, cursor.long, point.lat, point.long);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    totalKm += Number.isFinite(bestDistance) ? bestDistance : 0;
    ordered.push({ ...next, sequence: ordered.length + 1, leg_distance_km: Number(bestDistance.toFixed(2)) });
    cursor = { lat: next.lat, long: next.long };
  }
  return {
    ordered: [
      ...ordered,
      ...missing.map((point, index) => ({ ...point, sequence: ordered.length + index + 1, leg_distance_km: null })),
    ],
    totalKm,
    complete: missing.length === 0,
  };
}

function deliveryRunWaypoints(stops) {
  return (Array.isArray(stops) ? stops : []).flatMap((stop) => {
    const id = `${stop.order_type}:${stop.order_id}`;
    return [
      stop.pickup && {
        kind: 'pickup',
        order_key: id,
        order_type: stop.order_type,
        order_id: stop.order_id,
        lat: stop.pickup.lat,
        long: stop.pickup.long,
        label: stop.pickup.label,
      },
      stop.dropoff && {
        kind: 'dropoff',
        order_key: id,
        order_type: stop.order_type,
        order_id: stop.order_id,
        lat: stop.dropoff.lat,
        long: stop.dropoff.long,
        label: stop.dropoff.label,
      },
    ].filter(Boolean);
  });
}

function pickupThenDropoffRoute(start, stops) {
  const pickupRoute = nearestNeighborWaypointRoute(
    start,
    deliveryRunWaypoints(stops).filter((point) => point.kind === 'pickup')
  );
  const pickupEnd = pickupRoute.ordered.length
    ? pickupRoute.ordered[pickupRoute.ordered.length - 1]
    : start;
  const dropoffRoute = nearestNeighborWaypointRoute(
    { lat: pickupEnd.lat, long: pickupEnd.long },
    deliveryRunWaypoints(stops).filter((point) => point.kind === 'dropoff')
  );
  return {
    ordered: [
      ...pickupRoute.ordered,
      ...dropoffRoute.ordered.map((point, index) => ({ ...point, sequence: pickupRoute.ordered.length + index + 1 })),
    ],
    totalKm: pickupRoute.totalKm + dropoffRoute.totalKm,
    complete: pickupRoute.complete && dropoffRoute.complete,
  };
}

export async function refreshFoodDeliveryBatchRoutePlan(tx, batchId, driverProfileId) {
  const db = tx || prisma;
  const id = Number(batchId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const driverId = Number(driverProfileId);
  const driver = Number.isInteger(driverId) && driverId > 0
    ? await db.driver_profile.findUnique({
      where: { driver_profile_id: driverId },
      select: { current_lat: true, current_long: true },
    })
    : null;
  const orders = await db.food_order.findMany({
    where: {
      batch_id: id,
      OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
    },
    include: foodDeliveryType.include,
    orderBy: [
      { delivery_window_start: 'asc' },
      { food_order_id: 'asc' },
    ],
  });
  const courierOrders = await db.courier_order.findMany({
    where: {
      batch_id: id,
      OR: [{ status: null }, { status: { notIn: ['delivered', 'cancelled'] } }],
    },
    orderBy: [
      { pickup_date: 'asc' },
      { courier_order_id: 'asc' },
    ],
  });
  const productOrders = await db.product_order.findMany({
    where: {
      batch_id: id,
      OR: [{ status: null }, { status: { notIn: ['fulfilled', 'cancelled'] } }],
    },
    include: productDeliveryType.include,
    orderBy: { order_id: 'asc' },
  });
  if (!orders.length && !courierOrders.length && !productOrders.length) {
    await db.delivery_batch.update({
      where: { batch_id: id },
      data: { status: 'completed', order_count: 0, total_distance_km: 0, route_plan: { complete: true, stops: [] } },
    }).catch(() => null);
    return null;
  }

  const stops = [
    ...orders.map((order) => ({ ...foodOrderStop(order), order_type: 'food_order' })),
    ...courierOrders.map(courierOrderStop),
    ...productOrders.map(productOrderStop),
  ];
  const firstPickup = stops.find((stop) => stop.pickup)?.pickup || null;
  const start = isValidCoord(driver?.current_lat, driver?.current_long)
    ? { lat: driver.current_lat, long: driver.current_long }
    : firstPickup;
  const route = start
    ? pickupThenDropoffRoute(start, stops)
    : { ordered: deliveryRunWaypoints(stops).map((stop, index) => ({ ...stop, sequence: index + 1, leg_distance_km: null })), totalKm: 0, complete: false };
  const routePlan = {
    optimized_by: 'nearest_neighbor_v1',
    complete: Boolean(start && route.complete),
    start,
    pickup: firstPickup,
    pickup_stops: stops.map((stop, index) => ({ ...stop.pickup, order_type: stop.order_type, order_id: stop.order_id, sequence: index + 1 })).filter((stop) => stop.lat != null),
    dropoff_stops: stops.map((stop, index) => ({ ...stop.dropoff, order_type: stop.order_type, order_id: stop.order_id, sequence: index + 1 })).filter((stop) => stop.lat != null),
    stops,
    waypoints: route.ordered,
    generated_at: new Date().toISOString(),
  };
  const totalDistance = Number(route.totalKm.toFixed(2));
  const earningsBreakdown = {};
  const etaByOrder = {};
  route.ordered.forEach((stop, index) => {
    const key = `${stop.order_type}:${stop.order_id}`;
    const payout = Number(stop.driver_payout ?? 0);
    earningsBreakdown[key] = {
      order_type: stop.order_type,
      order_id: stop.order_id,
      payout: Number.isFinite(payout) ? payout : 0,
    };
    etaByOrder[key] = {
      sequence: index + 1,
      eta_min: Number.isFinite(stop.leg_distance_km) ? Math.max(1, Math.round((stop.leg_distance_km / 30) * 60)) : null,
    };
  });
  await db.delivery_batch.update({
    where: { batch_id: id },
    data: {
      status: 'active',
      order_count: stops.length,
      total_distance_km: totalDistance,
      earnings_breakdown: earningsBreakdown,
      eta_by_order: etaByOrder,
      route_plan: {
        ...routePlan,
        verticals: [...new Set(stops.map((stop) => stop.order_type))],
      },
      vertical: [...new Set(stops.map((stop) => stop.order_type))].length > 1
        ? 'mixed'
        : (stops[0]?.order_type === 'courier_order' ? 'courier' : stops[0]?.order_type === 'product_order' ? 'product' : 'food'),
    },
  });
  return { ...routePlan, total_distance_km: totalDistance };
}

async function loadDeliveryRunCandidate(db, orderType, orderId) {
  if (orderType === 'food_order') {
    return db.food_order.findUnique({
      where: { food_order_id: Number(orderId) },
      include: foodDeliveryType.include,
    });
  }
  if (orderType === 'courier_order') {
    return db.courier_order.findUnique({ where: { courier_order_id: Number(orderId) } });
  }
  return null;
}

function deliveryRunCandidateStop(orderType, order) {
  if (orderType === 'food_order') return foodOrderStop(order);
  if (orderType === 'courier_order') return courierOrderStop(order);
  return null;
}

function deliveryRunCandidatePayout(orderType, order) {
  if (orderType === 'food_order') return Number(foodDeliveryType.getPayout(order));
  if (orderType === 'courier_order') {
    const price = Number(order?.price);
    return Number.isFinite(price) && price > 0 ? Number((price * 0.79).toFixed(2)) : null;
  }
  return null;
}

function routeDistanceWithCandidate(routePlan, candidateStop) {
  const existingStops = Array.isArray(routePlan?.stops) ? routePlan.stops : [];
  const start = routePlan?.start || routePlan?.pickup || candidateStop?.pickup;
  if (!start || !candidateStop?.pickup || !candidateStop?.dropoff) {
    return { complete: false, total_distance_km: null, incremental_distance_km: null, incremental_duration_min: null };
  }
  const ordered = pickupThenDropoffRoute(start, [...existingStops, candidateStop]);
  if (!ordered.complete) {
    return { complete: false, total_distance_km: null, incremental_distance_km: null, incremental_duration_min: null };
  }
  const base = Number(routePlan?.total_distance_km ?? routePlan?.totalDistance ?? 0) || 0;
  const total = Number(ordered.totalKm.toFixed(2));
  const incremental = Math.max(0, Number((total - base).toFixed(2)));
  return {
    complete: true,
    total_distance_km: total,
    incremental_distance_km: incremental,
    incremental_duration_min: Math.max(1, Math.round((incremental / 30) * 60)),
  };
}

function deliveryWindowStillValid(orderType, order, extraMinutes = 0) {
  const rawEnd = orderType === 'food_order' ? order?.delivery_window_end : order?.deliver_date;
  if (!rawEnd) return true;
  const end = new Date(rawEnd).getTime();
  if (!Number.isFinite(end)) return true;
  return Date.now() + Math.max(0, Number(extraMinutes) || 0) * 60_000 <= end;
}

export async function evaluateDeliveryRunCandidate(tx, batchId, driverProfileId, orderType, orderId) {
  const db = tx || prisma;
  const [batch, driverRow, order] = await Promise.all([
    db.delivery_batch.findFirst({
      where: { batch_id: Number(batchId), driver_profile_id: Number(driverProfileId), status: 'active' },
    }),
    db.driver_profile.findUnique({ where: { driver_profile_id: Number(driverProfileId) }, select: DELIVERY_CANDIDATE_SELECT }),
    loadDeliveryRunCandidate(db, orderType, orderId),
  ]);
  if (!batch || !driverRow || !order) return { ok: false, reason: 'not_found' };
  const driver = flattenDeliveryCandidate(driverRow);
  const candidateStop = deliveryRunCandidateStop(orderType, order);
  if (!candidateStop?.pickup || !candidateStop?.dropoff) return { ok: false, reason: 'missing_route_coords' };

  if (orderType === 'food_order') {
    if (order.driver_id || order.batch_id || !foodCourierOfferableStatuses().includes(order.order_status)) {
      return { ok: false, reason: 'order_not_available' };
    }
    if (typeof foodDeliveryType.isDispatchable === 'function' && !foodDeliveryType.isDispatchable(order)) {
      return { ok: false, reason: 'not_courier_delivery' };
    }
    if (isGroceryLike(order) && !driverMatchesHandlingLabels(driver, groceryHandlingLabels(order), order)) {
      return { ok: false, reason: 'driver_capacity_mismatch' };
    }
  } else if (orderType === 'courier_order') {
    if (order.courier_service_provider_id || order.batch_id || String(order.status || '').toLowerCase() !== 'pending') {
      return { ok: false, reason: 'order_not_available' };
    }
    if (driver.accepts_courier !== true) return { ok: false, reason: 'driver_not_accepting_courier' };
  } else {
    return { ok: false, reason: 'unsupported_order_type' };
  }

  const activeFoodCount = await db.food_order.count({
    where: { batch_id: batch.batch_id, OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }] },
  });
  const activeCourierCount = await db.courier_order.count({
    where: { batch_id: batch.batch_id, OR: [{ status: null }, { status: { notIn: ['delivered', 'cancelled'] } }] },
  });
  const maxBatchOrders = Math.max(1, Number(driver.max_batch_orders) || DEFAULT_MAX_BATCH_ORDERS);
  if (activeFoodCount + activeCourierCount + 1 > maxBatchOrders) return { ok: false, reason: 'batch_capacity_exceeded' };

  const currentRoute = batch.route_plan?.stops ? batch.route_plan : await refreshFoodDeliveryBatchRoutePlan(db, batch.batch_id, driver.driver_id);
  const baseRouteDistanceKm = currentRoute?.total_distance_km ?? batch.total_distance_km;
  const distance = routeDistanceWithCandidate(
    { ...(currentRoute || {}), total_distance_km: baseRouteDistanceKm },
    { ...candidateStop, order_type: orderType, order_id: orderType === 'food_order' ? order.food_order_id : order.courier_order_id, driver_payout: deliveryRunCandidatePayout(orderType, order) }
  );
  if (!distance.complete) return { ok: false, reason: 'route_not_optimizable' };
  if (!deliveryWindowStillValid(orderType, order, distance.incremental_duration_min)) {
    return { ok: false, reason: 'delivery_window_expired' };
  }
  const maxDistance = Number(driver.max_batch_distance_km) || DEFAULT_MAX_BATCH_DISTANCE_KM;
  if (distance.total_distance_km > maxDistance) return { ok: false, reason: 'batch_route_too_long' };
  if (orderType === 'food_order' && foodOrderFlow(order) === 'food' && distance.incremental_duration_min > HOT_FOOD_MAX_BUNDLE_DELAY_MIN) {
    return { ok: false, reason: 'hot_food_delay_too_high' };
  }

  return {
    ok: true,
    reason: null,
    batch_id: batch.batch_id,
    order_type: orderType,
    order_id: orderType === 'food_order' ? order.food_order_id : order.courier_order_id,
    incremental_distance_km: distance.incremental_distance_km,
    incremental_duration_min: distance.incremental_duration_min,
    incremental_payout: deliveryRunCandidatePayout(orderType, order),
    compatibility: {
      optimized_by: 'nearest_neighbor_v1',
      total_distance_km: distance.total_distance_km,
      handling_labels: orderType === 'food_order' ? groceryHandlingLabels(order) : [],
      safeguards: {
        capacity_ok: true,
        route_window_ok: true,
        hot_food_delay_ok: true,
        customer_addresses_private: true,
      },
    },
  };
}

function isGroceryLike(order) {
  return foodOrderFlow(order) === 'grocery';
}

export async function suggestDeliveryRunOffers(tx, batchId, driverProfileId, limit = 5) {
  const db = tx || prisma;
  const batch = await db.delivery_batch.findFirst({
    where: { batch_id: Number(batchId), driver_profile_id: Number(driverProfileId), status: 'active' },
    select: { batch_id: true },
  });
  if (!batch) return { ok: false, reason: 'delivery_run_not_found', offers: [] };

  const foodCourierWhere = await resolveFoodCourierDispatchWhere(db);
  const [foodCandidates, courierCandidates] = await Promise.all([
    db.food_order.findMany({
      where: {
        driver_id: null,
        batch_id: null,
        order_status: { in: foodCourierOfferableStatuses() },
        OR: [{ delivery_window_end: null }, { delivery_window_end: { gt: new Date() } }],
        ...foodCourierWhere,
      },
      include: foodDeliveryType.include,
      orderBy: [
        { delivery_window_start: 'asc' },
        { food_order_id: 'asc' },
      ],
      take: 25,
    }),
    db.courier_order.findMany({
      where: {
        courier_service_provider_id: null,
        batch_id: null,
        status: 'pending',
        OR: [{ deliver_date: null }, { deliver_date: { gt: new Date() } }],
      },
      orderBy: [
        { pickup_date: 'asc' },
        { courier_order_id: 'asc' },
      ],
      take: 25,
    }),
  ]);

  const evaluated = [];
  for (const order of foodCandidates) {
    const result = await evaluateDeliveryRunCandidate(db, batch.batch_id, driverProfileId, 'food_order', order.food_order_id);
    if (result.ok) evaluated.push(result);
  }
  for (const order of courierCandidates) {
    const result = await evaluateDeliveryRunCandidate(db, batch.batch_id, driverProfileId, 'courier_order', order.courier_order_id);
    if (result.ok) evaluated.push(result);
  }

  const sorted = evaluated
    .sort((a, b) => (
      (a.incremental_duration_min ?? 999) - (b.incremental_duration_min ?? 999)
      || (b.incremental_payout ?? 0) - (a.incremental_payout ?? 0)
    ))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));

  const offers = [];
  for (const candidate of sorted) {
    const created = await createDeliveryRunOffer(db, batch.batch_id, driverProfileId, candidate.order_type, candidate.order_id);
    if (created.ok) offers.push(created.offer);
  }
  return { ok: true, offers };
}

export async function createDeliveryRunOffer(tx, batchId, driverProfileId, orderType, orderId) {
  const db = tx || prisma;
  const evaluation = await evaluateDeliveryRunCandidate(db, batchId, driverProfileId, orderType, orderId);
  if (!evaluation.ok) return evaluation;
  const existing = await db.delivery_run_offer.findUnique({
    where: {
      batch_id_order_type_order_id: {
        batch_id: Number(batchId),
        order_type: orderType,
        order_id: Number(orderId),
      },
    },
  });
  if (['accepted', 'rejected'].includes(String(existing?.status || '').toLowerCase())) {
    return { ok: false, reason: `offer_already_${existing.status}` };
  }
  const expiresAt = new Date(Date.now() + DELIVERY_RUN_OFFER_TIMEOUT_SEC * 1000);
  const offer = await db.delivery_run_offer.upsert({
    where: {
      batch_id_order_type_order_id: {
        batch_id: Number(batchId),
        order_type: orderType,
        order_id: Number(orderId),
      },
    },
    update: {
      status: 'pending',
      driver_profile_id: Number(driverProfileId),
      incremental_distance_km: evaluation.incremental_distance_km,
      incremental_duration_min: evaluation.incremental_duration_min,
      incremental_payout: evaluation.incremental_payout,
      compatibility: evaluation.compatibility,
      rejection_reason: null,
      expires_at: expiresAt,
      decided_at: null,
    },
    create: {
      batch_id: Number(batchId),
      order_type: orderType,
      order_id: Number(orderId),
      driver_profile_id: Number(driverProfileId),
      status: 'pending',
      incremental_distance_km: evaluation.incremental_distance_km,
      incremental_duration_min: evaluation.incremental_duration_min,
      incremental_payout: evaluation.incremental_payout,
      compatibility: evaluation.compatibility,
      expires_at: expiresAt,
    },
  });
  return { ok: true, offer };
}

export async function decideDeliveryRunOffer(tx, offerId, driverProfileId, action, reason = null) {
  const db = tx || prisma;
  const normalizedAction = String(action || '').toLowerCase();
  const offer = await db.delivery_run_offer.findFirst({
    where: {
      delivery_run_offer_id: Number(offerId),
      driver_profile_id: Number(driverProfileId),
      status: 'pending',
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
    },
  });
  if (!offer) return { ok: false, reason: 'offer_not_available' };
  if (normalizedAction === 'rejected') {
    const rejected = await db.delivery_run_offer.update({
      where: { delivery_run_offer_id: offer.delivery_run_offer_id },
      data: { status: 'rejected', rejection_reason: String(reason || '').slice(0, 255) || null, decided_at: new Date() },
    });
    return { ok: true, offer: rejected };
  }
  if (normalizedAction !== 'accepted') return { ok: false, reason: 'invalid_action' };

  const evaluation = await evaluateDeliveryRunCandidate(db, offer.batch_id, driverProfileId, offer.order_type, offer.order_id);
  if (!evaluation.ok) return evaluation;
  if (offer.order_type === 'food_order') {
    const order = await db.food_order.findUnique({ where: { food_order_id: offer.order_id }, include: foodDeliveryType.include });
    const nextStatus = isGroceryLike(order) ? 'dispatched' : 'preparing';
    const courierWhere = await resolveFoodCourierDispatchWhere(db);
    const claimed = await db.food_order.updateMany({
      where: {
        food_order_id: offer.order_id,
        order_status: { in: foodCourierOfferableStatuses() },
        driver_id: null,
        batch_id: null,
        ...courierWhere,
      },
      data: {
        order_status: nextStatus,
        driver_id: Number(driverProfileId),
        batch_id: offer.batch_id,
        offer_expires_at: null,
        driver_accepted_at: new Date(),
        driver_earning: order.driver_earning ?? order.delivery_fee ?? null,
        last_update: new Date(),
      },
    });
    if (claimed.count === 0) return { ok: false, reason: 'order_not_available' };
  } else if (offer.order_type === 'courier_order') {
    const claimed = await db.courier_order.updateMany({
      where: { courier_order_id: offer.order_id, status: 'pending', courier_service_provider_id: null, batch_id: null },
      data: {
        status: 'accepted',
        courier_service_provider_id: Number(driverProfileId),
        batch_id: offer.batch_id,
        last_update: new Date(),
      },
    });
    if (claimed.count === 0) return { ok: false, reason: 'order_not_available' };
  }
  const accepted = await db.delivery_run_offer.update({
    where: { delivery_run_offer_id: offer.delivery_run_offer_id },
    data: { status: 'accepted', decided_at: new Date(), compatibility: evaluation.compatibility },
  });
  const routePlan = await refreshFoodDeliveryBatchRoutePlan(db, offer.batch_id, driverProfileId);
  return { ok: true, offer: accepted, route_plan: routePlan };
}

export async function findOrCreateDriverDeliveryBatch(tx, driverProfileId, preferredVertical = 'mixed') {
  const db = tx || prisma;
  const driverId = Number(driverProfileId);
  if (!Number.isInteger(driverId) || driverId <= 0) return null;
  const existing = await db.delivery_batch.findFirst({
    where: { driver_profile_id: driverId, status: 'active' },
    orderBy: { created_at: 'desc' },
  });
  if (existing) return existing;
  return db.delivery_batch.create({
    data: { driver_profile_id: driverId, vertical: preferredVertical },
  });
}

export async function assignDeliveryOrderToDriver(io, orderTypeKey, orderId, driverProfileId, reason = 'manual_reassignment') {
  const type = deliveryTypesById[orderTypeKey];
  const order = await type.findOrder(orderId);
  if (!order || !offerableStatusesFor(type).includes(order[type.statusField])) return null;
  if (typeof type.isDispatchable === 'function' && !type.isDispatchable(order)) return null;

  const pickup = type.getPickupCoords(order);
  if (!pickup) return null;

  const row = await prisma.driver_profile.findFirst({
    where: {
      driver_profile_id: Number(driverProfileId),
      is_online: true,
      last_ping: { gte: driverPresenceCutoff() },
      driver_delivery_profile: { isNot: null },
      ...(type.acceptsField ? { [type.acceptsField]: true } : {}),
    },
    select: DELIVERY_CANDIDATE_SELECT,
  });
  if (!row) return null;

  const labels = typeof type.getHandlingLabels === 'function' ? type.getHandlingLabels(order) : [];
  const candidate = flattenDeliveryCandidate(row);
  const withDistance = {
    ...candidate,
    distance_km: isValidCoord(candidate.current_lat, candidate.current_long)
      ? haversineKm(pickup.lat, pickup.long, candidate.current_lat, candidate.current_long)
      : Number.POSITIVE_INFINITY,
  };
  if (!driverMatchesHandlingLabels(withDistance, labels, order)) return null;

  const scored = {
    ...withDistance,
    assignment_score: scoreDeliveryCandidate(withDistance, labels, order),
    assignment_factors: assignmentFactors(withDistance, labels, order),
  };
  const offerExpiresAt = new Date(Date.now() + DELIVERY_OFFER_TIMEOUT_SEC * 1000);
  await type.updateOrder(order[type.idField], {
    driver_id: scored.driver_id,
    offer_expires_at: offerExpiresAt,
    delivery_offer_events: [
      ...safeOfferEvents(order),
      deliveryOfferEvent(order, scored, 'manual_reassigned', { reason }),
      deliveryOfferEvent(order, scored, 'offered', { reason }),
    ].slice(-50),
  });
  const updated = { ...order, driver_id: scored.driver_id, offer_expires_at: offerExpiresAt, __typeKey: orderTypeKey };
  if (scored.user_id) {
    emitOfferToDriver(io, { ...type, orderTypeKey }, scored.user_id, buildOfferPayload(type, updated, scored.distance_km, scored));
  }
  return scored.driver_id;
}

/** After a driver declines: mark declined, re-offer to the next nearest candidate. */
export async function reofferDeliveryOrderAfterDecline(io, orderTypeKey, orderId, decliningDriverId) {
  const type = deliveryTypesById[orderTypeKey];
  const order = await type.findOrder(orderId);
  if (!order || !offerableStatusesFor(type).includes(order[type.statusField])) {
    return { reoffered: false };
  }

  const excluded = [...new Set([...(order.declined_driver_ids || []).map(Number), Number(decliningDriverId)])]
    .filter((id) => !Number.isNaN(id));
  const auditDriver = await driverOfferAuditDriver(decliningDriverId, type, order);

  await type.updateOrder(orderId, {
    driver_id: null,
    offer_expires_at: null,
    declined_driver_ids: excluded,
    delivery_offer_events: [
      ...safeOfferEvents(order),
      deliveryOfferEvent(order, auditDriver, 'rejected', { reason: 'driver_declined' }),
    ].slice(-50),
  });

  const next = await dispatchDeliveryOrder(io, orderTypeKey, orderId, excluded);
  return { reoffered: next != null, next_driver_id: next };
}

/** Cron sweep: re-offer or drop any offer whose timeout has elapsed without a response. */
export async function processExpiredDeliveryOffers(io) {
  const now = new Date();

  for (const [orderTypeKey, type] of Object.entries(deliveryTypesById)) {
    const expired = await type.model().findMany({
      where: {
        [type.statusField]: { in: offerableStatusesFor(type) },
        driver_id: { not: null },
        offer_expires_at: { lt: now },
      },
    });

    for (const order of expired) {
      const timedOutDriverId = order.driver_id;
      const declined = order.declined_driver_ids || [];
      const excluded = [...new Set([...declined.map(Number), Number(timedOutDriverId)])].filter((id) => !Number.isNaN(id));
      const auditDriver = await driverOfferAuditDriver(timedOutDriverId, type, order);

      const driverRow = timedOutDriverId
        ? await prisma.driver_profile.findUnique({ where: { driver_profile_id: timedOutDriverId }, select: { user_id: true } })
        : null;
      if (driverRow?.user_id) {
        await notifyDeliveryOfferClosed(io, type, driverRow.user_id, orderTypeKey, order[type.idField], 'expired');
      }

      await type.updateOrder(order[type.idField], {
        driver_id: null,
        offer_expires_at: null,
        declined_driver_ids: excluded,
        delivery_offer_events: [
          ...safeOfferEvents(order),
          deliveryOfferEvent(order, auditDriver, 'timed_out', { reason: 'offer_expired' }),
        ].slice(-50),
      });

      let next = await dispatchDeliveryOrder(io, orderTypeKey, order[type.idField], excluded);
      if (!next) {
        // No one left outside the exclude set — give the full candidate pool one more pass
        // in case a driver came online since the last exclude list was built.
        next = await dispatchDeliveryOrder(io, orderTypeKey, order[type.idField], declined);
      }
      // If still nobody, the order just sits unassigned — it'll be retried on the next sweep
      // and remains visible to ops via the order's driver_id: null state.
    }
  }
}

/** Retry orders that reached "pending" but got zero candidates at dispatch time (e.g. no driver online yet). */
export async function redispatchOrphanedDeliveryOrders(io) {
  for (const [orderTypeKey, type] of Object.entries(deliveryTypesById)) {
    const extraWhere = typeof type.dispatchWhere === 'function'
      ? await type.dispatchWhere()
      : (type.dispatchWhere || {});
    const orphaned = await type.model().findMany({
      where: {
        [type.statusField]: { in: offerableStatusesFor(type) },
        driver_id: null,
        ...extraWhere,
      },
      orderBy: { [type.idField]: 'asc' },
      take: 20,
    });
    for (const order of orphaned) {
      const excluded = order.declined_driver_ids || [];
      await dispatchDeliveryOrder(io, orderTypeKey, order[type.idField], excluded).catch(() => null);
    }
  }
}

export function startDeliveryDispatchCron(io) {
  scheduleInterval('delivery-dispatch', () => {
    processExpiredDeliveryOffers(io).catch((err) => console.error('[delivery-dispatch] cron sweep failed:', err.message));
    redispatchOrphanedDeliveryOrders(io).catch((err) => console.error('[delivery-dispatch] orphan sweep failed:', err.message));
  }, 5_000);
}
