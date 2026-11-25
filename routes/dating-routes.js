import express from 'express';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { notify } from '../services/notify.js';
import {
  blockedGraphForUser,
  closeDirectChatsBetweenUsers,
  createPlatformBlockBetweenUsers,
  deletePlatformBlockBetweenUsers,
  outgoingBlockedGraphForUser,
} from '../utils/platform-blocks.js';
import { cancelRideRequest } from '../utils/ride-dispatch.js';
import { assertCanCancelRide } from '../utils/ride-state-machine.js';
import { appPublicBase, emitUserMail } from '../utils/emit-user-mail.js';

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const DATE_MODES = new Set(['standard', 'true-love']);
const SWIPE_ACTIONS = new Set(['like', 'pass', 'super_like', 'block']);
const PAYMENT_SPLITS = new Set(['100', '50', 'guest']);
const PLAN_STATUSES = new Set(['draft', 'published', 'confirmed', 'cancelled', 'completed']);
const INVITE_RESPONSES = new Set(['accepted', 'declined']);
const MAX_RADIUS_KM = 100;
const BLIND_QUEUE_MINUTES = 20;
const BLIND_SESSION_HOURS = 24;
const BLIND_ACTIVE_STATUSES = ['chatting', 'reveal_requested', 'revealed'];
const BLIND_REVEAL_DEFAULT_MESSAGES = 6;
const BLIND_REVEAL_DEFAULT_MINUTES = 10;
const CROSSED_PATH_RETENTION_DAYS = clampInt(process.env.DATING_CROSSED_PATH_RETENTION_DAYS, 14, 1, 30);
const CROSSED_PATH_BUCKET_MINUTES = clampInt(process.env.DATING_CROSSED_PATH_BUCKET_MINUTES, 60, 30, 240);
const CROSSED_PATH_DELAY_MINUTES = clampInt(process.env.DATING_CROSSED_PATH_DELAY_MINUTES, 60, 30, 120);
const CROSSED_PATH_GRID_DECIMALS = clampInt(process.env.DATING_CROSSED_PATH_GRID_DECIMALS, 2, 1, 3);
const CROSSED_PATH_MAX_LOCATION_DRIFT_KM = clampInt(process.env.DATING_CROSSED_PATH_MAX_LOCATION_DRIFT_KM, 5, 1, 25);
const CROSSED_PATH_MAX_CELLS_PER_BUCKET = clampInt(process.env.DATING_CROSSED_PATH_MAX_CELLS_PER_BUCKET, 3, 1, 10);
const crossedPathEventLimiter = rateLimit({ windowSec: 3600, max: 60, keyPrefix: 'dating-crossed-path-event' });
const BLIND_ICEBREAKER_DEFAULTS = [
  'What kind of evening are you hoping for?',
  'What food would you never say no to?',
  'What is an underrated green flag?',
];
const DISCOVER_FILTERS = new Set(['nearby', 'intentional', 'food_match', 'music_match', 'active_today']);
const DATING_PROFILE_CONTENT_FIELDS = [
  'display_name',
  'bio',
  'gender',
  'interested_in',
  'location_label',
  'lat',
  'lng',
  'radius_km',
  'photos',
  'prompts',
  'lifestyle_signals',
  'true_love_opt_in',
  'is_discoverable',
];
const TRUE_LOVE_SIGNAL_DEFINITIONS = [
  {
    key: 'food',
    aliases: ['food', 'foods', 'cuisine', 'cuisines', 'diet'],
    reason: 'Food match',
    detail: 'Both people opted in to food signals and share cuisine or dietary preferences.',
  },
  {
    key: 'videos',
    aliases: ['videos', 'video_topics', 'creators', 'media'],
    reason: 'Video taste',
    detail: 'Both people opted in to video signals and share viewing interests.',
  },
  {
    key: 'shopping',
    aliases: ['shopping', 'shopping_style', 'style'],
    reason: 'Shopping style',
    detail: 'Both people opted in to shopping signals and share style or buying preferences.',
  },
  {
    key: 'rides',
    aliases: ['rides', 'mobility', 'commute'],
    reason: 'Similar mobility',
    detail: 'Both people opted in to ride signals and have compatible movement patterns.',
  },
  {
    key: 'events',
    aliases: ['events', 'event_interests', 'date_ideas'],
    reason: 'Event fit',
    detail: 'Both people opted in to event signals and share date activity interests.',
  },
  {
    key: 'music',
    aliases: ['music', 'artist', 'artists', 'genres'],
    reason: 'Music match',
    detail: 'Both people opted in to music signals and share listening preferences.',
  },
  {
    key: 'lifestyle',
    aliases: ['availability', 'schedule', 'routine', 'lifestyle'],
    reason: 'Lifestyle rhythm',
    detail: 'Both people opted in to lifestyle signals and have compatible schedules or habits.',
  },
];
const TRUE_LOVE_SIGNAL_KEYS = TRUE_LOVE_SIGNAL_DEFINITIONS.map((signal) => signal.key);
const TRUE_LOVE_SIGNAL_KEY_SET = new Set(TRUE_LOVE_SIGNAL_KEYS);
const TRUE_LOVE_CONTROL_KEY = 'true_love_controls';
const WORTH_IT_SCHEDULED_ADD_ONS = new Set(['flowers', 'gift', 'dessert', 'event_ticket']);
const WORTH_IT_ADD_ON_LABELS = {
  ride: 'Ride',
  flowers: 'Flowers',
  gift: 'Gift',
  dessert: 'Dessert',
  event_ticket: 'Event ticket',
};
const WORTH_IT_ADD_ON_STATUSES = new Set([
  'pending',
  'pending_guest_confirmation',
  'scheduled',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
  'vendor_declined',
  'replacement_suggested',
  'fallback_pending_vendor_acceptance',
  'paused_safety_review',
  'cancelled',
]);
const WORTH_IT_ADD_ON_RECIPIENT_RULES = new Set(['venue', 'guest', 'organizer']);
const WORTH_IT_ADD_ON_PAYMENT_OWNERS = new Set(['host', 'split', 'guest']);
const WORTH_IT_MARKETPLACE_SOURCES = new Set(['food_vendor', 'product_listing']);
const WORTH_IT_ADD_ON_MARKETPLACE = {
  flowers: {
    vendorTypes: ['Floral', 'Flowers'],
    terms: ['flower', 'floral', 'bouquet', 'rose'],
    productTypes: ['Flowers', 'Floral', 'Gifts'],
  },
  gift: {
    vendorTypes: ['Gift', 'Gifts', 'Shop', 'Marketplace'],
    terms: ['gift', 'present', 'box', 'hamper'],
    productTypes: ['Gift', 'Gifts', 'Shop', 'Decor'],
  },
  dessert: {
    vendorTypes: ['Dessert', 'Desserts', 'Bakery', 'Restaurant', 'Food'],
    terms: ['dessert', 'bakery', 'cake', 'sweet', 'pastry'],
    productTypes: ['Dessert', 'Desserts', 'Bakery', 'Food'],
  },
  event_ticket: {
    vendorTypes: ['Event', 'Events', 'Tickets', 'Entertainment'],
    terms: ['ticket', 'event', 'show', 'concert', 'movie'],
    productTypes: ['Ticket', 'Tickets', 'Event', 'Events', 'Entertainment'],
  },
};
const WORTH_IT_ADD_ON_REFUND_RULES = {
  flowers: {
    policy_source: 'vendor_default',
    label: 'Flower vendor policy',
    refundable_before_window: true,
    partial_after_window: true,
    message: 'Refundable before the date cancellation window. After that, florist preparation may make this partially refundable only.',
  },
  gift: {
    policy_source: 'vendor_default',
    label: 'Gift vendor policy',
    refundable_before_window: true,
    partial_after_window: true,
    message: 'Refundable before vendor acceptance. Custom or prepared gifts may need manual refund review.',
  },
  dessert: {
    policy_source: 'vendor_default',
    label: 'Dessert vendor policy',
    refundable_before_window: true,
    partial_after_window: true,
    message: 'Refundable before the kitchen starts preparing the dessert. Prepared food may not be fully refundable.',
  },
  event_ticket: {
    policy_source: 'vendor_default',
    label: 'Ticket vendor policy',
    refundable_before_window: true,
    partial_after_window: false,
    message: 'Ticket refunds depend on the venue or event policy after confirmation.',
  },
};
const SENSITIVE_SIGNAL_KEYS = new Set([
  'race',
  'ethnicity',
  'income',
  'salary',
  'earnings',
  'net_worth',
  'religion',
  'politics',
  'political_view',
  'disability',
  'health',
  'medical',
  'biometric',
  'genetic',
  'citizenship',
  'immigration',
  'sexual_orientation',
]);
const SAFE_LIFESTYLE_SIGNAL_KEYS = new Set([
  TRUE_LOVE_CONTROL_KEY,
  'privacy_settings',
  'food',
  'foods',
  'cuisine',
  'cuisines',
  'diet',
  'videos',
  'video_topics',
  'creators',
  'media',
  'shopping',
  'shopping_style',
  'style',
  'rides',
  'mobility',
  'commute',
  'events',
  'event_interests',
  'date_ideas',
  'music',
  'artist',
  'artists',
  'genres',
  'availability',
  'schedule',
  'routine',
  'lifestyle',
  'interests',
  'dating_intent',
  'safety_preferences',
  'boundaries',
  'emergency_contact',
  'check_in_minutes',
  'crossed_paths',
]);
function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanString(value, max = 255) {
  if (value == null) return null;
  const v = String(value).trim();
  return v ? v.slice(0, max) : null;
}

function cleanMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(n, 10000) * 100) / 100;
}

function moneyToCents(value) {
  const amount = cleanMoney(value);
  return amount == null ? null : Math.round(amount * 100);
}

function cleanPercent(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.round(n), 100));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.round(n), max));
}

async function datingBlockedUserIds(userId) {
  const rows = await prisma.dating_swipe.findMany({
    where: {
      action: 'block',
      OR: [{ actor_id: userId }, { target_id: userId }],
    },
    select: { actor_id: true, target_id: true },
  });
  return new Set((rows || []).map((row) => (row.actor_id === userId ? row.target_id : row.actor_id)).filter(Boolean));
}

async function socialProfileForUser(userId, client = prisma) {
  if (!userId) return null;
  return client.social_profile.findUnique({
    where: { user_id: userId },
    select: { profile_id: true, user_id: true },
  }).catch(() => null);
}

async function socialGraphUserIdsByDirection(userId, { followers = true, following = true } = {}) {
  const profile = await socialProfileForUser(userId);
  if (!profile?.profile_id || (!followers && !following)) return new Set();
  const where = { OR: [] };
  if (following) where.OR.push({ follower_id: profile.profile_id });
  if (followers) where.OR.push({ following_id: profile.profile_id });
  const follows = await prisma.follower.findMany({
    where,
    select: { follower_id: true, following_id: true },
  }).catch(() => []);
  const profileIds = Array.from(new Set(
    follows
      .map((row) => row.follower_id === profile.profile_id ? row.following_id : row.follower_id)
      .filter(Boolean)
  ));
  if (!profileIds.length) return new Set();
  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: profileIds } },
    select: { user_id: true },
  }).catch(() => []);
  return new Set(profiles.map((row) => row.user_id).filter(Boolean));
}

async function socialBlockedUserIds(userId) {
  const profile = await socialProfileForUser(userId);
  if (!profile?.profile_id) return new Set();
  const blocks = await prisma.social_block.findMany({
    where: {
      OR: [
        { blocker_id: profile.profile_id },
        { blocked_id: profile.profile_id },
      ],
    },
    select: { blocker_id: true, blocked_id: true },
  }).catch(() => []);
  const profileIds = Array.from(new Set(
    blocks
      .map((row) => row.blocker_id === profile.profile_id ? row.blocked_id : row.blocker_id)
      .filter(Boolean)
  ));
  if (!profileIds.length) return new Set();
  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: profileIds } },
    select: { user_id: true },
  }).catch(() => []);
  return new Set(profiles.map((row) => row.user_id).filter(Boolean));
}

async function datingPrivacyExcludedUserIds(userId, { hideSocialGraph = true, profile: profileOverride = null } = {}) {
  let profile = profileOverride;
  if (!profile) {
    try {
      profile = await prisma.dating_profile.findUnique({
        where: { user_id: userId },
        select: { lifestyle_signals: true },
      });
    } catch {
      profile = null;
    }
  }
  const privacy = normalizeDatingPrivacySettings(profile?.lifestyle_signals?.privacy_settings);
  const hideFollowers = hideSocialGraph && (privacy.private_mode || privacy.hide_from_followers || privacy.hide_from_contacts);
  const hideFollowing = hideSocialGraph && (privacy.private_mode || privacy.hide_from_following || privacy.hide_from_contacts);
  const [datingBlocked, socialBlocked, graph] = await Promise.all([
    datingBlockedUserIds(userId),
    socialBlockedUserIds(userId),
    hideFollowers || hideFollowing
      ? socialGraphUserIdsByDirection(userId, { followers: hideFollowers, following: hideFollowing })
      : Promise.resolve(new Set()),
  ]);
  return new Set([userId, ...datingBlocked, ...socialBlocked, ...graph]);
}

async function isDatingBlockedBetween(userA, userB) {
  if (!userA || !userB || userA === userB) return false;
  const datingRow = await prisma.dating_swipe.findFirst({
    where: {
      action: 'block',
      OR: [
        { actor_id: userA, target_id: userB },
        { actor_id: userB, target_id: userA },
      ],
    },
    select: { dating_swipe_id: true },
  });
  if (datingRow) return true;
  const [profileA, profileB] = await Promise.all([
    socialProfileForUser(userA),
    socialProfileForUser(userB),
  ]);
  if (!profileA?.profile_id || !profileB?.profile_id) return false;
  const socialRow = await prisma.social_block.findFirst({
    where: {
      OR: [
        { blocker_id: profileA.profile_id, blocked_id: profileB.profile_id },
        { blocker_id: profileB.profile_id, blocked_id: profileA.profile_id },
      ],
    },
    select: { block_id: true },
  }).catch(() => null);
  return Boolean(socialRow);
}

function scrubBlockedPlanPeople(plan, blockedIds) {
  if (!plan || !blockedIds?.size) return plan;
  return {
    ...plan,
    interests: Array.isArray(plan.interests) ? plan.interests.filter((interest) => !blockedIds.has(interest.user_id)) : plan.interests,
    invites: Array.isArray(plan.invites) ? plan.invites.filter((invite) => !blockedIds.has(invite.recipient_id)) : plan.invites,
  };
}

function cleanCoordinate(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function todayUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function parsePlanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (day < todayUTC()) return null;
  return date;
}

function validTime(value) {
  const text = String(value || '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

function worthItPickupTime(plan) {
  const dateValue = plan?.date instanceof Date ? plan.date : new Date(plan?.date);
  const time = validTime(plan?.time);
  if (!time || Number.isNaN(dateValue.getTime())) return null;
  const datePart = dateValue.toISOString().slice(0, 10);
  const pickup = new Date(`${datePart}T${time}:00`);
  if (Number.isNaN(pickup.getTime())) return null;
  pickup.setMinutes(pickup.getMinutes() - 45);
  return pickup;
}

function comparableAddress(value) {
  return cleanString(value, 2000)?.toLowerCase().replace(/\s+/g, ' ') || null;
}

function worthItRidePrivacy(addOns) {
  const item = Array.isArray(addOns)
    ? addOns.find((entry) => entry && typeof entry === 'object' && entry.type === 'ride_status_privacy')
    : null;
  return {
    share_status_with_organizer: item?.share_status_with_organizer === true,
  };
}

function withWorthItRidePrivacy(addOns, privacy = {}) {
  const base = Array.isArray(addOns) ? addOns.filter((entry) => !(entry && typeof entry === 'object' && entry.type === 'ride_status_privacy')) : [];
  const hardened = base.map((entry) => {
    if (!entry || typeof entry !== 'object' || entry.type !== 'scheduled_ride') return entry;
    return {
      ...entry,
      status: 'scheduled',
      ride_request_id: privacy.ride_request_id || entry.ride_request_id || null,
      pickup_visibility: 'private_to_guest_driver_platform',
      organizer_visibility: privacy.share_status_with_organizer === true ? 'limited_status_only' : 'linked_only',
      address_shared_with_organizer: false,
      live_location_shared_with_organizer: false,
      privacy_notice: 'The pickup address is not shared with the organizer or payer.',
    };
  });
  hardened.push({
    type: 'ride_status_privacy',
    share_status_with_organizer: privacy.share_status_with_organizer === true,
    pickup_address_visible_to_organizer: false,
    live_location_visible_to_organizer: false,
  });
  return cleanJsonList(hardened, 12, 500);
}

function serializeWorthItRideSummary(plan, viewerId, ride) {
  if (!ride || !plan?.ride_request_id) return null;
  const isGuest = Number(plan.confirmed_guest_id) === Number(viewerId);
  const isOrganizer = Number(plan.organizer_id) === Number(viewerId);
  const privacy = worthItRidePrivacy(plan.add_ons);
  if (!isGuest && !(isOrganizer && privacy.share_status_with_organizer)) return null;
  const summary = {
    status: ride.status || null,
    scheduled_at: ride.scheduled_at || null,
    shared_with_organizer: privacy.share_status_with_organizer,
    pickup_address_visible_to_organizer: false,
    live_location_visible_to_organizer: false,
    route_visible_to_organizer: false,
    privacy_notice: 'Pickup address, route, and live location are private to the rider, driver, and platform operations.',
    // Never expose pickup/dropoff addresses, coordinates, route, or live driver location here.
  };
  if (isGuest) {
    summary.ride_request_id = ride.ride_request_id;
  }
  return {
    ...summary,
    viewer_role: isGuest ? 'confirmed_guest' : 'organizer_limited',
  };
}

async function worthItRideSummaryMap(plans = []) {
  const rideIds = [...new Set(plans.map((plan) => asInt(plan?.ride_request_id)).filter(Boolean))];
  if (!rideIds.length) return new Map();
  const rides = await prisma.ride_request.findMany({
    where: { ride_request_id: { in: rideIds } },
    select: {
      ride_request_id: true,
      status: true,
      scheduled_at: true,
    },
  });
  return new Map(rides.map((ride) => [ride.ride_request_id, ride]));
}

function cleanJsonList(value, limit = 20, itemLimit = 500) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).slice(0, 20).map(([key, raw]) => [String(key).slice(0, 80), typeof raw === 'string' ? raw.slice(0, itemLimit) : raw]));
      }
      const text = cleanString(item, itemLimit);
      return text || null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function worthItDateTime(plan) {
  const time = validTime(plan?.time);
  if (!time || !plan?.date) return null;
  const dateValue = plan.date instanceof Date ? plan.date : new Date(plan.date);
  if (Number.isNaN(dateValue.getTime())) return null;
  const datePart = dateValue.toISOString().slice(0, 10);
  const at = new Date(`${datePart}T${time}:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function worthItScheduledAddOnTime(plan, minutesBefore = 45) {
  const at = worthItDateTime(plan);
  if (!at) return null;
  const scheduled = new Date(at);
  scheduled.setMinutes(scheduled.getMinutes() - clampInt(minutesBefore, 45, 0, 240));
  return scheduled;
}

function worthItAddOnPaymentOwner(rawOwner, plan = {}) {
  const owner = cleanString(rawOwner, 24)?.toLowerCase();
  if (WORTH_IT_ADD_ON_PAYMENT_OWNERS.has(owner)) return owner;
  if (plan?.payment_split === '100') return 'host';
  if (plan?.payment_split === 'guest') return 'guest';
  return 'split';
}

function worthItAddOnRecipientRule(rawRule) {
  const rule = cleanString(rawRule, 24)?.toLowerCase();
  return WORTH_IT_ADD_ON_RECIPIENT_RULES.has(rule) ? rule : 'venue';
}

function worthItScheduledOrderPayload(addOn, plan, scheduledAt, options = {}) {
  if (!options.confirmed || !scheduledAt || options.cancelled) return null;
  const existing = addOn.scheduled_order && typeof addOn.scheduled_order === 'object' ? addOn.scheduled_order : {};
  return {
    ...existing,
    order_ref: existing.order_ref || `WORTH-${plan?.dating_date_plan_id || 'PLAN'}-${addOn.id}`.toUpperCase(),
    status: existing.status || addOn.status || 'scheduled',
    scheduled_for: scheduledAt.toISOString(),
    delivery_destination: addOn.recipient_rule === 'venue' ? 'date_venue' : addOn.recipient_rule,
    venue_name: cleanString(plan?.restaurant_name, 180),
    venue_address: cleanString(plan?.restaurant_address, 2000),
    payment_owner: addOn.payment_owner,
    payment_status: addOn.payment_status || existing.payment_status || 'authorization_pending',
    vendor_status: addOn.vendor_status || existing.vendor_status || null,
    marketplace_source: addOn.marketplace_source || null,
    marketplace_ref_id: addOn.marketplace_ref_id || null,
    vendor_name: addOn.vendor_name || null,
    vendor_owner_id: addOn.vendor_owner_id || null,
    budget_cap: addOn.budget_cap ?? null,
    privacy: addOn.recipient_rule === 'guest'
      ? 'guest_delivery_requires_explicit_address_consent'
      : 'no_private_guest_address_used',
  };
}

function marketplaceTextWhere(fields, terms) {
  const cleanTerms = (terms || []).map((term) => cleanString(term, 80)).filter(Boolean);
  return cleanTerms.flatMap((term) => fields.map((field) => ({
    [field]: { contains: term, mode: 'insensitive' },
  })));
}

async function worthItMarketplaceVendors(addOnId, limit = 20) {
  const config = WORTH_IT_ADD_ON_MARKETPLACE[addOnId];
  if (!config) return [];
  const vendorTypeRows = await prisma.vendor_type.findMany({
    where: {
      OR: (config.vendorTypes || []).map((name) => ({
        vendor_type: { equals: name, mode: 'insensitive' },
      })),
    },
    select: { vendor_type_id: true, vendor_type: true },
  });
  const typeIds = vendorTypeRows.map((row) => row.vendor_type_id).filter(Boolean);
  const vendorWhere = {
    is_active: true,
    OR: [
      ...(typeIds.length ? [{ vendor_type_id: { in: typeIds } }] : []),
      ...marketplaceTextWhere(['vendor_name', 'cuisine_type', 'description'], config.terms),
    ],
  };
  const vendors = await prisma.food_vendor.findMany({
    where: vendorWhere.OR.length ? vendorWhere : { is_active: true, vendor_id: -1 },
    select: {
      vendor_id: true,
      vendor_name: true,
      cuisine_type: true,
      location: true,
      lat: true,
      long: true,
      logo_url: true,
      cover_url: true,
      owner_id: true,
      vendor_type: { select: { vendor_type: true } },
    },
    orderBy: { vendor_id: 'desc' },
    take: limit,
  });
  const productWhere = {
    availability: { gt: 0 },
    OR: [
      ...marketplaceTextWhere(['name', 'description'], config.terms),
      ...(config.productTypes || []).map((name) => ({
        product_type: { product_type_name: { equals: name, mode: 'insensitive' } },
      })),
    ],
  };
  const products = await prisma.product_listing.findMany({
    where: productWhere.OR.length ? productWhere : { listing_id: -1 },
    select: {
      listing_id: true,
      name: true,
      description: true,
      image_url: true,
      availability: true,
      product_type: { select: { product_type_name: true } },
      seller: { select: { user_id: true, name: true, username: true } },
      product_variation: { select: { price: true }, orderBy: { variation_id: 'asc' }, take: 1 },
    },
    orderBy: { listing_id: 'desc' },
    take: limit,
  });
  return [
    ...vendors.map((vendor) => ({
      id: `food_vendor:${vendor.vendor_id}`,
      source: 'food_vendor',
      ref_id: vendor.vendor_id,
      name: vendor.vendor_name || 'Vendor',
      type: vendor.vendor_type?.vendor_type || vendor.cuisine_type || 'Vendor',
      location: vendor.location || null,
      lat: vendor.lat ?? null,
      lng: vendor.long ?? null,
      image_url: vendor.logo_url || vendor.cover_url || null,
      owner_id: vendor.owner_id || null,
    })),
    ...products.map((listing) => ({
      id: `product_listing:${listing.listing_id}`,
      source: 'product_listing',
      ref_id: listing.listing_id,
      name: listing.name || 'Marketplace item',
      type: listing.product_type?.product_type_name || 'Marketplace',
      seller_id: listing.seller?.user_id || null,
      seller_name: listing.seller?.name || listing.seller?.username || null,
      image_url: listing.image_url || null,
      price: listing.product_variation?.[0]?.price ?? null,
      availability: listing.availability ?? null,
    })),
  ].slice(0, limit);
}

async function resolveWorthItMarketplaceSelection(addOnId, raw) {
  if (!WORTH_IT_SCHEDULED_ADD_ONS.has(addOnId)) return null;
  const source = cleanString(raw?.marketplace_source || raw?.source, 40);
  const refId = asInt(raw?.marketplace_ref_id || raw?.ref_id || raw?.vendor_id || raw?.listing_id);
  if (!source && !refId) return null;
  if (!WORTH_IT_MARKETPLACE_SOURCES.has(source) || !refId) {
    const err = new Error('Select a valid live marketplace vendor for the add-on');
    err.status = 400;
    throw err;
  }
  const candidates = await worthItMarketplaceVendors(addOnId, 50);
  const picked = candidates.find((item) => item.source === source && item.ref_id === refId);
  if (!picked) {
    const err = new Error('Selected add-on vendor is not available for this add-on');
    err.status = 400;
    throw err;
  }
  return picked;
}

async function worthItMarketplaceSelections(value) {
  const rows = cleanJsonList(value, 12, 500);
  const out = {};
  for (const row of rows) {
    const raw = row && typeof row === 'object' && !Array.isArray(row) ? row : { id: row };
    const id = cleanString(raw.id || raw.type || raw.label, 80)?.toLowerCase().replace(/\s+/g, '_');
    if (!id || !WORTH_IT_SCHEDULED_ADD_ONS.has(id)) continue;
    const selected = await resolveWorthItMarketplaceSelection(id, raw);
    if (selected) out[id] = selected;
  }
  return out;
}

function requireWorthItMarketplaceSelections(addOns, selections) {
  const missing = (addOns || []).find((item) => (
    item?.type === 'scheduled_date_add_on'
    && WORTH_IT_SCHEDULED_ADD_ONS.has(item.id)
    && (!item.marketplace_source || !item.marketplace_ref_id || !selections?.[item.id])
  ));
  if (!missing) return null;
  const label = WORTH_IT_ADD_ON_LABELS[missing.id] || 'Add-on';
  return `${label} requires a live Strug provider`;
}

function worthItPaymentAuthorizations(addOn = {}) {
  return cleanJsonList(addOn.payment_authorizations, 12, 500)
    .map((row) => ({
      payment_intent_id: cleanString(row?.payment_intent_id, 120),
      payer_user_id: asInt(row?.payer_user_id),
      amount_cents: asInt(row?.amount_cents),
      currency: cleanString(row?.currency, 12)?.toLowerCase() || 'cad',
      status: cleanString(row?.status, 40) || 'requires_confirmation',
      created_at: cleanString(row?.created_at, 80),
      authorized_at: cleanString(row?.authorized_at, 80),
      captured_at: cleanString(row?.captured_at, 80),
      cancelled_at: cleanString(row?.cancelled_at, 80),
    }))
    .filter((row) => row.payment_intent_id && row.payer_user_id && row.amount_cents);
}

function worthItRequiredPaymentShares(addOn, plan = {}) {
  const amountCents = moneyToCents(addOn?.budget_cap);
  if (!amountCents) return [];
  const organizerId = asInt(plan?.organizer_id);
  const guestId = asInt(plan?.confirmed_guest_id);
  if (addOn.payment_owner === 'host') return organizerId ? [{ user_id: organizerId, amount_cents: amountCents }] : [];
  if (addOn.payment_owner === 'guest') return guestId ? [{ user_id: guestId, amount_cents: amountCents }] : [];
  if (!organizerId || !guestId) return [];
  const hostShare = Math.ceil(amountCents / 2);
  return [
    { user_id: organizerId, amount_cents: hostShare },
    { user_id: guestId, amount_cents: amountCents - hostShare },
  ].filter((row) => row.amount_cents > 0);
}

function worthItRequiredPaymentForUser(addOn, plan, userId) {
  return worthItRequiredPaymentShares(addOn, plan).find((row) => row.user_id === userId) || null;
}

function worthItPaymentState(addOn, plan) {
  const shares = worthItRequiredPaymentShares(addOn, plan);
  if (!shares.length) return addOn?.payment_status || 'authorization_not_required';
  const auths = worthItPaymentAuthorizations(addOn);
  const captured = shares.every((share) => auths.some((auth) => auth.payer_user_id === share.user_id && auth.amount_cents === share.amount_cents && auth.status === 'captured'));
  if (captured) return 'captured';
  const authorized = shares.every((share) => auths.some((auth) => auth.payer_user_id === share.user_id && auth.amount_cents === share.amount_cents && ['authorized', 'captured'].includes(auth.status)));
  if (authorized) return 'authorized';
  return auths.some((auth) => ['authorized', 'captured'].includes(auth.status)) ? 'partially_authorized' : 'authorization_pending';
}

function findWorthItAddOn(addOns = [], addOnId) {
  const id = cleanString(addOnId, 80)?.toLowerCase().replace(/\s+/g, '_');
  return (addOns || []).find((item) => item?.id === id && item?.type === 'scheduled_date_add_on') || null;
}

function replaceWorthItAddOn(addOns = [], addOnId, updater) {
  const id = cleanString(addOnId, 80)?.toLowerCase().replace(/\s+/g, '_');
  return (addOns || []).map((item) => {
    if (item?.id !== id || item?.type !== 'scheduled_date_add_on') return item;
    const next = updater(item);
    const hasScheduledOrder = Object.prototype.hasOwnProperty.call(next, 'scheduled_order');
    const out = {
      ...next,
      refund_policy: next.refund_policy || worthItRefundPolicy(next),
    };
    if (hasScheduledOrder) out.scheduled_order = next.scheduled_order;
    else if (Object.prototype.hasOwnProperty.call(item, 'scheduled_order')) out.scheduled_order = item.scheduled_order;
    return out;
  });
}

async function worthItMarketplaceOwnerId(addOn) {
  if (addOn?.vendor_owner_id) return asInt(addOn.vendor_owner_id);
  if (addOn?.marketplace_source === 'food_vendor' && addOn.marketplace_ref_id) {
    const vendor = await prisma.food_vendor.findUnique({
      where: { vendor_id: addOn.marketplace_ref_id },
      select: { owner_id: true },
    });
    return vendor?.owner_id || null;
  }
  if (addOn?.marketplace_source === 'product_listing' && addOn.marketplace_ref_id) {
    const listing = await prisma.product_listing.findUnique({
      where: { listing_id: addOn.marketplace_ref_id },
      select: { seller_id: true },
    });
    return listing?.seller_id || null;
  }
  return null;
}

async function assertWorthItVendorOwner(addOn, userId) {
  const ownerId = await worthItMarketplaceOwnerId(addOn);
  if (!ownerId || ownerId !== userId) {
    const err = new Error('Add-on fulfillment not found');
    err.status = 404;
    throw err;
  }
  return ownerId;
}

async function findWorthItFallbackVendor(addOn) {
  const attempted = new Set([
    `${addOn.marketplace_source}:${addOn.marketplace_ref_id}`,
    ...cleanJsonList(addOn.fallback_history, 12, 500)
      .map((row) => `${row?.source || row?.marketplace_source}:${row?.ref_id || row?.marketplace_ref_id}`),
  ]);
  const candidates = await worthItMarketplaceVendors(addOn.id, 50);
  return candidates.find((candidate) => !attempted.has(`${candidate.source}:${candidate.ref_id}`)) || null;
}

async function captureWorthItAuthorizations(addOn) {
  const auths = worthItPaymentAuthorizations(addOn);
  if (!auths.length) return auths;
  if (!stripe) {
    const err = new Error('Payment authorization is not configured');
    err.status = 503;
    throw err;
  }
  const now = new Date().toISOString();
  const next = [];
  for (const auth of auths) {
    if (auth.status === 'captured') {
      next.push(auth);
      continue;
    }
    const intent = await stripe.paymentIntents.retrieve(auth.payment_intent_id);
    if (intent.status === 'succeeded') {
      next.push({ ...auth, status: 'captured', captured_at: auth.captured_at || now });
      continue;
    }
    if (intent.status !== 'requires_capture') {
      const err = new Error('Payment must be authorized before vendor acceptance');
      err.status = 409;
      throw err;
    }
    const captured = await stripe.paymentIntents.capture(auth.payment_intent_id);
    next.push({ ...auth, status: captured.status === 'succeeded' ? 'captured' : 'authorized', captured_at: captured.status === 'succeeded' ? now : auth.captured_at });
  }
  return next;
}

async function cancelWorthItAuthorizations(addOn) {
  const auths = worthItPaymentAuthorizations(addOn);
  if (!auths.length || !stripe) return auths;
  const now = new Date().toISOString();
  const next = [];
  for (const auth of auths) {
    if (['captured', 'cancelled'].includes(auth.status)) {
      next.push(auth);
      continue;
    }
    try {
      const intent = await stripe.paymentIntents.retrieve(auth.payment_intent_id);
      if (['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(intent.status)) {
        await stripe.paymentIntents.cancel(auth.payment_intent_id);
      }
      next.push({ ...auth, status: 'cancelled', cancelled_at: now });
    } catch {
      next.push(auth);
    }
  }
  return next;
}

function worthItPlanParticipantIds(plan = {}) {
  return Array.from(new Set([asInt(plan.organizer_id), asInt(plan.confirmed_guest_id)].filter(Boolean)));
}

function assertWorthItParticipant(plan, userId) {
  if (!worthItPlanParticipantIds(plan).includes(userId)) {
    const err = new Error('Date plan not found');
    err.status = 404;
    throw err;
  }
}

function worthItScheduledOrderStatus(addOn, plan, status, patch = {}) {
  const nextAddOn = { ...addOn, ...patch };
  const scheduled = nextAddOn?.scheduled_for ? new Date(nextAddOn.scheduled_for) : worthItScheduledAddOnTime(plan, nextAddOn?.delivery_window_minutes_before);
  const scheduledOrder = worthItScheduledOrderPayload(nextAddOn, plan, scheduled, { confirmed: true });
  return {
    ...nextAddOn,
    scheduled_order: scheduledOrder ? {
      ...(addOn.scheduled_order || {}),
      ...scheduledOrder,
      status,
      updated_at: new Date().toISOString(),
    } : addOn.scheduled_order,
    refund_policy: worthItRefundPolicy(nextAddOn, plan),
  };
}

function worthItNotifyParticipants(req, plan, payload, excludeUserId = null) {
  for (const userId of worthItPlanParticipantIds(plan)) {
    if (excludeUserId && userId === excludeUserId) continue;
    notifyDating(req, { userId, ...payload });
  }
}

function worthItAddOnCancellationAllowed(plan) {
  const at = worthItDateTime(plan);
  if (!at) return true;
  const hours = clampInt(plan?.cancellation_window_hours, 24, 0, 168);
  return Date.now() <= at.getTime() - hours * 60 * 60 * 1000;
}

function worthItVendorRefundRules(addOn = {}, plan = {}) {
  const id = cleanString(addOn?.id || addOn?.type, 80)?.toLowerCase();
  const defaults = WORTH_IT_ADD_ON_REFUND_RULES[id] || {
    policy_source: 'platform_default',
    label: 'Vendor policy',
    refundable_before_window: true,
    partial_after_window: true,
    message: 'Refund rules depend on the selected vendor and cancellation timing.',
  };
  const raw = addOn?.vendor_refund_policy && typeof addOn.vendor_refund_policy === 'object' ? addOn.vendor_refund_policy : {};
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(raw)
        .filter(([key]) => ['policy_source', 'label', 'message', 'refundable_before_window', 'partial_after_window'].includes(key))
        .map(([key, value]) => [key, typeof value === 'string' ? cleanString(value, 500) : value === true])
    ),
    cancellation_window_hours: clampInt(plan?.cancellation_window_hours, 24, 0, 168),
  };
}

function worthItRefundPolicy(addOn, plan = {}) {
  const status = String(addOn?.status || '').toLowerCase();
  const vendorRules = worthItVendorRefundRules(addOn, plan);
  const base = {
    policy_source: vendorRules.policy_source,
    vendor_policy_label: vendorRules.label,
    cancellation_window_hours: vendorRules.cancellation_window_hours,
  };
  if (status === 'cancelled') {
    return { ...base, status: 'cancelled', label: 'Cancelled', message: 'This add-on has been cancelled.' };
  }
  if (status === 'paused_safety_review') {
    return { ...base, status: 'paused_safety_review', label: 'Safety review', message: 'This add-on is paused while the date plan is reviewed.' };
  }
  if (['delivered', 'out_for_delivery'].includes(status)) {
    return { ...base, status: 'locked', label: 'Locked', message: 'This add-on is already in delivery or complete.' };
  }
  const at = worthItDateTime(plan);
  if (!at) {
    return { ...base, status: 'manual_review', label: 'Manual review', message: 'Refund rules depend on the final date time.' };
  }
  const hours = vendorRules.cancellation_window_hours;
  const lockAt = new Date(at.getTime() - hours * 60 * 60 * 1000);
  if (Date.now() <= lockAt.getTime()) {
    return {
      ...base,
      status: 'refundable',
      label: 'Refundable',
      refundable_until: lockAt.toISOString(),
      message: vendorRules.message || `Refundable until ${lockAt.toISOString()}.`,
    };
  }
  if (vendorRules.partial_after_window && ['preparing', 'confirmed', 'scheduled'].includes(status)) {
    return { ...base, status: 'partial_refund', label: 'Partial refund review', message: 'Vendor work may have started, so refund eligibility needs review.' };
  }
  return { ...base, status: 'locked', label: 'Locked', message: 'The cancellation window has passed.' };
}

function sanitizeWorthItGuestPreferences(raw = {}, userId) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preferences = {
    note: cleanString(source.note || source.preference || source.preferences, 500),
    allergy_note: cleanString(source.allergy_note || source.allergies, 300),
    flower_preference: cleanString(source.flower_preference, 200),
    dessert_choice: cleanString(source.dessert_choice, 200),
    gift_size: cleanString(source.gift_size, 100),
    gift_style: cleanString(source.gift_style, 200),
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  return Object.fromEntries(Object.entries(preferences).filter(([, value]) => value != null && value !== ''));
}

function worthItAddOnStatus(rawStatus, options = {}, fallback = 'pending') {
  const requestedStatus = cleanString(rawStatus, 40)?.toLowerCase();
  const existingStatus = WORTH_IT_ADD_ON_STATUSES.has(requestedStatus) ? requestedStatus : null;
  if (options.cancelled) return 'cancelled';
  if (!options.confirmed) {
    return existingStatus && existingStatus !== 'cancelled' ? existingStatus : fallback;
  }
  if (existingStatus && !['pending', 'pending_guest_confirmation'].includes(existingStatus)) {
    return existingStatus;
  }
  return fallback === 'confirmed' ? 'confirmed' : 'scheduled';
}

function normalizeWorthItAddOns(value, plan = {}, options = {}) {
  const rows = cleanJsonList(value, 12, 500);
  const seen = new Set();
  return rows
    .map((row) => {
      const raw = row && typeof row === 'object' && !Array.isArray(row) ? row : { id: row, label: row };
      const id = cleanString(raw.id || raw.type || raw.label, 80)?.toLowerCase().replace(/\s+/g, '_');
      if (!id || seen.has(id) || !WORTH_IT_ADD_ON_LABELS[id]) return null;
      seen.add(id);
      const label = cleanString(raw.label, 80) || WORTH_IT_ADD_ON_LABELS[id];
      const paymentOwner = worthItAddOnPaymentOwner(raw.payment_owner, plan);
      if (id === 'ride') {
        return {
          id,
          label,
          type: 'scheduled_ride',
          sync_with_date: true,
          status: worthItAddOnStatus(raw.status, options, 'confirmed'),
          payment_owner: paymentOwner,
          ride_request_id: asInt(raw.ride_request_id || options.ride_request_id),
          safety_pause: raw.safety_pause && typeof raw.safety_pause === 'object' ? raw.safety_pause : undefined,
          pickup_privacy: 'exact_pickup_after_guest_confirmation',
          pickup_visibility: 'private_to_guest_driver_platform',
          organizer_visibility: 'linked_only',
          address_shared_with_organizer: false,
          live_location_shared_with_organizer: false,
          privacy_notice: 'The confirmed guest enters pickup privately after confirmation. The organizer never sees the exact pickup address, route, or live location.',
        };
      }
      if (!WORTH_IT_SCHEDULED_ADD_ONS.has(id)) return { id, label };
      const minutesBefore = clampInt(raw.delivery_window_minutes_before, 45, 0, 240);
      const scheduledAt = worthItScheduledAddOnTime(plan, minutesBefore);
      const status = worthItAddOnStatus(raw.status, options, 'pending');
      const marketplace = options.marketplaceSelections?.[id] || null;
      const paymentAuthorizations = worthItPaymentAuthorizations(raw);
      const fallbackHistory = cleanJsonList(raw.fallback_history, 12, 500);
      const deliveryProof = raw.delivery_proof && typeof raw.delivery_proof === 'object' && !Array.isArray(raw.delivery_proof)
        ? {
            proof_url: cleanString(raw.delivery_proof.proof_url, 1000),
            signature_name: cleanString(raw.delivery_proof.signature_name, 180),
            note: cleanString(raw.delivery_proof.note, 500),
            uploaded_by: asInt(raw.delivery_proof.uploaded_by),
            uploaded_at: cleanString(raw.delivery_proof.uploaded_at, 80),
          }
        : undefined;
      const vendorOwnerId = marketplace?.owner_id || marketplace?.seller_id || asInt(raw.vendor_owner_id);
      const addOn = {
        id,
        label,
        type: 'scheduled_date_add_on',
        sync_with_date: true,
        status,
        recipient_rule: worthItAddOnRecipientRule(raw.recipient_rule),
        payment_owner: paymentOwner,
        delivery_destination: 'date_venue',
        delivery_window_minutes_before: minutesBefore,
        scheduled_for: options.confirmed && scheduledAt ? scheduledAt.toISOString() : null,
        venue_name: cleanString(plan?.restaurant_name, 180),
        venue_address: cleanString(plan?.restaurant_address, 2000),
        budget_cap: cleanMoney(raw.budget_cap),
        payment_status: cleanString(raw.payment_status, 40) || 'authorization_pending',
        vendor_status: cleanString(raw.vendor_status, 40) || (marketplace ? (options.confirmed ? 'pending_vendor_acceptance' : 'selected_pending_guest_confirmation') : (options.confirmed ? 'pending_vendor_acceptance' : 'pending_guest_confirmation')),
        marketplace_source: marketplace?.source || cleanString(raw.marketplace_source || raw.source, 40),
        marketplace_ref_id: marketplace?.ref_id || asInt(raw.marketplace_ref_id || raw.ref_id || raw.vendor_id || raw.listing_id),
        vendor_owner_id: vendorOwnerId || null,
        vendor_name: marketplace?.name || cleanString(raw.vendor_name, 180),
        vendor_type: marketplace?.type || cleanString(raw.vendor_type, 100),
        vendor_image_url: marketplace?.image_url || cleanString(raw.vendor_image_url, 1000),
        payment_authorizations: paymentAuthorizations,
        fallback_history: fallbackHistory,
        vendor_response: raw.vendor_response && typeof raw.vendor_response === 'object' && !Array.isArray(raw.vendor_response) ? raw.vendor_response : undefined,
        replacement_suggestion: cleanString(raw.replacement_suggestion, 500),
        vendor_accepted_at: cleanString(raw.vendor_accepted_at, 80),
        vendor_declined_at: cleanString(raw.vendor_declined_at, 80),
        payment_authorized_at: cleanString(raw.payment_authorized_at, 80),
        payment_captured_at: cleanString(raw.payment_captured_at, 80),
        delivery_proof: deliveryProof?.proof_url || deliveryProof?.signature_name || deliveryProof?.note ? deliveryProof : undefined,
        delivery_proof_required: raw.delivery_proof_required !== false,
        surprise_to_guest: Boolean(raw.surprise_to_guest),
        guest_preferences: raw.guest_preferences && typeof raw.guest_preferences === 'object' ? sanitizeWorthItGuestPreferences(raw.guest_preferences, raw.guest_preferences.updated_by) : undefined,
        guest_preference_status: cleanString(raw.guest_preference_status, 40) || (options.confirmed ? 'pending_guest_approval' : 'locked_until_guest_confirmed'),
        guest_approved_at: cleanString(raw.guest_approved_at, 80),
        vendor_refund_policy: worthItVendorRefundRules(raw, plan),
        safety_pause: raw.safety_pause && typeof raw.safety_pause === 'object' ? raw.safety_pause : undefined,
      };
      const scheduledOrder = worthItScheduledOrderPayload(addOn, plan, scheduledAt, options);
      const existingScheduledOrder = raw.scheduled_order && typeof raw.scheduled_order === 'object' && !Array.isArray(raw.scheduled_order) ? raw.scheduled_order : {};
      return {
        ...addOn,
        refund_policy: worthItRefundPolicy(addOn, plan),
        scheduled_order: scheduledOrder ? { ...existingScheduledOrder, ...scheduledOrder } : (Object.keys(existingScheduledOrder).length ? existingScheduledOrder : null),
      };
    })
    .filter(Boolean);
}

function applyWorthItGuestPreferences(addOns = [], preferences = [], userId) {
  const prefRows = cleanJsonList(preferences, 12, 500);
  const byId = new Map(prefRows
    .map((row) => {
      const id = cleanString(row?.id || row?.type, 80)?.toLowerCase().replace(/\s+/g, '_');
      return id ? [id, {
        preferences: sanitizeWorthItGuestPreferences(row, userId),
        approved: row?.approved !== false,
      }] : null;
    })
    .filter(Boolean));
  return addOns.map((item) => {
    if (item?.type !== 'scheduled_date_add_on' || !byId.has(item.id)) return item;
    const row = byId.get(item.id);
    const nextPrefs = row.preferences;
    const approvedAt = new Date().toISOString();
    return {
      ...item,
      guest_preferences: nextPrefs,
      guest_preference_status: row.approved ? 'approved' : 'needs_changes',
      guest_approved_at: row.approved ? approvedAt : item.guest_approved_at,
      guest_preference_reviewed_at: approvedAt,
    };
  });
}

function pauseWorthItAddOnsForSafety(value, plan = {}, report = {}) {
  return normalizeWorthItAddOns(value, plan, {
    confirmed: ['confirmed', 'completed'].includes(plan?.status),
  }).map((item) => {
    if (!['scheduled_date_add_on', 'scheduled_ride'].includes(item?.type)) return item;
    if (['delivered', 'out_for_delivery', 'cancelled'].includes(item.status)) return item;
    const paused = {
      ...item,
      status: 'paused_safety_review',
      vendor_status: item.type === 'scheduled_date_add_on' ? 'paused_safety_review' : item.vendor_status,
      payment_status: item.type === 'scheduled_date_add_on' ? 'authorization_paused' : item.payment_status,
      safety_override: true,
      safety_pause: {
        report_id: report?.dating_report_id,
        reason: cleanString(report?.reason, 80),
        paused_at: new Date().toISOString(),
      },
    };
    if (paused.scheduled_order) {
      paused.scheduled_order = { ...paused.scheduled_order, status: 'paused_safety_review' };
    }
    if (paused.type === 'scheduled_date_add_on') {
      paused.refund_policy = worthItRefundPolicy(paused, plan);
    }
    return paused;
  });
}

function cancelWorthItAddOns(value, plan = {}) {
  const canCancelAddOns = worthItAddOnCancellationAllowed(plan);
  return normalizeWorthItAddOns(value, plan, {
    cancelled: canCancelAddOns,
    confirmed: plan?.status === 'confirmed' || plan?.status === 'completed',
  }).map((item) => {
    if (canCancelAddOns || item.type !== 'scheduled_date_add_on') return item;
    return {
      ...item,
      cancellation_status: 'outside_cancellation_window',
      cancellation_message: 'Add-on cancellation requires manual review because the date is inside the cancellation window.',
      refund_policy: worthItRefundPolicy(item, plan),
    };
  });
}

function serializeWorthItAddOns(plan, confirmed = false) {
  return normalizeWorthItAddOns(plan?.add_ons, plan, {
    confirmed: confirmed || plan?.status === 'confirmed' || plan?.status === 'completed',
    cancelled: plan?.status === 'cancelled',
  });
}

function normalizeDatingPrivacySettings(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    hide_from_followers: raw.hide_from_followers === true,
    hide_from_following: raw.hide_from_following === true,
    hide_from_contacts: raw.hide_from_contacts === true,
    private_mode: raw.private_mode === true,
  };
}

function normalizeCrossedPathSettings(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const minAge = clampInt(raw.age_min ?? raw.min_age, 18, 18, 99);
  return {
    enabled: raw.enabled === true,
    distance_km: clampInt(raw.distance_km ?? raw.radius_km, 10, 1, MAX_RADIUS_KM),
    age_min: minAge,
    age_max: clampInt(raw.age_max ?? raw.max_age, Math.max(minAge, 99), minAge, 99),
    hide_from_followers: raw.hide_from_followers === true,
    hide_from_following: raw.hide_from_following === true,
    hide_from_contacts: raw.hide_from_contacts === true,
    hide_from_networks: raw.hide_from_networks === true,
    incognito: raw.incognito === true,
  };
}

function normalizeTrueLoveControls(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(TRUE_LOVE_SIGNAL_KEYS.map((key) => [key, raw[key] === true]));
}

function sanitizeJsonValue(value, limit = 20, itemLimit = 500) {
  if (Array.isArray(value)) return cleanJsonList(value, limit, itemLimit);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_SIGNAL_KEYS.has(String(key).trim().toLowerCase()))
        .slice(0, 20)
        .map(([key, raw]) => [String(key).slice(0, 80), typeof raw === 'string' ? raw.slice(0, itemLimit) : raw])
    );
  }
  return cleanString(value, itemLimit);
}

function sanitizeLifestyleSignals(value, existing = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const next = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!key || SENSITIVE_SIGNAL_KEYS.has(key)) continue;
    if (key === TRUE_LOVE_CONTROL_KEY) {
      next[TRUE_LOVE_CONTROL_KEY] = normalizeTrueLoveControls(rawValue);
      continue;
    }
    if (key === 'privacy_settings') {
      next.privacy_settings = normalizeDatingPrivacySettings(rawValue);
      continue;
    }
    if (key === 'crossed_paths') {
      next.crossed_paths = normalizeCrossedPathSettings(rawValue);
      continue;
    }
    // The app writes this once the user finishes or skips Standard setup, and
    // gates the whole Standard tab on reading it back as a real boolean. It
    // needs its own branch: the generic path runs values through cleanString,
    // which would store the string "true" and never satisfy `=== true`, so the
    // setup modal would reopen forever and Crossed Paths stay unreachable.
    if (key === 'dating_setup_completed') {
      next.dating_setup_completed = rawValue === true || rawValue === 'true';
      continue;
    }
    if (!SAFE_LIFESTYLE_SIGNAL_KEYS.has(key)) continue;
    const cleaned = sanitizeJsonValue(rawValue);
    if (cleaned != null && !(Array.isArray(cleaned) && !cleaned.length)) next[key] = cleaned;
  }
  if (!next[TRUE_LOVE_CONTROL_KEY]) {
    next[TRUE_LOVE_CONTROL_KEY] = normalizeTrueLoveControls(existing?.[TRUE_LOVE_CONTROL_KEY]);
  }
  if (!next.privacy_settings) {
    next.privacy_settings = normalizeDatingPrivacySettings(existing?.privacy_settings);
  }
  if (!next.crossed_paths) {
    next.crossed_paths = normalizeCrossedPathSettings(existing?.crossed_paths);
  }
  return next;
}

function serializeSafetyReport(report, viewerUserId) {
  const viewerIsReporter = Number(report?.reporter_id) === Number(viewerUserId);
  const viewerIsReported = Number(report?.reported_user_id) === Number(viewerUserId);
  if (!viewerIsReported || viewerIsReporter) {
    return { ...report, viewer_role: viewerIsReporter ? 'reporter' : 'related' };
  }
  return {
    dating_report_id: report.dating_report_id,
    reported_user_id: report.reported_user_id,
    entity_type: report.entity_type,
    entity_id: report.entity_id,
    reason: report.reason,
    status: report.status,
    created_at: report.created_at,
    viewer_role: 'reported',
  };
}

function ageFromBirthdate(birthdate) {
  if (!birthdate) return null;
  const dob = new Date(birthdate);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function adultCutoffDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
}

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const a1 = Number(aLat);
  const a2 = Number(aLng);
  const b1 = Number(bLat);
  const b2 = Number(bLng);
  if (![a1, a2, b1, b2].every(Number.isFinite)) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(b1 - a1);
  const dLng = toRad(b2 - a2);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(b1)) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function crossedPathGridCell(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  const scale = 10 ** CROSSED_PATH_GRID_DECIMALS;
  const coarseLat = Math.round(a * scale) / scale;
  const coarseLng = Math.round(b * scale) / scale;
  return `${coarseLat.toFixed(CROSSED_PATH_GRID_DECIMALS)}:${coarseLng.toFixed(CROSSED_PATH_GRID_DECIMALS)}`;
}

function crossedPathCoords(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

async function crossedPathAnchorForUser(userId, profile) {
  const profileLat = Number(profile?.lat);
  const profileLng = Number(profile?.lng);
  if (Number.isFinite(profileLat) && Number.isFinite(profileLng)) {
    return { lat: profileLat, lng: profileLng };
  }
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    select: { saved_lat: true, saved_long: true },
  }).catch(() => null);
  const savedLat = Number(user?.saved_lat);
  const savedLng = Number(user?.saved_long);
  if (Number.isFinite(savedLat) && Number.isFinite(savedLng)) {
    return { lat: savedLat, lng: savedLng };
  }
  return null;
}

async function validateCrossedPathEventLocation(userId, profile, coords) {
  const anchor = await crossedPathAnchorForUser(userId, profile);
  if (!anchor) {
    return {
      ok: false,
      status: 400,
      message: 'Set your Dating location before using Crossed Paths.',
    };
  }
  const driftKm = distanceKm(anchor.lat, anchor.lng, coords.lat, coords.lng);
  if (driftKm == null || driftKm > CROSSED_PATH_MAX_LOCATION_DRIFT_KM) {
    return {
      ok: false,
      status: 400,
      message: 'Update your saved location before recording this nearby area.',
    };
  }
  return { ok: true };
}

function crossedPathTimeBucket(date = new Date()) {
  const bucketMs = CROSSED_PATH_BUCKET_MINUTES * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function crossedPathAreaLabel() {
  return 'Nearby area';
}

function crossedPathPair(userA, userB) {
  return Number(userA) < Number(userB) ? [Number(userA), Number(userB)] : [Number(userB), Number(userA)];
}

function crossedPathTimeLabel(dateValue) {
  const date = dateValue ? new Date(dateValue) : null;
  if (!date || Number.isNaN(date.getTime())) return 'recently';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const hours = diffMs / 36e5;
  if (hours < 24 && date.getUTCDate() === now.getUTCDate()) return 'today';
  if (hours < 48) return 'yesterday';
  if (hours < 24 * 7) return 'this week';
  return 'recently';
}

function serializeCrossedPathCandidate(row, otherProfile) {
  const summary = {
    crossed_path_id: row.dating_crossed_path_candidate_id,
    encounter_count: row.encounter_count || 1,
    shared_area: row.area_label || 'Nearby area',
    last_seen_label: crossedPathTimeLabel(row.last_bucket),
    label: row.encounter_count > 1
      ? `Crossed paths ${row.encounter_count} times ${crossedPathTimeLabel(row.last_bucket)}`
      : `Nearby ${crossedPathTimeLabel(row.last_bucket)}`,
    visible_after: row.visible_after,
    expires_at: row.expires_at,
  };
  return {
    ...publicProfile(otherProfile),
    distance_km: null,
    location_label: summary.shared_area,
    location_precision: 'approximate_area',
    crossed_path: summary,
  };
}

function hasCrossedPathModels(client = prisma) {
  return Boolean(
    client?.dating_crossed_path_event?.findMany
      && client?.dating_crossed_path_event?.upsert
      && client?.dating_crossed_path_event?.deleteMany
      && client?.dating_crossed_path_candidate?.findMany
      && client?.dating_crossed_path_candidate?.upsert
      && client?.dating_crossed_path_candidate?.deleteMany
  );
}

function isCrossedPathStorageUnavailable(err) {
  const text = String(err?.message || '');
  return err?.code === 'P2021'
    || err?.code === 'P2022'
    || (
      (text.includes('dating_crossed_path_event') || text.includes('dating_crossed_path_candidate'))
      && /does not exist|not found|missing/i.test(text)
    );
}

async function purgeExpiredCrossedPathData(client = prisma) {
  const now = new Date();
  const deletes = [];
  if (client?.dating_crossed_path_event?.deleteMany) {
    deletes.push(client.dating_crossed_path_event.deleteMany({ where: { expires_at: { lt: now } } }));
  }
  if (client?.dating_crossed_path_candidate?.deleteMany) {
    deletes.push(client.dating_crossed_path_candidate.deleteMany({ where: { expires_at: { lt: now } } }));
  }
  if (!deletes.length) return;
  await Promise.all(deletes).catch((err) => {
    if (!isCrossedPathStorageUnavailable(err)) throw err;
  });
}

async function crossedPathPrivacyExcludedUserIds(userId, profile) {
  const settings = normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths);
  const base = await datingPrivacyExcludedUserIds(userId, { profile });
  if (settings.incognito) return new Set([userId, ...base, -1]);
  const hideFollowers = settings.hide_from_followers || settings.hide_from_contacts;
  const hideFollowing = settings.hide_from_following || settings.hide_from_contacts;
  const [followers, following] = await Promise.all([
    hideFollowers ? socialGraphUserIdsByDirection(userId, { followers: true, following: false }) : Promise.resolve(new Set()),
    hideFollowing ? socialGraphUserIdsByDirection(userId, { followers: false, following: true }) : Promise.resolve(new Set()),
  ]);
  return new Set([userId, ...base, ...followers, ...following]);
}

function arraySignal(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase()).filter(Boolean);
  return String(value).split(/[,\s|]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function normalizePreferenceValue(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
}

function preferenceValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizePreferenceValue).filter(Boolean);
  return String(value).split(/[,|]/).map(normalizePreferenceValue).filter(Boolean);
}

function preferenceAllows(preferences, gender) {
  const preferred = preferenceValues(preferences);
  if (!preferred.length) return true;
  const normalizedGender = normalizePreferenceValue(gender);
  if (!normalizedGender) return true;
  return preferred.some((value) => ['all', 'any', 'everyone', 'open'].includes(value) || value === normalizedGender);
}

function datingPreferencesCompatible(viewer, candidate) {
  return preferenceAllows(viewer?.interested_in, candidate?.gender)
    && preferenceAllows(candidate?.interested_in, viewer?.gender);
}

function signalValues(profile, keys) {
  const signals = profile?.lifestyle_signals || {};
  return keys.flatMap((key) => arraySignal(signals[key]));
}

function hasSharedSignal(a, b, keys) {
  const own = new Set(signalValues(a, keys));
  if (!own.size) return false;
  return signalValues(b, keys).some((value) => own.has(value));
}

function signalControl(profile, key) {
  if (!profile?.true_love_opt_in || !TRUE_LOVE_SIGNAL_KEY_SET.has(key)) return false;
  return profile?.lifestyle_signals?.[TRUE_LOVE_CONTROL_KEY]?.[key] === true;
}

function hasSharedTrueLoveSignal(viewer, candidate, signal) {
  if (!signalControl(viewer, signal.key) || !signalControl(candidate, signal.key)) return false;
  return hasSharedSignal(viewer, candidate, signal.aliases);
}

function profileCompletion(profile) {
  const signals = profile?.lifestyle_signals || {};
  const checks = [
    profile?.display_name,
    profile?.bio,
    profile?.birthdate,
    profile?.location_label,
    Array.isArray(profile?.photos) && profile.photos.length,
    Array.isArray(profile?.prompts) && profile.prompts.length,
    signalValues(profile, ['food', 'foods', 'cuisine', 'cuisines', 'diet']).length,
    signalValues(profile, ['music', 'artist', 'artists', 'genres', 'media']).length,
    Array.isArray(profile?.interested_in) && profile.interested_in.length,
    signalValues(profile, ['availability', 'schedule']).length || signals.availability,
    signals.dating_intent,
    signalValues(profile, ['safety_preferences', 'boundaries']).length || signals.emergency_contact,
    profile?.age_verified_at,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function matchInsights(viewer, candidate, distance, { trueLove = false } = {}) {
  const reasons = [];
  const explanations = [];
  if (distance != null) reasons.push(`${Math.round(distance * 10) / 10} km away`);
  if (candidate?.bio || (Array.isArray(candidate?.prompts) && candidate.prompts.length)) reasons.push('Intentional profile');
  if (trueLove) {
    TRUE_LOVE_SIGNAL_DEFINITIONS.forEach((signal) => {
      if (!hasSharedTrueLoveSignal(viewer, candidate, signal)) return;
      reasons.push(signal.reason);
      explanations.push({ signal: signal.key, title: signal.reason, detail: signal.detail });
    });
  } else {
    if (hasSharedSignal(viewer, candidate, ['food', 'foods', 'cuisine', 'cuisines', 'diet'])) reasons.push('Food match');
    if (hasSharedSignal(viewer, candidate, ['music', 'artist', 'artists', 'genres', 'media'])) reasons.push('Music match');
    if (hasSharedSignal(viewer, candidate, ['availability', 'schedule', 'routine'])) reasons.push('Similar schedule');
    if (hasSharedSignal(viewer, candidate, ['interests', 'lifestyle'])) reasons.push('Shared interests');
    if (hasSharedSignal(viewer, candidate, ['lifestyle', 'routine', 'schedule'])) reasons.push('Lifestyle match');
  }
  return { reasons: reasons.slice(0, 4), explanations: explanations.slice(0, 4) };
}

function compatibilityScore(reasons, distance) {
  let score = 45;
  for (const reason of reasons) {
    if (/food match/i.test(reason)) score += 14;
    else if (/similar schedule/i.test(reason)) score += 12;
    else if (/shared interests/i.test(reason)) score += 12;
    else if (/intentional/i.test(reason)) score += 7;
    else if (/music|lifestyle|video|shopping|mobility|event/i.test(reason)) score += 6;
  }
  if (distance != null) {
    if (distance <= 5) score += 10;
    else if (distance <= 15) score += 6;
    else if (distance <= 30) score += 2;
  }
  return Math.max(0, Math.min(98, Math.round(score)));
}

function assertAdult(profile) {
  const age = ageFromBirthdate(profile?.birthdate);
  return profile?.age_verified_at || (age != null && age >= 18);
}

function bodyHasKey(body, key) {
  return Object.prototype.hasOwnProperty.call(body ?? {}, key);
}

function touchesDatingProfileContent(body) {
  return DATING_PROFILE_CONTENT_FIELDS.some((key) => bodyHasKey(body, key));
}

function isObviousTestContent(value) {
  return /\b(test|demo|playwright|faker|seed)\b/i.test(String(value || ''));
}

function isVisibleDatingProfile(profile) {
  return !isObviousTestContent([
    profile?.display_name,
    profile?.bio,
    profile?.user?.email,
    profile?.user?.username,
    profile?.user?.name,
    profile?.user?.social_profiles?.display_name,
    profile?.user?.social_profiles?.handle,
    profile?.user?.social_profiles?.bio,
  ].filter(Boolean).join(' '));
}

function isVisibleDatePlan(plan) {
  return !isObviousTestContent([
    plan?.title,
    plan?.restaurant_name,
    plan?.restaurant_address,
    plan?.host_note,
    plan?.organizer?.name,
    plan?.organizer?.social_profiles?.display_name,
  ].filter(Boolean).join(' '));
}

async function datingAttendanceScore(userId) {
  const reports = await prisma.dating_report.findMany({
    where: { reported_user_id: userId },
    select: { reason: true, details: true },
    take: 50,
  });
  const noShows = reports.filter((report) => /no[-\s]?show|stood up|attendance/i.test(`${report.reason || ''} ${report.details || ''}`)).length;
  return Math.max(0, Math.min(100, 100 - noShows * 20));
}

function blindBoundaryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanBlindPreferences(value = {}) {
  const source = blindBoundaryObject(value);
  const minAge = clampInt(source.age_min ?? source.min_age, 18, 18, 99);
  const maxAge = clampInt(source.age_max ?? source.max_age, Math.max(minAge, 45), minAge, 99);
  const language = cleanString(source.language, 40) || 'Any';
  return {
    age_min: minAge,
    age_max: maxAge,
    distance_km: clampInt(source.distance_km ?? source.radius_km, 25, 1, MAX_RADIUS_KM),
    language,
    intent: cleanString(source.intent, 80),
    vibe: cleanString(source.vibe, 80),
    reveal_after_messages: clampInt(source.reveal_after_messages, BLIND_REVEAL_DEFAULT_MESSAGES, 2, 50),
    reveal_after_minutes: clampInt(source.reveal_after_minutes, BLIND_REVEAL_DEFAULT_MINUTES, 1, 120),
  };
}

function cleanBlindIcebreakers(value) {
  const items = Array.isArray(value) ? value : [];
  const cleaned = items.map((item) => cleanString(item, 140)).filter(Boolean).slice(0, 3);
  return cleaned.length ? cleaned : BLIND_ICEBREAKER_DEFAULTS;
}

function blindJoinConfig(body = {}) {
  const boundaries = blindBoundaryObject(body.boundaries);
  const preferences = cleanBlindPreferences(body.preferences || boundaries.preferences || boundaries);
  const icebreakers = cleanBlindIcebreakers(body.icebreakers || boundaries.icebreakers);
  const revealPolicy = {
    min_messages: preferences.reveal_after_messages,
    min_minutes: preferences.reveal_after_minutes,
  };
  return {
    preferences,
    icebreakers,
    reveal_policy: revealPolicy,
    boundaries: {
      ...boundaries,
      public_place: boundaries.public_place !== false,
      anonymous_first: boundaries.anonymous_first !== false,
      preferences,
      icebreakers,
      reveal_policy: revealPolicy,
    },
  };
}

function firstDatingProfile(queue) {
  const profiles = queue?.user?.dating_profiles;
  return Array.isArray(profiles) ? profiles[0] : null;
}

function normalizedChoice(value) {
  const text = cleanString(value, 80);
  if (!text || /^any$/i.test(text)) return null;
  return text.toLowerCase();
}

function blindPreferenceCompatible(viewerProfile, viewerPrefs, candidateQueue) {
  const candidatePrefs = cleanBlindPreferences(blindBoundaryObject(candidateQueue?.boundaries).preferences || candidateQueue?.boundaries);
  const candidateProfile = firstDatingProfile(candidateQueue);
  const viewerAge = ageFromBirthdate(viewerProfile?.birthdate);
  const candidateAge = ageFromBirthdate(candidateProfile?.birthdate);
  if (candidateAge != null && (candidateAge < viewerPrefs.age_min || candidateAge > viewerPrefs.age_max)) return false;
  if (viewerAge != null && (viewerAge < candidatePrefs.age_min || viewerAge > candidatePrefs.age_max)) return false;

  const viewerDistance = distanceKm(viewerProfile?.lat, viewerProfile?.lng, candidateProfile?.lat, candidateProfile?.lng);
  if (viewerDistance != null && viewerDistance > Math.min(viewerPrefs.distance_km, candidatePrefs.distance_km)) return false;

  const viewerLanguage = normalizedChoice(viewerPrefs.language);
  const candidateLanguage = normalizedChoice(candidatePrefs.language);
  if (viewerLanguage && candidateLanguage && viewerLanguage !== candidateLanguage) return false;

  const viewerIntent = normalizedChoice(viewerPrefs.intent);
  const candidateIntent = normalizedChoice(candidatePrefs.intent);
  if (viewerIntent && candidateIntent && viewerIntent !== candidateIntent) return false;

  const viewerVibe = normalizedChoice(viewerPrefs.vibe);
  const candidateVibe = normalizedChoice(candidatePrefs.vibe);
  if (viewerVibe && candidateVibe && viewerVibe !== candidateVibe) return false;

  return true;
}

function mergeBlindSessionConfig(viewerConfig, candidateQueue) {
  const candidateBoundaries = blindBoundaryObject(candidateQueue?.boundaries);
  const candidatePrefs = cleanBlindPreferences(candidateBoundaries.preferences || candidateBoundaries);
  const candidateIcebreakers = cleanBlindIcebreakers(candidateBoundaries.icebreakers);
  const icebreakers = Array.from(new Set([...viewerConfig.icebreakers, ...candidateIcebreakers])).slice(0, 3);
  return {
    icebreakers,
    reveal_policy: {
      min_messages: Math.max(viewerConfig.reveal_policy.min_messages, candidatePrefs.reveal_after_messages),
      min_minutes: Math.max(viewerConfig.reveal_policy.min_minutes, candidatePrefs.reveal_after_minutes),
    },
  };
}

async function countBlindSessionMessages(session) {
  if (!session?.chat_channel_id) return 0;
  return prisma.chat_messages.count({ where: { channel_id: session.chat_channel_id, deleted_at: null } });
}

function blindRevealStatus(session, messageCount = 0) {
  const policy = blindBoundaryObject(session?.reveal_policy);
  const minMessages = clampInt(policy.min_messages, BLIND_REVEAL_DEFAULT_MESSAGES, 2, 50);
  const minMinutes = clampInt(policy.min_minutes, BLIND_REVEAL_DEFAULT_MINUTES, 1, 120);
  const createdAt = session?.created_at ? new Date(session.created_at).getTime() : Date.now();
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
  const canRequestReveal = session?.status === 'revealed' || messageCount >= minMessages || elapsedMinutes >= minMinutes;
  return {
    min_messages: minMessages,
    min_minutes: minMinutes,
    message_count: messageCount,
    elapsed_minutes: elapsedMinutes,
    can_request_reveal: canRequestReveal,
  };
}

function approximateLocationLabel(label) {
  const parts = String(label || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length >= 3) return parts.slice(-2).join(', ');
  return parts.join(', ');
}

async function ensureProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    select: {
      user_id: true,
      name: true,
      city: true,
      country: true,
      saved_address: true,
      saved_lat: true,
      saved_long: true,
      currency: true,
      social_profiles: {
        select: {
          display_name: true,
          bio: true,
          profile_pic_url: true,
          banner_url: true,
        },
      },
    },
  });
  if (!user) return null;
  const profile = await prisma.dating_profile.upsert({
    where: { user_id: userId },
    update: { last_active_at: new Date() },
    create: {
      user_id: userId,
      display_name: cleanString(user.social_profiles?.display_name || user.name, 100),
      bio: cleanString(user.social_profiles?.bio, 1000),
      location_label: cleanString(user.saved_address || [user.city, user.country].filter(Boolean).join(', '), 255),
      lat: user.saved_lat ?? null,
      lng: user.saved_long ?? null,
      photos: [user.social_profiles?.profile_pic_url, user.social_profiles?.banner_url].filter(Boolean),
      radius_km: 25,
    },
  });
  return { ...profile, user };
}

function publicProfile(profile, { reveal = true, distance_km = null, match_reasons = [], match_explanations = [], compatibility_score = null } = {}) {
  if (!profile) return null;
  const user = profile.user || {};
  const social = user.social_profiles || {};
  const locationLabel = approximateLocationLabel(profile.location_label);
  return {
    user_id: profile.user_id,
    dating_profile_id: profile.dating_profile_id,
    display_name: reveal ? (profile.display_name || social.display_name || user.name || 'Strug member') : 'Anonymous match',
    bio: reveal ? (profile.bio || social.bio || null) : null,
    gender: reveal ? profile.gender : null,
    interested_in: reveal ? profile.interested_in : null,
    location_label: reveal ? locationLabel : null,
    location_precision: reveal && locationLabel ? 'approximate' : null,
    radius_km: profile.radius_km,
    photos: reveal ? (profile.photos || [social.profile_pic_url].filter(Boolean)) : [],
    prompts: reveal ? profile.prompts : null,
    true_love_opt_in: Boolean(profile.true_love_opt_in),
    true_love_controls: normalizeTrueLoveControls(profile.lifestyle_signals?.[TRUE_LOVE_CONTROL_KEY]),
    is_verified: Boolean(social.is_verified),
    profile_completion: profileCompletion(profile),
    match_reasons,
    match_explanations,
    compatibility_score,
    last_active_at: profile.last_active_at,
    distance_km,
  };
}

function serializeBlockedUser(row) {
  const target = row?.target || {};
  const datingProfile = Array.isArray(target.dating_profiles) ? target.dating_profiles[0] : null;
  const social = target.social_profiles || {};
  return {
    user_id: target.user_id || row?.target_id,
    dating_swipe_id: row?.dating_swipe_id,
    mode: row?.mode,
    blocked_at: row?.created_at,
    display_name: datingProfile?.display_name || social.display_name || target.name || 'Strug member',
    profile_pic_url: Array.isArray(datingProfile?.photos) && datingProfile.photos.length ? datingProfile.photos[0] : social.profile_pic_url || null,
  };
}

async function findUserMatch(matchId, userId) {
  const id = asInt(matchId);
  if (!id) return null;
  const match = await prisma.dating_match.findFirst({
    where: {
      dating_match_id: id,
      OR: [{ user_a_id: userId }, { user_b_id: userId }],
    },
  });
  if (!match) return null;
  return {
    match,
    otherUserId: match.user_a_id === userId ? match.user_b_id : match.user_a_id,
  };
}

async function openDatingMatchChannel(match, userId, otherUserId) {
  if (match.chat_channel_id) {
    return { channel_id: match.chat_channel_id, created: false };
  }
  const contextId = String(match.dating_match_id);
  const existing = await prisma.chat_channel.findFirst({
    where: { context_type: 'dating_match', context_id: contextId },
    select: { channel_id: true },
  });
  if (existing) return { channel_id: existing.channel_id, created: false };

  const channel = await prisma.$transaction(async (tx) => {
    const created = await tx.chat_channel.create({
      data: {
        type: 'dm',
        channel_name: `dating_match_${contextId}`,
        context_type: 'dating_match',
        context_id: contextId,
        created_by: userId,
      },
    });
    await tx.chat_participants.createMany({
      data: [
        { channel_id: created.channel_id, user_id: userId, role: 'member' },
        { channel_id: created.channel_id, user_id: otherUserId, role: 'member' },
      ],
      skipDuplicates: true,
    });
    return created;
  });
  return { channel_id: channel.channel_id, created: true };
}

async function openBlindSessionChannel(session, userId, otherUserId) {
  if (session.chat_channel_id) {
    return { channel_id: session.chat_channel_id, created: false };
  }
  const contextId = String(session.dating_blind_session_id);
  const existing = await prisma.chat_channel.findFirst({
    where: { context_type: 'dating_blind_session', context_id: contextId },
    select: { channel_id: true },
  });
  if (existing) return { channel_id: existing.channel_id, created: false };

  const channel = await prisma.$transaction(async (tx) => {
    const created = await tx.chat_channel.create({
      data: {
        type: 'dm',
        channel_name: `dating_blind_${contextId}`,
        context_type: 'dating_blind_session',
        context_id: contextId,
        created_by: userId,
      },
    });
    await tx.chat_participants.createMany({
      data: [
        { channel_id: created.channel_id, user_id: userId, role: 'member' },
        { channel_id: created.channel_id, user_id: otherUserId, role: 'member' },
      ],
      skipDuplicates: true,
    });
    return created;
  });
  return { channel_id: channel.channel_id, created: true };
}

function planInclude() {
  return {
    organizer: {
      select: {
        user_id: true,
        name: true,
        social_profiles: { select: { display_name: true, profile_pic_url: true, is_verified: true } },
      },
    },
    vendor: {
      select: {
        vendor_id: true,
        vendor_name: true,
        cuisine_type: true,
        logo_url: true,
        cover_url: true,
        location: true,
        lat: true,
        long: true,
      },
    },
    interests: {
      orderBy: { created_at: 'desc' },
      include: {
        user: {
          select: {
            user_id: true,
            name: true,
            social_profiles: { select: { display_name: true, profile_pic_url: true, is_verified: true } },
          },
        },
      },
    },
    invites: {
      orderBy: { created_at: 'desc' },
      include: {
        recipient: {
          select: {
            user_id: true,
            name: true,
            social_profiles: { select: { display_name: true, profile_pic_url: true, is_verified: true } },
          },
        },
      },
    },
  };
}

function serializePerson(user) {
  const social = user?.social_profiles;
  return {
    user_id: user?.user_id,
    display_name: social?.display_name || user?.name || 'Strug member',
    profile_pic_url: social?.profile_pic_url || null,
    is_verified: Boolean(social?.is_verified),
  };
}

function worthItDateTimeline(plan, viewerId, ride, addOns = []) {
  const rows = [];
  const confirmed = plan?.organizer_id === viewerId || plan?.confirmed_guest_id === viewerId;
  const push = (key, title, status, at, meta = {}) => {
    rows.push({
      key,
      title,
      status,
      at: at ? new Date(at).toISOString() : null,
      ...meta,
    });
  };
  push('plan_created', 'Date plan created', 'completed', plan?.created_at, {
    kind: 'restaurant',
    description: 'Organizer created the Worth It date plan.',
  });
  if (plan?.booking_id) {
    push('restaurant_booking', 'Restaurant booking linked', confirmed ? 'confirmed' : 'private_until_confirmed', null, {
      kind: 'restaurant',
      venue: plan.restaurant_name,
      description: confirmed ? 'Restaurant booking is connected to this date plan.' : 'Exact booking details unlock after both sides confirm.',
    });
  } else if (plan?.restaurant_name) {
    push('venue_selected', 'Venue selected', 'planned', null, {
      kind: 'restaurant',
      venue: confirmed ? plan.restaurant_name : 'Exact venue after confirmation',
      description: confirmed ? 'Venue is visible because the date is confirmed.' : 'Venue stays private until confirmation.',
    });
  }
  if (plan?.status === 'published') push('plan_published', 'Published for eligible guests', 'completed', plan.updated_at, {
    kind: 'guest',
    description: 'Eligible guests can send interest. No one is added automatically.',
  });
  if (plan?.confirmed_guest_id) push('guest_confirmed', 'Guest confirmed', 'completed', plan.updated_at, {
    kind: 'guest',
    description: 'The organizer selected one guest and the private coordination steps unlocked.',
  });
  for (const item of addOns) {
    if (item?.type === 'scheduled_ride') {
      const rideAt = ride?.scheduled_at || item.scheduled_for || null;
      push(`add_on_${item.id}`, 'Ride coordination', ride ? ride.status || 'scheduled' : item.status || 'pending', rideAt, {
        kind: 'ride',
        add_on_id: item.id,
        description: ride ? 'Ride is linked. Exact pickup stays private from the organizer.' : 'Guest can add pickup after confirmation. No driver is dispatched early.',
        privacy: item.privacy_notice,
      });
      continue;
    }
    if (item?.type !== 'scheduled_date_add_on') continue;
    const hidden = Boolean(item.surprise_to_guest && plan?.confirmed_guest_id === viewerId);
    push(`add_on_${item.id}`, hidden ? 'Surprise add-on' : `${item.label || item.id} add-on`, item.status || 'pending', item.scheduled_for, {
      kind: 'add_on',
      add_on_id: item.id,
      provider: hidden ? null : item.vendor_name,
      refund_policy: item.refund_policy,
      recipient_rule: item.recipient_rule,
      delivery_destination: item.delivery_destination,
      description: item.status === 'paused_safety_review'
        ? 'Paused by Safety Center. Vendor work and payment authorization are held where possible.'
        : item.guest_preference_status === 'approved'
          ? 'Guest preferences are approved. Vendor scheduling can continue.'
          : 'Waiting for guest approval or vendor acceptance before final delivery.',
    });
    if (item.guest_preference_status === 'approved') {
      push(`add_on_${item.id}_guest_approved`, `${hidden ? 'Surprise add-on' : item.label || item.id} preferences approved`, 'completed', item.guest_approved_at, {
        kind: 'add_on',
        add_on_id: item.id,
        description: 'Guest approved or adjusted add-on preferences without exposing a private address.',
      });
    }
    if (item.payment_status && item.payment_status !== 'authorization_not_required') {
      push(`add_on_${item.id}_payment`, `${hidden ? 'Surprise add-on' : item.label || item.id} payment`, item.payment_status, item.payment_captured_at || item.payment_authorized_at, {
        kind: 'payment',
        add_on_id: item.id,
        description: item.payment_status === 'captured'
          ? 'Payment was captured after vendor acceptance.'
          : item.payment_status === 'authorized'
            ? 'Payment is authorized and waiting for vendor acceptance.'
            : 'Payment authorization is needed before vendor work begins.',
      });
    }
    if (item.vendor_status || item.vendor_accepted_at || item.vendor_declined_at) {
      push(`add_on_${item.id}_vendor`, `${hidden ? 'Surprise add-on' : item.label || item.id} vendor`, item.vendor_status || item.status || 'scheduled', item.vendor_accepted_at || item.vendor_declined_at, {
        kind: 'vendor',
        add_on_id: item.id,
        provider: hidden ? null : item.vendor_name,
        description: item.vendor_status === 'accepted'
          ? 'Vendor accepted the add-on order.'
          : item.vendor_status === 'fallback_pending_vendor_acceptance'
            ? 'Original vendor declined. A fallback provider is pending acceptance.'
            : item.vendor_status === 'replacement_suggested'
              ? 'Vendor suggested a replacement for review.'
              : item.vendor_status === 'rejected_no_fallback'
                ? 'Vendor declined and no fallback provider was available.'
                : 'Vendor fulfillment status updated.',
      });
    }
    if (Array.isArray(item.fallback_history) && item.fallback_history.length) {
      const latestFallback = item.fallback_history[item.fallback_history.length - 1];
      push(`add_on_${item.id}_fallback_${item.fallback_history.length}`, `${hidden ? 'Surprise add-on' : item.label || item.id} fallback`, 'fallback_pending_vendor_acceptance', latestFallback?.at, {
        kind: 'vendor',
        add_on_id: item.id,
        description: 'The system moved this add-on to another eligible provider after a vendor decline.',
      });
    }
    if (item.status === 'preparing' || item.status === 'out_for_delivery' || item.status === 'delivered') {
      push(`add_on_${item.id}_fulfillment`, `${hidden ? 'Surprise add-on' : item.label || item.id} fulfillment`, item.status, item.delivery_proof?.submitted_at || null, {
        kind: 'delivery',
        add_on_id: item.id,
        provider: hidden ? null : item.vendor_name,
        description: item.status === 'delivered'
          ? 'Vendor marked the add-on delivered.'
          : item.status === 'out_for_delivery'
            ? 'Add-on is out for delivery to the approved destination.'
            : 'Vendor is preparing the add-on.',
      });
    }
    if (item.delivery_proof?.submitted_at) {
      push(`add_on_${item.id}_proof`, `${hidden ? 'Surprise add-on' : item.label || item.id} delivery proof`, 'completed', item.delivery_proof.submitted_at, {
        kind: 'delivery',
        add_on_id: item.id,
        description: 'Delivery proof was uploaded for the add-on.',
      });
    }
    if (item.safety_pause?.paused_at) {
      push(`add_on_${item.id}_safety_pause`, `${hidden ? 'Surprise add-on' : item.label || item.id} paused for safety`, 'paused_safety_review', item.safety_pause.paused_at, {
        kind: 'safety',
        add_on_id: item.id,
        description: 'A safety report paused this add-on for manual review.',
      });
    }
  }
  if (plan?.status === 'completed') push('date_completed', 'Date completed', 'completed', plan.updated_at, {
    kind: 'completion',
    description: 'Date plan is complete.',
  });
  if (plan?.status === 'cancelled') push('date_cancelled', 'Date cancelled', 'cancelled', plan.updated_at, {
    kind: 'completion',
    description: 'Date plan is cancelled. Pending add-ons and rides are cancelled or moved to manual review based on policy.',
  });
  return rows.filter((row) => row.title);
}

function serializePlan(plan, viewerId, rideById = new Map()) {
  const isOrganizer = plan.organizer_id === viewerId;
  const isGuest = plan.confirmed_guest_id === viewerId;
  const confirmed = isGuest || isOrganizer;
  const preciseAllowed = confirmed;
  const ride = plan.ride_request_id ? rideById.get(plan.ride_request_id) : null;
  const addOns = serializeWorthItAddOns(plan, confirmed);
  return {
    dating_date_plan_id: plan.dating_date_plan_id,
    organizer_id: plan.organizer_id,
    organizer: serializePerson(plan.organizer),
    status: plan.status,
    visibility: plan.visibility,
    title: plan.title,
    restaurant_name: plan.restaurant_name,
    restaurant_address: preciseAllowed ? plan.restaurant_address : null,
    vendor: plan.vendor,
    vendor_id: plan.vendor_id,
    booking_id: confirmed ? plan.booking_id : null,
    ride_linked: confirmed ? Boolean(plan.ride_request_id) : false,
    ride_request_id: isGuest ? plan.ride_request_id : null,
    gift_order_id: confirmed ? plan.gift_order_id : null,
    date: plan.date,
    time: plan.time,
    party_size: plan.party_size,
    budget_amount: plan.budget_amount,
    currency: plan.currency,
    payment_split: plan.payment_split,
    deposit_amount: plan.deposit_amount,
    cancellation_window_hours: plan.cancellation_window_hours,
    attendance_score_required: plan.attendance_score_required,
    host_note: plan.host_note,
    menu_intent: plan.menu_intent,
    add_ons: addOns,
    timeline: worthItDateTimeline(plan, viewerId, ride, addOns),
    includes_ride: plan.includes_ride,
    ride_status_shared_with_organizer: worthItRidePrivacy(plan.add_ons).share_status_with_organizer,
    ride_summary: confirmed ? serializeWorthItRideSummary(plan, viewerId, ride) : null,
    includes_flowers: plan.includes_flowers,
    safety_rules: plan.safety_rules,
    accepted_interest_id: plan.accepted_interest_id,
    confirmed_guest_id: confirmed ? plan.confirmed_guest_id : null,
    lat: preciseAllowed ? plan.lat : null,
    lng: preciseAllowed ? plan.lng : null,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    interests: isOrganizer
      ? plan.interests?.map((interest) => ({
          dating_date_interest_id: interest.dating_date_interest_id,
          user_id: interest.user_id,
          user: serializePerson(interest.user),
          status: interest.status,
          message: interest.message,
          selected_menu: interest.selected_menu,
          budget_amount: interest.budget_amount,
          created_at: interest.created_at,
        }))
      : undefined,
    invites: isOrganizer
      ? plan.invites?.map((invite) => ({
          dating_date_invite_id: invite.dating_date_invite_id,
          recipient_id: invite.recipient_id,
          recipient: serializePerson(invite.recipient),
          status: invite.status,
          note: invite.note,
          created_at: invite.created_at,
        }))
      : undefined,
  };
}

async function notifyDating(req, { userId, type, title, body, entityType, entityId, data, urgency = 'ambient' }) {
  notify(req.app.get('io'), {
    userId,
    vertical: 'dating',
    type,
    title,
    body,
    entityType,
    entityId,
    actionUrl: 'dating',
    data,
    urgency,
  });
}

async function requireDatingAdult(req, res, next) {
  try {
    const profile = await ensureProfile(req.user.user_id);
    if (!profile) return res.status(404).json({ successful: false, message: 'User not found' });
    if (!assertAdult(profile)) {
      return res.status(403).json({ successful: false, message: 'Dating profile requires adult confirmation' });
    }
    req.datingProfile = profile;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(authenticateToken);

router.get('/me', async (req, res, next) => {
  try {
    const profile = await ensureProfile(req.user.user_id);
    const adult = assertAdult(profile);
    return res.json({
      successful: true,
      data: {
        ...profile,
        dating_privacy_settings: normalizeDatingPrivacySettings(profile?.lifestyle_signals?.privacy_settings),
        crossed_paths_settings: normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths),
      },
      adult,
      dating_access: Boolean(adult),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/profile', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const existingProfile = await ensureProfile(userId);
    if (!existingProfile) return res.status(404).json({ successful: false, message: 'User not found' });
    const birthdate = req.body?.birthdate ? new Date(req.body.birthdate) : undefined;
    if (birthdate && Number.isNaN(birthdate.getTime())) {
      return res.status(400).json({ successful: false, message: 'Invalid birthdate' });
    }
    const isConfirmingAge = req.body?.adult_confirmed === true || birthdate;
    const effectiveBirthdate = birthdate ?? existingProfile?.birthdate ?? null;
    if (isConfirmingAge && !effectiveBirthdate) {
      return res.status(400).json({ successful: false, message: 'Date of birth is required to access Dating' });
    }
    if (isConfirmingAge && ageFromBirthdate(effectiveBirthdate) < 18) {
      return res.status(403).json({ successful: false, message: 'Dating is restricted to users 18 or older' });
    }
    if (touchesDatingProfileContent(req.body) && !assertAdult({ ...existingProfile, birthdate: effectiveBirthdate })) {
      return res.status(403).json({ successful: false, message: 'Please confirm you are 18+ before editing your Dating profile' });
    }
    const radius = req.body?.radius_km != null ? Math.max(1, Math.min(Number(req.body.radius_km) || 25, MAX_RADIUS_KM)) : undefined;
    const hasLat = bodyHasKey(req.body, 'lat');
    const hasLng = bodyHasKey(req.body, 'lng');
    const lat = hasLat ? cleanCoordinate(req.body?.lat) : undefined;
    const lng = hasLng ? cleanCoordinate(req.body?.lng) : undefined;
    if ((hasLat !== hasLng) || (hasLat && lat === null) || (hasLng && lng === null)) {
      return res.status(400).json({ successful: false, message: 'Invalid profile coordinates' });
    }
    const lifestyleSignals = req.body?.lifestyle_signals && typeof req.body.lifestyle_signals === 'object'
      ? sanitizeLifestyleSignals(req.body.lifestyle_signals, existingProfile?.lifestyle_signals)
      : undefined;
    const data = {
      display_name: cleanString(req.body?.display_name, 100) ?? undefined,
      bio: cleanString(req.body?.bio, 1200) ?? undefined,
      birthdate,
      gender: cleanString(req.body?.gender, 40) ?? undefined,
      interested_in: Array.isArray(req.body?.interested_in) ? req.body.interested_in.slice(0, 10) : undefined,
      location_label: cleanString(req.body?.location_label, 255) ?? undefined,
      lat,
      lng,
      radius_km: radius,
      photos: Array.isArray(req.body?.photos) ? req.body.photos.filter(Boolean).slice(0, 8) : undefined,
      prompts: Array.isArray(req.body?.prompts) ? req.body.prompts.slice(0, 8) : undefined,
      lifestyle_signals: lifestyleSignals,
      true_love_opt_in: req.body?.true_love_opt_in != null ? Boolean(req.body.true_love_opt_in) : undefined,
      is_discoverable: req.body?.is_discoverable != null ? Boolean(req.body.is_discoverable) : undefined,
      age_verified_at: isConfirmingAge && ageFromBirthdate(effectiveBirthdate) >= 18 ? new Date() : undefined,
      last_active_at: new Date(),
    };
    Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);
    const profile = await prisma.dating_profile.update({ where: { user_id: userId }, data });
    return res.json({
      successful: true,
      data: {
        ...profile,
        dating_privacy_settings: normalizeDatingPrivacySettings(profile?.lifestyle_signals?.privacy_settings),
        crossed_paths_settings: normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths),
      },
      adult: assertAdult(profile),
      dating_access: Boolean(assertAdult(profile)),
    });
  } catch (err) {
    next(err);
  }
});

router.use(requireDatingAdult);

router.get('/blocked', async (req, res, next) => {
  try {
    const graph = await outgoingBlockedGraphForUser(req.user.user_id);
    const targetIds = graph.userIds.filter((id) => id !== req.user.user_id).slice(0, 100);
    const users = targetIds.length ? await prisma.user.findMany({
      where: { user_id: { in: targetIds } },
      select: {
        user_id: true,
        name: true,
        social_profiles: { select: { display_name: true, profile_pic_url: true } },
        dating_profiles: { take: 1, select: { display_name: true, photos: true } },
      },
    }).catch(() => []) : [];
    const byUser = new Map(users.map((user) => [user.user_id, user]));
    return res.json({
      successful: true,
      data: targetIds.map((targetId) => serializeBlockedUser({
        target_id: targetId,
        mode: 'platform',
        created_at: null,
        target: byUser.get(targetId) || { user_id: targetId },
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/blocked/:targetUserId', async (req, res, next) => {
  try {
    const blockerUserId = req.user.user_id;
    const blockedUserId = asInt(req.params.targetUserId);
    if (!blockedUserId || blockedUserId === blockerUserId) {
      return res.status(400).json({ successful: false, message: 'Invalid blocked user' });
    }
    await prisma.$transaction(async (tx) => {
      await deletePlatformBlockBetweenUsers(tx, blockerUserId, blockedUserId);
    });
    return res.json({ successful: true });
  } catch (err) {
    next(err);
  }
});

router.get('/crossed-paths', async (req, res, next) => {
  try {
    await purgeExpiredCrossedPathData();
    const userId = req.user.user_id;
    const profile = req.datingProfile;
    const settings = normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths);
    if (!hasCrossedPathModels()) {
      return res.json({
        successful: true,
        data: {
          settings,
          candidates: [],
          unavailable: true,
          message: 'Crossed Paths is unavailable until the database migration is applied.',
        },
      });
    }
    if (!settings.enabled || settings.incognito) {
      return res.json({ successful: true, data: { settings, candidates: [] } });
    }
    const now = new Date();
    const privacyExcluded = await crossedPathPrivacyExcludedUserIds(userId, profile);
    let rows = [];
    try {
      rows = await prisma.dating_crossed_path_candidate.findMany({
        where: {
          status: 'active',
          visible_after: { lte: now },
          expires_at: { gt: now },
          OR: [{ user_a_id: userId }, { user_b_id: userId }],
        },
        orderBy: [{ last_bucket: 'desc' }, { encounter_count: 'desc' }],
        take: 50,
      });
    } catch (err) {
      if (!isCrossedPathStorageUnavailable(err)) throw err;
      return res.json({
        successful: true,
        data: {
          settings,
          candidates: [],
          unavailable: true,
          message: 'Crossed Paths is unavailable until the database migration is applied.',
        },
      });
    }
    const otherIds = Array.from(new Set(
      rows
        .map((row) => (row.user_a_id === userId ? row.user_b_id : row.user_a_id))
        .filter((id) => id && !privacyExcluded.has(id))
    ));
    const profiles = otherIds.length ? await prisma.dating_profile.findMany({
      where: {
        user_id: { in: otherIds },
        status: 'active',
        is_discoverable: true,
        OR: [
          { age_verified_at: { not: null } },
          { birthdate: { lte: adultCutoffDate() } },
        ],
        user: { deleted_at: null, account_status: 'active' },
      },
      include: {
        user: {
          select: {
            user_id: true,
            name: true,
            social_profiles: { select: { display_name: true, bio: true, profile_pic_url: true, is_verified: true } },
          },
        },
      },
    }) : [];
    const byUser = new Map(profiles.filter((p) => isVisibleDatingProfile(p)).map((p) => [p.user_id, p]));
    const candidates = [];
    for (const row of rows) {
      const otherId = row.user_a_id === userId ? row.user_b_id : row.user_a_id;
      const otherProfile = byUser.get(otherId);
      if (!otherProfile) continue;
      const otherSettings = normalizeCrossedPathSettings(otherProfile?.lifestyle_signals?.crossed_paths);
      if (!otherSettings.enabled || otherSettings.incognito) continue;
      if (await isDatingBlockedBetween(userId, otherId)) continue;
      const otherExcluded = await crossedPathPrivacyExcludedUserIds(otherId, otherProfile);
      if (otherExcluded.has(userId)) continue;
      if (!datingPreferencesCompatible(profile, otherProfile)) continue;
      const otherAge = ageFromBirthdate(otherProfile.birthdate);
      const viewerAge = ageFromBirthdate(profile.birthdate);
      if (otherAge != null && (otherAge < settings.age_min || otherAge > settings.age_max)) continue;
      if (viewerAge != null && (viewerAge < otherSettings.age_min || viewerAge > otherSettings.age_max)) continue;
      candidates.push(serializeCrossedPathCandidate(row, otherProfile));
      if (candidates.length >= 20) break;
    }
    return res.json({ successful: true, data: { settings, candidates } });
  } catch (err) {
    next(err);
  }
});

router.patch('/crossed-paths/settings', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const existingSignals = req.datingProfile?.lifestyle_signals || {};
    const nextSettings = normalizeCrossedPathSettings(req.body || {});
    const lifestyleSignals = sanitizeLifestyleSignals({
      ...existingSignals,
      crossed_paths: nextSettings,
    }, existingSignals);
    const profile = await prisma.dating_profile.update({
      where: { user_id: userId },
      data: { lifestyle_signals: lifestyleSignals, last_active_at: new Date() },
    });
    return res.json({
      successful: true,
      data: {
        settings: normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/crossed-paths/events', crossedPathEventLimiter, async (req, res, next) => {
  try {
    await purgeExpiredCrossedPathData();
    const userId = req.user.user_id;
    const profile = req.datingProfile;
    const settings = normalizeCrossedPathSettings(profile?.lifestyle_signals?.crossed_paths);
    if (!hasCrossedPathModels()) {
      return res.status(503).json({
        successful: false,
        message: 'Crossed Paths is unavailable until the database migration is applied.',
      });
    }
    if (!settings.enabled || settings.incognito) {
      return res.status(403).json({ successful: false, message: 'Crossed Paths is not enabled' });
    }
    const coords = crossedPathCoords(req.body?.lat, req.body?.lng);
    if (!coords) return res.status(400).json({ successful: false, message: 'Invalid location' });
    const locationCheck = await validateCrossedPathEventLocation(userId, profile, coords);
    if (!locationCheck.ok) {
      return res.status(locationCheck.status).json({ successful: false, message: locationCheck.message });
    }
    const gridCell = crossedPathGridCell(coords.lat, coords.lng);
    if (!gridCell) return res.status(400).json({ successful: false, message: 'Invalid location' });
    const now = new Date();
    const timeBucket = crossedPathTimeBucket(now);
    const expiresAt = addDays(now, CROSSED_PATH_RETENTION_DAYS);
    const visibleAfter = addMinutes(now, CROSSED_PATH_DELAY_MINUTES);
    const areaLabel = crossedPathAreaLabel();
    try {
      const existingBucketEvents = await prisma.dating_crossed_path_event.findMany({
        where: {
          user_id: userId,
          time_bucket: timeBucket,
          expires_at: { gt: now },
        },
        select: { grid_cell: true },
        take: CROSSED_PATH_MAX_CELLS_PER_BUCKET + 1,
      });
      const existingCells = new Set(existingBucketEvents.map((event) => event.grid_cell).filter(Boolean));
      if (!existingCells.has(gridCell) && existingCells.size >= CROSSED_PATH_MAX_CELLS_PER_BUCKET) {
        return res.status(429).json({
          successful: false,
          message: 'Too many nearby areas recorded for this time window. Please try again later.',
        });
      }
      const overlapping = await prisma.dating_crossed_path_event.findMany({
        where: {
          user_id: { not: userId },
          grid_cell: gridCell,
          time_bucket: timeBucket,
          expires_at: { gt: now },
        },
        select: { user_id: true },
        take: 100,
      });
      const otherIds = Array.from(new Set(overlapping.map((row) => row.user_id).filter(Boolean)));
      const otherProfiles = otherIds.length ? await prisma.dating_profile.findMany({
        where: {
          user_id: { in: otherIds },
          status: 'active',
          is_discoverable: true,
          OR: [
            { age_verified_at: { not: null } },
            { birthdate: { lte: adultCutoffDate() } },
          ],
        },
        select: {
          user_id: true,
          birthdate: true,
          gender: true,
          interested_in: true,
          lifestyle_signals: true,
        },
      }) : [];
      const viewerExcluded = await crossedPathPrivacyExcludedUserIds(userId, profile);
      const viewerAge = ageFromBirthdate(profile.birthdate);
      const candidatePayloads = (await Promise.all(otherProfiles.map(async (otherProfile) => {
        const otherId = otherProfile.user_id;
        const otherSettings = normalizeCrossedPathSettings(otherProfile?.lifestyle_signals?.crossed_paths);
        if (!otherSettings.enabled || otherSettings.incognito) return null;
        if (viewerExcluded.has(otherId)) return null;
        const [blocked, otherExcluded] = await Promise.all([
          isDatingBlockedBetween(userId, otherId),
          crossedPathPrivacyExcludedUserIds(otherId, otherProfile),
        ]);
        if (blocked || otherExcluded.has(userId)) return null;
        if (!datingPreferencesCompatible(profile, otherProfile)) return null;
        const otherAge = ageFromBirthdate(otherProfile.birthdate);
        if (otherAge != null && (otherAge < settings.age_min || otherAge > settings.age_max)) return null;
        if (viewerAge != null && (viewerAge < otherSettings.age_min || viewerAge > otherSettings.age_max)) return null;
        const [userA, userB] = crossedPathPair(userId, otherId);
        return {
          user_a_id: userA,
          user_b_id: userB,
          grid_cell: gridCell,
          area_label: areaLabel,
          first_bucket: timeBucket,
          last_bucket: timeBucket,
          visible_after: visibleAfter,
          expires_at: expiresAt,
        };
      }))).filter(Boolean).slice(0, 50);

      await prisma.$transaction(async (tx) => {
        await tx.dating_crossed_path_event.upsert({
          where: {
            user_id_grid_cell_time_bucket: {
              user_id: userId,
              grid_cell: gridCell,
              time_bucket: timeBucket,
            },
          },
          update: { area_label: areaLabel, expires_at: expiresAt },
          create: { user_id: userId, grid_cell: gridCell, time_bucket: timeBucket, area_label: areaLabel, expires_at: expiresAt },
        });
        for (const candidate of candidatePayloads) {
          await tx.dating_crossed_path_candidate.upsert({
            where: {
              user_a_id_user_b_id_grid_cell: {
                user_a_id: candidate.user_a_id,
                user_b_id: candidate.user_b_id,
                grid_cell: candidate.grid_cell,
              },
            },
            update: {
              area_label: candidate.area_label,
              last_bucket: candidate.last_bucket,
              encounter_count: { increment: 1 },
              visible_after: candidate.visible_after,
              expires_at: candidate.expires_at,
              status: 'active',
            },
            create: {
              user_a_id: candidate.user_a_id,
              user_b_id: candidate.user_b_id,
              grid_cell: candidate.grid_cell,
              area_label: candidate.area_label,
              first_bucket: candidate.first_bucket,
              last_bucket: candidate.last_bucket,
              encounter_count: 1,
              visible_after: candidate.visible_after,
              expires_at: candidate.expires_at,
            },
          });
        }
      });
    } catch (err) {
      if (!isCrossedPathStorageUnavailable(err)) throw err;
      return res.status(503).json({
        successful: false,
        message: 'Crossed Paths is unavailable until the database migration is applied.',
      });
    }
    return res.status(201).json({
      successful: true,
      data: {
        recorded: true,
        visible_after: visibleAfter,
        expires_at: expiresAt,
        precision: 'coarse_grid',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/discover', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const profile = req.datingProfile;
    const mode = DATE_MODES.has(String(req.query.mode)) ? String(req.query.mode) : 'standard';
    if (mode === 'true-love' && !profile?.true_love_opt_in) {
      return res.status(403).json({
        successful: false,
        code: 'TRUE_LOVE_OPT_IN_REQUIRED',
        message: 'Turn on True Love Mode before using deep compatibility discovery.',
      });
    }
    const take = Math.min(asInt(req.query.limit) || 12, 30);
    const requestedFilters = new Set(String(req.query.filters || '').split(',').filter((value) => DISCOVER_FILTERS.has(value)));
    const maxDistanceKm = cleanPercent(req.query.distance_km, null);
    const minAge = clampInt(req.query.age_min, 18, 18, 99);
    const maxAge = clampInt(req.query.age_max, 99, minAge, 99);
    const [swiped, blockedMe, privacyExcludedIds] = await Promise.all([
      prisma.dating_swipe.findMany({
        where: { actor_id: userId, mode },
        select: { target_id: true },
      }),
      prisma.dating_swipe.findMany({
        where: { target_id: userId, action: 'block' },
        select: { actor_id: true },
      }),
      datingPrivacyExcludedUserIds(userId, { profile }),
    ]);
    const skipIds = Array.from(new Set([
      ...privacyExcludedIds,
      ...swiped.map((s) => s.target_id),
      ...blockedMe.map((s) => s.actor_id),
    ]));
    const where = {
      user_id: { notIn: skipIds },
      status: 'active',
      is_discoverable: true,
      OR: [
        { age_verified_at: { not: null } },
        { birthdate: { lte: adultCutoffDate() } },
      ],
      user: { deleted_at: null, account_status: 'active' },
    };
    if (mode === 'true-love') where.true_love_opt_in = true;
    const profiles = await prisma.dating_profile.findMany({
      where,
      orderBy: [{ last_active_at: 'desc' }, { dating_profile_id: 'desc' }],
      take: requestedFilters.size ? Math.min(take * 4, 100) : take,
      include: {
        user: {
          select: {
            user_id: true,
            name: true,
            social_profiles: { select: { display_name: true, bio: true, profile_pic_url: true, is_verified: true } },
          },
        },
      },
    });
    const today = startOfTodayUTC();
    const visible = profiles.filter(isVisibleDatingProfile).map((candidate) => ({
      profile: candidate,
      distance: distanceKm(profile.lat, profile.lng, candidate.lat, candidate.lng),
    })).filter(({ profile: candidate, distance }) => {
      if (!datingPreferencesCompatible(profile, candidate)) return false;
      if (requestedFilters.has('nearby')) {
        const radius = Math.min(maxDistanceKm || Number(profile.radius_km) || MAX_RADIUS_KM, Number(candidate.radius_km) || MAX_RADIUS_KM, MAX_RADIUS_KM);
        if (distance == null || distance > radius) return false;
      }
      const age = ageFromBirthdate(candidate.birthdate);
      if (age != null && (age < minAge || age > maxAge)) return false;
      if (requestedFilters.has('intentional') && !(candidate.bio || (Array.isArray(candidate.prompts) && candidate.prompts.length))) return false;
      if (requestedFilters.has('food_match') && !hasSharedSignal(profile, candidate, ['food', 'foods', 'cuisine', 'cuisines', 'diet'])) return false;
      if (requestedFilters.has('music_match') && !hasSharedSignal(profile, candidate, ['music', 'artist', 'artists', 'genres', 'media'])) return false;
      if (requestedFilters.has('active_today') && (!candidate.last_active_at || candidate.last_active_at < today)) return false;
      return true;
    }).slice(0, take);
    return res.json({
      successful: true,
      data: visible.map(({ profile: p, distance }) => {
        const { reasons, explanations } = matchInsights(profile, p, distance, { trueLove: mode === 'true-love' });
        return publicProfile(p, {
          distance_km: distance != null ? Math.round(distance * 10) / 10 : null,
          match_reasons: reasons,
          match_explanations: explanations,
          compatibility_score: compatibilityScore(reasons, distance),
        });
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/likes-you', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const mode = DATE_MODES.has(String(req.query.mode)) ? String(req.query.mode) : 'standard';
    const [outgoing, privacyExcludedIds] = await Promise.all([
      prisma.dating_swipe.findMany({
        where: { actor_id: userId, mode },
        select: { target_id: true, action: true },
      }),
      datingPrivacyExcludedUserIds(userId, { profile: req.datingProfile }),
    ]);
    const skipIds = new Set([...privacyExcludedIds, ...outgoing.map((swipe) => swipe.target_id)]);
    const inbound = await prisma.dating_swipe.findMany({
      where: {
        target_id: userId,
        mode,
        action: { in: ['like', 'super_like'] },
        actor_id: { notIn: Array.from(skipIds) },
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(asInt(req.query.limit) || 30, 50),
      include: {
        actor: {
          include: {
            dating_profiles: {
              include: {
                user: {
                  select: {
                    user_id: true,
                    name: true,
                    social_profiles: { select: { display_name: true, bio: true, profile_pic_url: true, is_verified: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const rows = inbound
      .map((swipe) => {
        const datingProfiles = Array.isArray(swipe.actor?.dating_profiles) ? swipe.actor.dating_profiles : [swipe.actor?.dating_profiles].filter(Boolean);
        const profile = datingProfiles[0];
        return profile && isVisibleDatingProfile(profile) && assertAdult(profile)
          ? { swipe_id: swipe.dating_swipe_id, action: swipe.action, created_at: swipe.created_at, profile: publicProfile(profile) }
          : null;
      })
      .filter(Boolean);
    return res.json({ successful: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/swipes', async (req, res, next) => {
  try {
    const actorId = req.user.user_id;
    const targetId = asInt(req.body?.target_user_id);
    const action = String(req.body?.action || '').toLowerCase();
    const mode = DATE_MODES.has(String(req.body?.mode)) ? String(req.body.mode) : 'standard';
    if (!targetId || targetId === actorId || !SWIPE_ACTIONS.has(action)) {
      return res.status(400).json({ successful: false, message: 'Invalid swipe' });
    }
    const targetProfile = await prisma.dating_profile.findUnique({
      where: { user_id: targetId },
      include: { user: { select: { user_id: true } } },
    });
    if (!targetProfile) {
      return res.status(404).json({ successful: false, message: 'Profile not available' });
    }
    if (action !== 'block' && !assertAdult(targetProfile)) {
      return res.status(404).json({ successful: false, message: 'Profile not available' });
    }
    if (action !== 'block' && await isDatingBlockedBetween(actorId, targetId)) {
      return res.status(404).json({ successful: false, message: 'Profile not available' });
    }

    const now = new Date();
    const swipe = await prisma.dating_swipe.upsert({
      where: { actor_id_target_id_mode: { actor_id: actorId, target_id: targetId, mode } },
      update: { action, created_at: now },
      create: { actor_id: actorId, target_id: targetId, action, mode },
    });
    let match = null;
    if (action === 'block') {
      const [a, b] = actorId < targetId ? [actorId, targetId] : [targetId, actorId];
      await prisma.$transaction(async (tx) => {
        await createPlatformBlockBetweenUsers(tx, actorId, targetId);
        const matchesToClose = await tx.dating_match.findMany({
          where: { user_a_id: a, user_b_id: b, status: { not: 'blocked' } },
          select: { chat_channel_id: true },
        });
        await tx.dating_match.updateMany({
          where: { user_a_id: a, user_b_id: b, status: { not: 'blocked' } },
          data: { status: 'blocked', unmatched_at: now },
        });
        if (hasCrossedPathModels(tx)) {
          await tx.dating_crossed_path_candidate.deleteMany({
            where: {
              OR: [
                { user_a_id: a, user_b_id: b },
                { user_a_id: b, user_b_id: a },
              ],
            },
          }).catch((err) => {
            if (!isCrossedPathStorageUnavailable(err)) throw err;
          });
        }
        for (const existingMatch of matchesToClose) {
          if (existingMatch.chat_channel_id) {
            await tx.chat_channel.update({
              where: { channel_id: existingMatch.chat_channel_id },
              data: { status: 'blocked' },
            });
            await tx.chat_participants.updateMany({
              where: { channel_id: existingMatch.chat_channel_id, user_id: { in: [actorId, targetId] } },
              data: { left_at: now },
            });
          }
        }
        await closeDirectChatsBetweenUsers(tx, actorId, targetId);
      });
    }
    if (action === 'like' || action === 'super_like') {
      const reverse = await prisma.dating_swipe.findFirst({ where: { actor_id: targetId, target_id: actorId, mode, action: { in: ['like', 'super_like'] } } });
      if (reverse) {
        const [a, b] = actorId < targetId ? [actorId, targetId] : [targetId, actorId];
        match = await prisma.dating_match.upsert({
          where: { user_a_id_user_b_id_mode: { user_a_id: a, user_b_id: b, mode } },
          update: { status: 'matched', unmatched_at: null },
          create: { user_a_id: a, user_b_id: b, mode },
        });
        notifyDating(req, {
          userId: targetId,
          type: 'dating.match',
          title: 'New dating match',
          body: 'You have a new mutual match on Strug Dating.',
          entityType: 'dating_match',
          entityId: match.dating_match_id,
          data: { mode },
          urgency: 'actionable',
        });
        emitUserMail({
          userId: targetId,
          templateName: 'dating-match',
          subjectKey: 'emails.dating_match.subject',
          variables: { cta_url: `${appPublicBase()}/dating` },
        }).catch(() => {});
      } else {
        notifyDating(req, {
          userId: targetId,
          type: action === 'super_like' ? 'dating.super_like' : 'dating.like',
          title: action === 'super_like' ? 'Priority dating interest' : 'Someone liked your profile',
          body: action === 'super_like' ? 'A Strug Dating member sent you priority interest.' : 'Review your Likes You page to respond.',
          entityType: 'dating_swipe',
          entityId: swipe.dating_swipe_id,
          data: { mode, action },
          urgency: action === 'super_like' ? 'actionable' : 'ambient',
        });
      }
    }
    return res.status(201).json({ successful: true, data: { swipe, match } });
  } catch (err) {
    next(err);
  }
});

router.get('/matches', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const matches = await prisma.dating_match.findMany({
      where: { status: 'matched', OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      orderBy: { matched_at: 'desc' },
      take: 50,
    });
    const otherIds = matches.map((m) => (m.user_a_id === userId ? m.user_b_id : m.user_a_id));
    const profiles = await prisma.dating_profile.findMany({
      where: { user_id: { in: otherIds } },
      include: { user: { select: { user_id: true, name: true, social_profiles: { select: { display_name: true, bio: true, profile_pic_url: true, is_verified: true } } } } },
    });
    const byUser = new Map(profiles.filter((p) => isVisibleDatingProfile(p)).map((p) => [p.user_id, publicProfile(p)]));
    return res.json({ successful: true, data: matches.map((m) => ({ ...m, other_user: byUser.get(m.user_a_id === userId ? m.user_b_id : m.user_a_id) })).filter((match) => match.other_user) });
  } catch (err) {
    next(err);
  }
});

router.post('/matches/:id/chat', async (req, res, next) => {
  try {
    const result = await findUserMatch(req.params.id, req.user.user_id);
    if (!result || result.match.status !== 'matched') {
      return res.status(404).json({ successful: false, message: 'Dating match not found' });
    }
    const channel = await openDatingMatchChannel(result.match, req.user.user_id, result.otherUserId);
    await prisma.dating_match.update({
      where: { dating_match_id: result.match.dating_match_id },
      data: { chat_channel_id: channel.channel_id },
    });
    return res.json({ successful: true, data: { ...channel, match_id: result.match.dating_match_id } });
  } catch (err) {
    next(err);
  }
});

router.patch('/matches/:id/unmatch', async (req, res, next) => {
  try {
    const result = await findUserMatch(req.params.id, req.user.user_id);
    if (!result || result.match.status !== 'matched') {
      return res.status(404).json({ successful: false, message: 'Dating match not found' });
    }
    const updated = await prisma.dating_match.update({
      where: { dating_match_id: result.match.dating_match_id },
      data: { status: 'unmatched', unmatched_at: new Date() },
    });
    notifyDating(req, {
      userId: result.otherUserId,
      type: 'dating.match.unmatched',
      title: 'Dating match ended',
      body: 'A dating match was closed.',
      entityType: 'dating_match',
      entityId: result.match.dating_match_id,
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/matches/:id/block', async (req, res, next) => {
  try {
    const result = await findUserMatch(req.params.id, req.user.user_id);
    if (!result) return res.status(404).json({ successful: false, message: 'Dating match not found' });
    const now = new Date();
    const [block, match] = await prisma.$transaction(async (tx) => {
      const [a, b] = req.user.user_id < result.otherUserId
        ? [req.user.user_id, result.otherUserId]
        : [result.otherUserId, req.user.user_id];
      const createdBlock = await tx.dating_swipe.upsert({
        where: { actor_id_target_id_mode: { actor_id: req.user.user_id, target_id: result.otherUserId, mode: result.match.mode || 'standard' } },
        update: { action: 'block', created_at: now },
        create: { actor_id: req.user.user_id, target_id: result.otherUserId, action: 'block', mode: result.match.mode || 'standard' },
      });
      await createPlatformBlockBetweenUsers(tx, req.user.user_id, result.otherUserId);
      const matchesToClose = await tx.dating_match.findMany({
        where: { user_a_id: a, user_b_id: b, status: { not: 'blocked' } },
        select: { dating_match_id: true, chat_channel_id: true },
      });
      await tx.dating_match.updateMany({
        where: { user_a_id: a, user_b_id: b, status: { not: 'blocked' } },
        data: { status: 'blocked', unmatched_at: now },
      });
      if (hasCrossedPathModels(tx)) {
        await tx.dating_crossed_path_candidate.deleteMany({
          where: {
            OR: [
              { user_a_id: a, user_b_id: b },
              { user_a_id: b, user_b_id: a },
            ],
          },
        }).catch((err) => {
          if (!isCrossedPathStorageUnavailable(err)) throw err;
        });
      }
      for (const existingMatch of matchesToClose) {
        if (existingMatch.chat_channel_id) {
          await tx.chat_channel.update({
            where: { channel_id: existingMatch.chat_channel_id },
            data: { status: 'blocked' },
          });
          await tx.chat_participants.updateMany({
            where: { channel_id: existingMatch.chat_channel_id, user_id: { in: [req.user.user_id, result.otherUserId] } },
            data: { left_at: now },
          });
        }
      }
      await closeDirectChatsBetweenUsers(tx, req.user.user_id, result.otherUserId);
      return [createdBlock, { ...result.match, status: 'blocked', unmatched_at: now }];
    });
    return res.json({ successful: true, data: { block, match } });
  } catch (err) {
    next(err);
  }
});

router.post('/blind/join', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const activeSession = await prisma.dating_blind_session.findFirst({
      where: {
        status: { in: BLIND_ACTIVE_STATUSES },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
      },
      orderBy: { created_at: 'desc' },
    });
    if (activeSession) {
      return res.status(409).json({
        successful: false,
        message: 'You already have an active blind chat. End it before joining a new queue.',
        data: { session: activeSession },
      });
    }

    const expiresAt = new Date(Date.now() + BLIND_QUEUE_MINUTES * 60 * 1000);
    const config = blindJoinConfig(req.body);
    await prisma.dating_blind_queue.updateMany({ where: { user_id: userId, status: 'waiting' }, data: { status: 'cancelled' } });
    const candidates = await prisma.dating_blind_queue.findMany({
      where: { user_id: { not: userId }, status: 'waiting', expires_at: { gt: new Date() } },
      orderBy: { queued_at: 'asc' },
      take: 25,
      include: {
        user: {
          select: {
            user_id: true,
            dating_profiles: {
              where: { status: 'active' },
              take: 1,
            },
          },
        },
      },
    });
    const candidate = candidates.find((item) => blindPreferenceCompatible(req.datingProfile, config.preferences, item));
    if (candidate) {
      const sessionConfig = mergeBlindSessionConfig(config, candidate);
      const session = await prisma.$transaction(async (tx) => {
        const created = await tx.dating_blind_session.create({
          data: {
            user_a_id: candidate.user_id,
            user_b_id: userId,
            icebreakers: sessionConfig.icebreakers,
            reveal_policy: sessionConfig.reveal_policy,
            expires_at: new Date(Date.now() + BLIND_SESSION_HOURS * 60 * 60 * 1000),
          },
        });
        await tx.dating_blind_queue.update({ where: { dating_blind_queue_id: candidate.dating_blind_queue_id }, data: { status: 'matched', matched_session_id: created.dating_blind_session_id } });
        return created;
      });
      notifyDating(req, {
        userId: candidate.user_id,
        type: 'dating.blind.matched',
        title: 'Blind Date matched',
        body: 'An anonymous chat is ready.',
        entityType: 'dating_blind_session',
        entityId: session.dating_blind_session_id,
        urgency: 'actionable',
      });
      return res.status(201).json({ successful: true, data: { status: 'matched', session } });
    }
    const queue = await prisma.dating_blind_queue.create({
      data: {
        user_id: userId,
        boundaries: config.boundaries,
        expires_at: expiresAt,
      },
    });
    return res.status(201).json({ successful: true, data: { status: 'waiting', queue } });
  } catch (err) {
    next(err);
  }
});

router.get('/blind/session', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const session = await prisma.dating_blind_session.findFirst({
      where: { status: { in: BLIND_ACTIVE_STATUSES }, OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      orderBy: { created_at: 'desc' },
    });
    const queue = session ? null : await prisma.dating_blind_queue.findFirst({ where: { user_id: userId, status: 'waiting', expires_at: { gt: new Date() } }, orderBy: { queued_at: 'desc' } });
    const messageCount = await countBlindSessionMessages(session);
    const decoratedSession = session ? { ...session, reveal_status: blindRevealStatus(session, messageCount) } : null;
    return res.json({ successful: true, data: { session: decoratedSession, queue } });
  } catch (err) {
    next(err);
  }
});

router.post('/blind/sessions/:id/chat', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const userId = req.user.user_id;
    const session = await prisma.dating_blind_session.findFirst({
      where: {
        dating_blind_session_id: id,
        status: { in: BLIND_ACTIVE_STATUSES },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
      },
    });
    if (!session) return res.status(404).json({ successful: false, message: 'Blind session not found' });
    const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
    const channel = await openBlindSessionChannel(session, userId, otherId);
    if (!session.chat_channel_id) {
      await prisma.dating_blind_session.update({
        where: { dating_blind_session_id: id },
        data: { chat_channel_id: channel.channel_id },
      });
    }
    return res.json({ successful: true, data: { ...channel, session_id: id } });
  } catch (err) {
    next(err);
  }
});

router.post('/blind/sessions/:id/reveal', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const userId = req.user.user_id;
    const session = await prisma.dating_blind_session.findFirst({
      where: {
        dating_blind_session_id: id,
        status: { in: BLIND_ACTIVE_STATUSES },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
      },
    });
    if (!session) return res.status(404).json({ successful: false, message: 'Blind session not found' });
    const messageCount = await countBlindSessionMessages(session);
    const revealStatus = blindRevealStatus(session, messageCount);
    if (!revealStatus.can_request_reveal) {
      return res.status(409).json({
        successful: false,
        message: `Reveal unlocks after ${revealStatus.min_messages} messages or ${revealStatus.min_minutes} minutes.`,
        data: revealStatus,
      });
    }
    const confirmed = Array.isArray(session.reveal_confirmed_by) ? session.reveal_confirmed_by : [];
    const nextConfirmed = Array.from(new Set([...confirmed, userId]));
    const both = nextConfirmed.includes(session.user_a_id) && nextConfirmed.includes(session.user_b_id);
    const updated = await prisma.dating_blind_session.update({
      where: { dating_blind_session_id: id },
      data: {
        status: both ? 'revealed' : 'reveal_requested',
        reveal_requested_by: session.reveal_requested_by ?? userId,
        reveal_confirmed_by: nextConfirmed,
        revealed_at: both ? new Date() : session.revealed_at,
      },
    });
    const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
    notifyDating(req, {
      userId: otherId,
      type: both ? 'dating.blind.revealed' : 'dating.blind.reveal_requested',
      title: both ? 'Blind Date profile revealed' : 'Reveal requested',
      body: both ? 'You both agreed to reveal profiles.' : 'Your anonymous match requested a profile reveal.',
      entityType: 'dating_blind_session',
      entityId: id,
      urgency: 'actionable',
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.patch('/blind/sessions/:id/end', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const userId = req.user.user_id;
    const session = await prisma.dating_blind_session.findFirst({
      where: {
        dating_blind_session_id: id,
        status: { in: BLIND_ACTIVE_STATUSES },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
      },
    });
    if (!session) return res.status(404).json({ successful: false, message: 'Blind session not found' });
    const reason = cleanString(req.body?.reason, 255) || 'Ended by participant';
    const updated = await prisma.dating_blind_session.update({
      where: { dating_blind_session_id: id },
      data: { status: 'ended', ended_by: userId, ended_reason: reason, ended_at: new Date() },
    });
    if (session.chat_channel_id) {
      await prisma.chat_channel.update({ where: { channel_id: session.chat_channel_id }, data: { status: 'closed' } }).catch(() => null);
    }
    const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
    notifyDating(req, {
      userId: otherId,
      type: 'dating.blind.ended',
      title: 'Blind Date chat ended',
      body: 'Your anonymous blind chat was ended.',
      entityType: 'dating_blind_session',
      entityId: id,
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/blind/sessions/:id/report', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const userId = req.user.user_id;
    const session = await prisma.dating_blind_session.findFirst({
      where: {
        dating_blind_session_id: id,
        status: { in: [...BLIND_ACTIVE_STATUSES, 'ended'] },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
      },
    });
    if (!session) return res.status(404).json({ successful: false, message: 'Blind session not found' });
    const reason = cleanString(req.body?.reason, 80);
    if (!reason) return res.status(400).json({ successful: false, message: 'Reason is required' });
    const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
    const report = await prisma.dating_report.create({
      data: {
        reporter_id: userId,
        reported_user_id: otherId,
        entity_type: 'dating_blind_session',
        entity_id: id,
        reason,
        details: cleanString(req.body?.details, 2000),
      },
    });
    await prisma.dating_blind_session.update({
      where: { dating_blind_session_id: id },
      data: { status: 'reported', ended_by: userId, ended_reason: `Reported: ${reason}`, ended_at: new Date() },
    });
    if (session.chat_channel_id) {
      await prisma.chat_channel.update({ where: { channel_id: session.chat_channel_id }, data: { status: 'closed' } }).catch(() => null);
    }
    return res.status(201).json({ successful: true, data: report });
  } catch (err) {
    next(err);
  }
});

router.delete('/blind/queue', async (req, res, next) => {
  try {
    await prisma.dating_blind_queue.updateMany({ where: { user_id: req.user.user_id, status: 'waiting' }, data: { status: 'cancelled' } });
    return res.json({ successful: true });
  } catch (err) {
    next(err);
  }
});

router.get('/worth-it/plans', async (req, res, next) => {
  try {
    const viewerId = req.user.user_id;
    const privacyExcludedIds = await datingPrivacyExcludedUserIds(viewerId, { profile: req.datingProfile });
    const plans = await prisma.dating_date_plan.findMany({
      where: {
        status: 'published',
        visibility: 'public',
        organizer_id: { notIn: Array.from(privacyExcludedIds) },
        date: { gte: startOfTodayUTC() },
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: Math.min(asInt(req.query.limit) || 24, 50),
      include: planInclude(),
    });
    return res.json({ successful: true, data: plans.filter(isVisibleDatePlan).map((p) => serializePlan(p, viewerId)) });
  } catch (err) {
    next(err);
  }
});

router.get('/worth-it/my', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const blockedIds = await datingPrivacyExcludedUserIds(userId, { hideSocialGraph: false, profile: req.datingProfile });
    const [organized, interests, invites] = await Promise.all([
      prisma.dating_date_plan.findMany({ where: { organizer_id: userId }, orderBy: { created_at: 'desc' }, include: planInclude() }),
      prisma.dating_date_interest.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, include: { plan: { include: planInclude() } } }),
      prisma.dating_date_invite.findMany({ where: { recipient_id: userId }, orderBy: { created_at: 'desc' }, include: { plan: { include: planInclude() } } }),
    ]);
    const rideById = await worthItRideSummaryMap([
      ...organized,
      ...interests.map((interest) => interest.plan),
      ...invites.map((invite) => invite.plan),
    ]);
    return res.json({
      successful: true,
      data: {
        organized: organized.filter(isVisibleDatePlan).map((p) => serializePlan(scrubBlockedPlanPeople(p, blockedIds), userId, rideById)),
        interested: interests.filter((i) => isVisibleDatePlan(i.plan) && !blockedIds.has(i.plan.organizer_id)).map((i) => ({ ...i, plan: serializePlan(i.plan, userId, rideById) })),
        invites: invites.filter((i) => isVisibleDatePlan(i.plan) && !blockedIds.has(i.plan.organizer_id)).map((i) => ({ ...i, plan: serializePlan(i.plan, userId, rideById) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/worth-it/add-on-vendors', async (req, res, next) => {
  try {
    const type = cleanString(req.query?.type, 80)?.toLowerCase();
    if (!type || !WORTH_IT_SCHEDULED_ADD_ONS.has(type)) {
      return res.status(400).json({ successful: false, message: 'Valid add-on type is required' });
    }
    const vendors = await worthItMarketplaceVendors(type, clampInt(req.query?.limit, 20, 1, 50));
    return res.json({ successful: true, data: vendors });
  } catch (err) {
    next(err);
  }
});

router.post('/worth-it/plans', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const date = parsePlanDate(req.body?.date);
    const time = validTime(req.body?.time);
    const budget = cleanMoney(req.body?.budget_amount);
    const restaurantName = cleanString(req.body?.restaurant_name || req.body?.venue, 180);
    if (!date || !time || budget == null || budget <= 0 || !restaurantName) {
      return res.status(400).json({ successful: false, message: 'Restaurant, future date, time, and budget are required' });
    }
    const vendorId = asInt(req.body?.vendor_id);
    let vendor = null;
    if (vendorId) {
      vendor = await prisma.food_vendor.findUnique({ where: { vendor_id: vendorId } });
      if (!vendor) return res.status(404).json({ successful: false, message: 'Restaurant not found' });
    }
    const split = PAYMENT_SPLITS.has(String(req.body?.payment_split)) ? String(req.body.payment_split) : '50';
    const depositAmount = cleanMoney(req.body?.deposit_amount);
    const cancellationWindowHours = req.body?.cancellation_window_hours == null
      ? null
      : clampInt(req.body.cancellation_window_hours, 24, 1, 168);
    const attendanceScoreRequired = req.body?.attendance_score_required == null
      ? null
      : cleanPercent(req.body.attendance_score_required, 80);
    const lat = req.body?.lat != null ? cleanCoordinate(req.body.lat) : vendor?.lat ?? null;
    const lng = req.body?.lng != null ? cleanCoordinate(req.body.lng) : vendor?.long ?? null;
    if ((req.body?.lat != null && lat === null) || (req.body?.lng != null && lng === null)) {
      return res.status(400).json({ successful: false, message: 'Invalid date plan coordinates' });
    }
    const planDraft = {
      date,
      time,
      restaurant_name: vendor?.vendor_name || restaurantName,
      restaurant_address: cleanString(req.body?.restaurant_address || vendor?.location, 2000),
    };
    const marketplaceSelections = await worthItMarketplaceSelections(req.body?.add_ons);
    const normalizedAddOns = normalizeWorthItAddOns(req.body?.add_ons, planDraft, { marketplaceSelections });
    const missingMarketplace = requireWorthItMarketplaceSelections(normalizedAddOns, marketplaceSelections);
    if (missingMarketplace) return res.status(400).json({ successful: false, message: missingMarketplace });
    const plan = await prisma.dating_date_plan.create({
      data: {
        organizer_id: userId,
        status: req.body?.publish === true ? 'published' : 'draft',
        visibility: req.body?.publish === true ? 'public' : 'private',
        title: cleanString(req.body?.title, 160),
        restaurant_name: planDraft.restaurant_name,
        restaurant_address: planDraft.restaurant_address,
        vendor_id: vendorId,
        booking_id: asInt(req.body?.booking_id),
        ride_request_id: null,
        gift_order_id: asInt(req.body?.gift_order_id),
        date,
        time,
        party_size: Math.max(2, Math.min(Number(req.body?.party_size) || 2, 12)),
        budget_amount: budget,
        currency: cleanString(req.body?.currency, 3) || req.user.currency || 'CAD',
        payment_split: split,
        deposit_amount: depositAmount,
        cancellation_window_hours: cancellationWindowHours,
        attendance_score_required: attendanceScoreRequired,
        host_note: cleanString(req.body?.host_note, 1500),
        menu_intent: cleanJsonList(req.body?.menu_intent, 20, 500),
        add_ons: normalizedAddOns,
        includes_ride: Boolean(req.body?.includes_ride) || normalizedAddOns.some((item) => item.id === 'ride'),
        includes_flowers: Boolean(req.body?.includes_flowers) || normalizedAddOns.some((item) => item.id === 'flowers'),
        safety_rules: Array.isArray(req.body?.safety_rules) ? req.body.safety_rules : null,
        lat,
        lng,
      },
      include: planInclude(),
    });
    return res.status(201).json({ successful: true, data: serializePlan(plan, userId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/publish', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const plan = await prisma.dating_date_plan.findFirst({ where: { dating_date_plan_id: id, organizer_id: req.user.user_id } });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (!PLAN_STATUSES.has(plan.status) || plan.status === 'cancelled') return res.status(409).json({ successful: false, message: 'Date plan cannot be published' });
    const marketplaceSelections = await worthItMarketplaceSelections(plan.add_ons);
    const normalizedAddOns = normalizeWorthItAddOns(plan.add_ons, plan, { marketplaceSelections });
    const missingMarketplace = requireWorthItMarketplaceSelections(normalizedAddOns, marketplaceSelections);
    if (missingMarketplace) return res.status(400).json({ successful: false, message: missingMarketplace });
    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: id },
      data: {
        status: 'published',
        visibility: 'public',
        add_ons: normalizedAddOns,
        includes_ride: normalizedAddOns.some((item) => item.id === 'ride'),
        includes_flowers: normalizedAddOns.some((item) => item.id === 'flowers'),
      },
      include: planInclude(),
    });
    return res.json({ successful: true, data: serializePlan(updated, req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const plan = await prisma.dating_date_plan.findFirst({ where: { dating_date_plan_id: id, organizer_id: req.user.user_id } });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (plan.status === 'cancelled' || plan.status === 'completed') {
      return res.status(409).json({ successful: false, message: 'Date plan cannot be changed' });
    }
    const nextDate = req.body?.date == null ? plan.date : parsePlanDate(req.body.date);
    const nextTime = req.body?.time == null ? plan.time : validTime(req.body.time);
    if (!nextDate || !nextTime) return res.status(400).json({ successful: false, message: 'Valid date and time are required' });
    const nextSplit = req.body?.payment_split == null
      ? plan.payment_split
      : PAYMENT_SPLITS.has(String(req.body.payment_split))
        ? String(req.body.payment_split)
        : null;
    if (!nextSplit) return res.status(400).json({ successful: false, message: 'Invalid payment split' });
    const updateDraft = {
      ...plan,
      date: nextDate,
      time: nextTime,
      payment_split: nextSplit,
      restaurant_name: cleanString(req.body?.restaurant_name, 180) || plan.restaurant_name,
      restaurant_address: cleanString(req.body?.restaurant_address, 2000) || plan.restaurant_address,
    };
    const rawAddOns = req.body?.add_ons == null ? plan.add_ons : req.body.add_ons;
    const marketplaceSelections = await worthItMarketplaceSelections(rawAddOns);
    const normalizedAddOns = normalizeWorthItAddOns(rawAddOns, updateDraft, {
      confirmed: plan.status === 'confirmed',
      marketplaceSelections,
    });
    const missingMarketplace = requireWorthItMarketplaceSelections(normalizedAddOns, marketplaceSelections);
    if (missingMarketplace) return res.status(400).json({ successful: false, message: missingMarketplace });
    const data = {
      date: nextDate,
      time: nextTime,
      payment_split: nextSplit,
      restaurant_name: updateDraft.restaurant_name,
      restaurant_address: updateDraft.restaurant_address,
      add_ons: normalizedAddOns,
      includes_ride: normalizedAddOns.some((item) => item.id === 'ride'),
      includes_flowers: normalizedAddOns.some((item) => item.id === 'flowers'),
    };
    if (req.body?.budget_amount != null) {
      const budget = cleanMoney(req.body.budget_amount);
      if (budget == null || budget <= 0) return res.status(400).json({ successful: false, message: 'Invalid budget amount' });
      data.budget_amount = budget;
    }
    if (req.body?.deposit_amount != null) data.deposit_amount = cleanMoney(req.body.deposit_amount);
    if (req.body?.cancellation_window_hours != null) data.cancellation_window_hours = clampInt(req.body.cancellation_window_hours, 24, 1, 168);
    if (req.body?.attendance_score_required != null) data.attendance_score_required = cleanPercent(req.body.attendance_score_required, 80);
    if (req.body?.host_note != null) data.host_note = cleanString(req.body.host_note, 1500);
    if (req.body?.menu_intent != null) data.menu_intent = cleanJsonList(req.body.menu_intent, 20, 500);
    const updated = await prisma.dating_date_plan.update({ where: { dating_date_plan_id: id }, data, include: planInclude() });
    return res.json({ successful: true, data: serializePlan(updated, req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/cancel', async (req, res, next) => {
  try {
    const io = req.app.get('io');
    const id = asInt(req.params.id);
    const plan = await prisma.dating_date_plan.findFirst({ where: { dating_date_plan_id: id, organizer_id: req.user.user_id } });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (plan.ride_request_id) {
      const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: plan.ride_request_id } });
      const cancelErr = assertCanCancelRide(ride);
      if (cancelErr) {
        return res.status(cancelErr.status).json({ successful: false, message: cancelErr.message });
      }
      await cancelRideRequest(
        io,
        ride.ride_request_id,
        ride.passenger_id,
        'dating_date_cancelled',
      );
    }
    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: id },
      data: { status: 'cancelled', add_ons: cancelWorthItAddOns(plan.add_ons, plan) },
      include: planInclude(),
    });
    return res.json({ successful: true, data: serializePlan(updated, req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

router.post('/worth-it/plans/:id/interest', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const userId = req.user.user_id;
    const plan = await prisma.dating_date_plan.findFirst({ where: { dating_date_plan_id: id, status: 'published', visibility: 'public' } });
    if (!plan || plan.organizer_id === userId) return res.status(404).json({ successful: false, message: 'Date plan not available' });
    if (await isDatingBlockedBetween(userId, plan.organizer_id)) {
      return res.status(404).json({ successful: false, message: 'Date plan not available' });
    }
    const attendanceScore = await datingAttendanceScore(userId);
    if (plan.attendance_score_required != null && attendanceScore < plan.attendance_score_required) {
      return res.status(403).json({ successful: false, message: 'Your attendance score does not meet this date plan requirement' });
    }
    const interest = await prisma.dating_date_interest.upsert({
      where: { dating_date_plan_id_user_id: { dating_date_plan_id: id, user_id: userId } },
      update: {
        status: 'interested',
        message: cleanString(req.body?.message, 1200),
        selected_menu: cleanJsonList(req.body?.selected_menu || req.body?.menu_preferences, 20, 500),
        budget_amount: cleanMoney(req.body?.budget_amount),
      },
      create: {
        dating_date_plan_id: id,
        user_id: userId,
        message: cleanString(req.body?.message, 1200),
        selected_menu: cleanJsonList(req.body?.selected_menu || req.body?.menu_preferences, 20, 500),
        budget_amount: cleanMoney(req.body?.budget_amount),
      },
    });
    notifyDating(req, {
      userId: plan.organizer_id,
      type: 'dating.worth_it.interest',
      title: 'Someone is interested in your date plan',
      body: 'Review their interest and confirm if you want to go together.',
      entityType: 'dating_date_plan',
      entityId: id,
      urgency: 'actionable',
    });
    return res.status(201).json({ successful: true, data: interest });
  } catch (err) {
    next(err);
  }
});

router.post('/worth-it/plans/:id/invite', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const recipientId = asInt(req.body?.recipient_user_id);
    const senderId = req.user.user_id;
    if (!recipientId || recipientId === senderId) return res.status(400).json({ successful: false, message: 'Invalid invite recipient' });
    const plan = await prisma.dating_date_plan.findFirst({ where: { dating_date_plan_id: id, organizer_id: senderId } });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (plan.status !== 'published') return res.status(409).json({ successful: false, message: 'Publish the date plan before sending invites' });
    if (await isDatingBlockedBetween(senderId, recipientId)) {
      return res.status(404).json({ successful: false, message: 'Recipient is not available for Dating' });
    }
    const targetProfile = await prisma.dating_profile.findUnique({
      where: { user_id: recipientId },
      include: { user: { select: { user_id: true } } },
    });
    if (!targetProfile || !assertAdult(targetProfile)) {
      return res.status(404).json({ successful: false, message: 'Recipient is not available for Dating' });
    }
    const invite = await prisma.dating_date_invite.upsert({
      where: { dating_date_plan_id_recipient_id: { dating_date_plan_id: id, recipient_id: recipientId } },
      update: { status: 'sent', note: cleanString(req.body?.note, 1200), responded_at: null },
      create: { dating_date_plan_id: id, sender_id: senderId, recipient_id: recipientId, note: cleanString(req.body?.note, 1200) },
    });
    notifyDating(req, {
      userId: recipientId,
      type: 'dating.worth_it.invite',
      title: 'You were invited to a Worth It date',
      body: plan.restaurant_name,
      entityType: 'dating_date_plan',
      entityId: id,
      urgency: 'actionable',
    });
    emitUserMail({
      userId: recipientId,
      templateName: 'dating-worth-it-invite',
      subjectKey: 'emails.dating_worth_it_invite.subject',
      variables: {
        restaurant_name: plan.restaurant_name || null,
        cta_url: `${appPublicBase()}/dating`,
      },
    }).catch(() => {});
    return res.status(201).json({ successful: true, data: invite });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/interests/:id/confirm', async (req, res, next) => {
  try {
    const interestId = asInt(req.params.id);
    const interest = await prisma.dating_date_interest.findUnique({ where: { dating_date_interest_id: interestId }, include: { plan: true } });
    if (!interest || interest.plan.organizer_id !== req.user.user_id) return res.status(404).json({ successful: false, message: 'Interest not found' });
    if (interest.plan.status === 'cancelled') return res.status(409).json({ successful: false, message: 'Date plan is cancelled' });
    if (interest.plan.status === 'confirmed' && interest.plan.confirmed_guest_id && interest.plan.confirmed_guest_id !== interest.user_id) {
      return res.status(409).json({ successful: false, message: 'This date already has a confirmed guest' });
    }
    if (interest.status !== 'interested' && interest.status !== 'confirmed') {
      return res.status(409).json({ successful: false, message: 'Only active interests can be confirmed' });
    }
    const marketplaceSelections = await worthItMarketplaceSelections(interest.plan.add_ons);
    const confirmedAddOns = normalizeWorthItAddOns(interest.plan.add_ons, interest.plan, { confirmed: true, marketplaceSelections });
    const missingMarketplace = requireWorthItMarketplaceSelections(confirmedAddOns, marketplaceSelections);
    if (missingMarketplace) return res.status(400).json({ successful: false, message: missingMarketplace });
    await prisma.$transaction(async (tx) => {
      await tx.dating_date_interest.updateMany({ where: { dating_date_plan_id: interest.plan.dating_date_plan_id, dating_date_interest_id: { not: interestId }, status: 'interested' }, data: { status: 'not_selected' } });
      await tx.dating_date_interest.update({ where: { dating_date_interest_id: interestId }, data: { status: 'confirmed' } });
      await tx.dating_date_plan.update({
        where: { dating_date_plan_id: interest.plan.dating_date_plan_id },
        data: {
          status: 'confirmed',
          accepted_interest_id: interestId,
          confirmed_guest_id: interest.user_id,
          add_ons: confirmedAddOns,
        },
      });
    });
    notifyDating(req, {
      userId: interest.user_id,
      type: 'dating.worth_it.confirmed',
      title: 'Your Worth It date was confirmed',
      body: 'The organizer confirmed you for the date plan.',
      entityType: 'dating_date_plan',
      entityId: interest.plan.dating_date_plan_id,
      urgency: 'actionable',
    });
    const updated = await prisma.dating_date_plan.findUnique({ where: { dating_date_plan_id: interest.plan.dating_date_plan_id }, include: planInclude() });
    return res.json({ successful: true, data: serializePlan(updated, req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/add-on-preferences', async (req, res, next) => {
  try {
    const planId = asInt(req.params.id);
    const userId = req.user.user_id;
    const plan = await prisma.dating_date_plan.findUnique({
      where: { dating_date_plan_id: planId },
      include: planInclude(),
    });
    if (!plan || plan.confirmed_guest_id !== userId) {
      return res.status(404).json({ successful: false, message: 'Date plan not found' });
    }
    if (plan.status !== 'confirmed') {
      return res.status(409).json({ successful: false, message: 'Add-on preferences unlock after guest confirmation' });
    }
    const normalizedAddOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: true });
    const preferenceRows = cleanJsonList(req.body?.preferences || req.body?.add_on_preferences || [], 12, 500);
    const scheduledIds = new Set(normalizedAddOns
      .filter((item) => item?.type === 'scheduled_date_add_on')
      .map((item) => item.id));
    if (!scheduledIds.size) {
      return res.status(409).json({ successful: false, message: 'This date plan has no add-ons to approve' });
    }
    const invalidPreference = preferenceRows.find((row) => {
      const id = cleanString(row?.id || row?.type, 80)?.toLowerCase().replace(/\s+/g, '_');
      return !id || !scheduledIds.has(id);
    });
    if (invalidPreference) {
      return res.status(400).json({ successful: false, message: 'Add-on preferences must reference confirmed date add-ons' });
    }
    const nextAddOns = applyWorthItGuestPreferences(
      normalizedAddOns,
      preferenceRows,
      userId,
    );
    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: planId },
      data: { add_ons: nextAddOns },
      include: planInclude(),
    });
    notifyDating(req, {
      userId: plan.organizer_id,
      type: 'dating.worth_it.add_on_preferences',
      title: 'Guest updated add-on preferences',
      body: 'Your confirmed guest added preferences for the date add-ons.',
      entityType: 'dating_date_plan',
      entityId: planId,
      urgency: 'ambient',
    });
    return res.json({ successful: true, data: serializePlan(updated, userId) });
  } catch (err) {
    next(err);
  }
});

router.post('/worth-it/plans/:id/ride-link', async (req, res, next) => {
  try {
    const planId = asInt(req.params.id);
    const rideRequestId = asInt(req.body?.ride_request_id);
    const userId = req.user.user_id;
    const shareStatusWithOrganizer = req.body?.share_status_with_organizer === true;
    if (!planId || !rideRequestId) {
      return res.status(400).json({ successful: false, message: 'A confirmed date plan and ride request are required' });
    }

    const plan = await prisma.dating_date_plan.findUnique({
      where: { dating_date_plan_id: planId },
      include: planInclude(),
    });
    if (!plan || (plan.organizer_id !== userId && plan.confirmed_guest_id !== userId)) {
      return res.status(404).json({ successful: false, message: 'Date plan not found' });
    }
    if (!plan.includes_ride) {
      return res.status(409).json({ successful: false, message: 'This date plan does not include a ride' });
    }
    if (plan.status !== 'confirmed' || !plan.confirmed_guest_id) {
      return res.status(409).json({ successful: false, message: 'Confirm a guest before arranging the ride' });
    }
    if (userId !== plan.confirmed_guest_id) {
      return res.status(403).json({ successful: false, message: 'Only the confirmed guest can add pickup details' });
    }
    if (plan.ride_request_id && plan.ride_request_id !== rideRequestId) {
      return res.status(409).json({ successful: false, message: 'A ride is already linked to this date plan' });
    }

    const ride = await prisma.ride_request.findFirst({
      where: { ride_request_id: rideRequestId, passenger_id: userId },
      select: {
        ride_request_id: true,
        passenger_id: true,
        pickup_address: true,
        drop_address: true,
        drop_lat: true,
        drop_long: true,
        scheduled_at: true,
        status: true,
      },
    });
    if (!ride) return res.status(404).json({ successful: false, message: 'Ride request not found' });
    if (!['scheduled', 'pending', 'accepted'].includes(String(ride.status || '').toLowerCase())) {
      return res.status(409).json({ successful: false, message: 'Ride request is not available for this date plan' });
    }
    if (!ride.pickup_address || !ride.drop_address) {
      return res.status(400).json({ successful: false, message: 'Ride pickup and dropoff are required' });
    }
    if (!ride.scheduled_at || new Date(ride.scheduled_at).getTime() <= Date.now()) {
      return res.status(400).json({ successful: false, message: 'Worth It rides must be scheduled for the date plan' });
    }
    const planVenueDistanceKm = distanceKm(plan.lat, plan.lng, ride.drop_lat, ride.drop_long);
    if (plan.lat != null && plan.lng != null && planVenueDistanceKm != null && planVenueDistanceKm > 0.5) {
      return res.status(400).json({ successful: false, message: 'Ride dropoff must match the confirmed date venue' });
    }
    const expectedDrop = comparableAddress(plan.restaurant_address || plan.vendor?.location || plan.restaurant_name);
    const rideDrop = comparableAddress(ride.drop_address);
    if (planVenueDistanceKm == null && expectedDrop && rideDrop && expectedDrop !== rideDrop) {
      return res.status(400).json({ successful: false, message: 'Ride dropoff must match the confirmed date venue' });
    }
    const expectedPickup = worthItPickupTime(plan);
    const ridePickupTime = new Date(ride.scheduled_at);
    if (!expectedPickup || Number.isNaN(ridePickupTime.getTime())) {
      return res.status(400).json({ successful: false, message: 'Date plan needs a valid reservation time before linking a ride' });
    }
    const driftMs = Math.abs(ridePickupTime.getTime() - expectedPickup.getTime());
    if (driftMs > 12 * 60 * 60 * 1000) {
      return res.status(400).json({ successful: false, message: 'Ride pickup time must stay near the date reservation window' });
    }

    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: planId },
      data: {
        ride_request_id: rideRequestId,
        add_ons: withWorthItRidePrivacy(plan.add_ons, {
          share_status_with_organizer: shareStatusWithOrganizer,
          ride_request_id: rideRequestId,
        }),
      },
      include: planInclude(),
    });
    notifyDating(req, {
      userId: plan.organizer_id,
      type: 'dating.worth_it.ride_linked',
      title: 'Ride added to your Worth It date',
      body: 'The confirmed guest added private pickup details for the scheduled ride.',
      entityType: 'dating_date_plan',
      entityId: planId,
      urgency: 'ambient',
    });
    return res.json({ successful: true, data: serializePlan(updated, userId, new Map([[ride.ride_request_id, ride]])) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/invites/:id/respond', async (req, res, next) => {
  try {
    const inviteId = asInt(req.params.id);
    const response = String(req.body?.status || '').toLowerCase();
    if (!INVITE_RESPONSES.has(response)) return res.status(400).json({ successful: false, message: 'Invalid invite response' });
    const invite = await prisma.dating_date_invite.findFirst({ where: { dating_date_invite_id: inviteId, recipient_id: req.user.user_id }, include: { plan: true } });
    if (!invite) return res.status(404).json({ successful: false, message: 'Invite not found' });
    if (invite.plan.status !== 'published') return res.status(409).json({ successful: false, message: 'This date invite is no longer active' });
    const updated = await prisma.dating_date_invite.update({ where: { dating_date_invite_id: inviteId }, data: { status: response, responded_at: new Date() } });
    if (response === 'accepted') {
      await prisma.dating_date_interest.upsert({
        where: { dating_date_plan_id_user_id: { dating_date_plan_id: invite.dating_date_plan_id, user_id: req.user.user_id } },
        update: { status: 'interested', message: cleanString(req.body?.message, 1200), selected_menu: cleanJsonList(req.body?.selected_menu || req.body?.menu_preferences, 20, 500) },
        create: { dating_date_plan_id: invite.dating_date_plan_id, user_id: req.user.user_id, message: cleanString(req.body?.message, 1200), selected_menu: cleanJsonList(req.body?.selected_menu || req.body?.menu_preferences, 20, 500) },
      });
    }
    notifyDating(req, {
      userId: invite.sender_id,
      type: `dating.worth_it.invite_${response}`,
      title: response === 'accepted' ? 'Date invite accepted' : 'Date invite declined',
      body: invite.plan.restaurant_name,
      entityType: 'dating_date_plan',
      entityId: invite.dating_date_plan_id,
      urgency: response === 'accepted' ? 'actionable' : 'ambient',
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.get('/worth-it/vendor/add-ons', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const plans = await prisma.dating_date_plan.findMany({
      where: { status: { in: ['confirmed', 'completed'] } },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: 80,
      include: planInclude(),
    });
    const rows = [];
    for (const plan of plans) {
      if (!isVisibleDatePlan(plan)) continue;
      const addOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: plan.status === 'confirmed' });
      for (const addOn of addOns) {
        if (addOn?.type !== 'scheduled_date_add_on') continue;
        const ownerId = await worthItMarketplaceOwnerId(addOn);
        if (ownerId !== userId) continue;
        rows.push({
          plan: serializePlan(plan, userId),
          add_on: addOn,
        });
      }
    }
    return res.json({ successful: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/worth-it/plans/:id/add-ons/:addOnId/payment-intent', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ successful: false, message: 'Payment authorization is not configured' });
    const planId = asInt(req.params.id);
    const userId = req.user.user_id;
    const plan = await prisma.dating_date_plan.findUnique({ where: { dating_date_plan_id: planId }, include: planInclude() });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    assertWorthItParticipant(plan, userId);
    if (plan.status !== 'confirmed') return res.status(409).json({ successful: false, message: 'Payment unlocks after guest confirmation' });

    const addOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: true });
    const addOn = findWorthItAddOn(addOns, req.params.addOnId);
    if (!addOn) return res.status(404).json({ successful: false, message: 'Add-on not found' });
    if (['cancelled', 'delivered'].includes(addOn.status)) return res.status(409).json({ successful: false, message: 'Add-on is not payable' });

    const share = worthItRequiredPaymentForUser(addOn, plan, userId);
    if (!share) return res.status(403).json({ successful: false, message: 'You are not responsible for this add-on payment' });

    const currency = cleanString(plan.currency, 3)?.toLowerCase() || 'cad';
    const existing = worthItPaymentAuthorizations(addOn).find((auth) => (
      auth.payer_user_id === userId
      && auth.amount_cents === share.amount_cents
      && ['requires_confirmation', 'authorized', 'captured'].includes(auth.status)
    ));
    if (existing) {
      const intent = await stripe.paymentIntents.retrieve(existing.payment_intent_id);
      return res.json({
        successful: true,
        data: {
          payment_intent_id: intent.id,
          client_secret: intent.client_secret,
          amount_cents: existing.amount_cents,
          currency: existing.currency || currency,
          status: existing.status,
        },
      });
    }

    const intent = await stripe.paymentIntents.create({
      amount: share.amount_cents,
      currency,
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true },
      metadata: {
        feature: 'dating_worth_it_add_on',
        dating_date_plan_id: String(planId),
        add_on_id: addOn.id,
        payer_user_id: String(userId),
      },
    });
    const now = new Date().toISOString();
    const nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => {
      const auths = [
        ...worthItPaymentAuthorizations(item),
        {
          payment_intent_id: intent.id,
          payer_user_id: userId,
          amount_cents: share.amount_cents,
          currency,
          status: 'requires_confirmation',
          authorized_at: null,
          captured_at: null,
          cancelled_at: null,
          created_at: now,
        },
      ];
      const next = {
        ...item,
        payment_authorizations: auths,
      };
      return { ...next, payment_status: worthItPaymentState(next, plan) };
    });
    await prisma.dating_date_plan.update({ where: { dating_date_plan_id: planId }, data: { add_ons: nextAddOns } });

    return res.json({
      successful: true,
      data: {
        payment_intent_id: intent.id,
        client_secret: intent.client_secret,
        amount_cents: share.amount_cents,
        currency,
        status: 'requires_confirmation',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/add-ons/:addOnId/payment-confirm', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ successful: false, message: 'Payment authorization is not configured' });
    const planId = asInt(req.params.id);
    const userId = req.user.user_id;
    const paymentIntentId = cleanString(req.body?.payment_intent_id, 120);
    if (!paymentIntentId) return res.status(400).json({ successful: false, message: 'Payment intent is required' });
    const plan = await prisma.dating_date_plan.findUnique({ where: { dating_date_plan_id: planId }, include: planInclude() });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    assertWorthItParticipant(plan, userId);

    const addOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: true });
    const addOn = findWorthItAddOn(addOns, req.params.addOnId);
    if (!addOn) return res.status(404).json({ successful: false, message: 'Add-on not found' });
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (
      intent.metadata?.feature !== 'dating_worth_it_add_on'
      || intent.metadata?.dating_date_plan_id !== String(planId)
      || intent.metadata?.add_on_id !== addOn.id
      || intent.metadata?.payer_user_id !== String(userId)
    ) {
      return res.status(400).json({ successful: false, message: 'Payment intent does not match this add-on' });
    }
    if (!['requires_capture', 'succeeded'].includes(intent.status)) {
      return res.status(409).json({ successful: false, message: 'Payment has not been authorized yet' });
    }
    const now = new Date().toISOString();
    const nextStatus = intent.status === 'requires_capture' ? 'authorized' : intent.status === 'succeeded' ? 'captured' : intent.status;
    const nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => {
      const auths = worthItPaymentAuthorizations(item).map((auth) => auth.payment_intent_id === paymentIntentId
        ? {
            ...auth,
            status: nextStatus,
            authorized_at: nextStatus === 'authorized' ? (auth.authorized_at || now) : auth.authorized_at,
            captured_at: nextStatus === 'captured' ? (auth.captured_at || now) : auth.captured_at,
          }
        : auth);
      const next = {
        ...item,
        payment_authorizations: auths,
        payment_authorized_at: nextStatus === 'authorized' ? (item.payment_authorized_at || now) : item.payment_authorized_at,
        payment_captured_at: nextStatus === 'captured' ? (item.payment_captured_at || now) : item.payment_captured_at,
      };
      return { ...next, payment_status: worthItPaymentState(next, plan) };
    });
    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: planId },
      data: { add_ons: nextAddOns },
      include: planInclude(),
    });
    return res.json({ successful: true, data: serializePlan(updated, userId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/add-ons/:addOnId/vendor-response', async (req, res, next) => {
  try {
    const planId = asInt(req.params.id);
    const userId = req.user.user_id;
    const action = cleanString(req.body?.action, 40)?.toLowerCase();
    if (!['accept', 'reject', 'replacement', 'preparing', 'out_for_delivery'].includes(action)) {
      return res.status(400).json({ successful: false, message: 'Valid vendor action is required' });
    }
    const plan = await prisma.dating_date_plan.findUnique({ where: { dating_date_plan_id: planId }, include: planInclude() });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (plan.status !== 'confirmed') return res.status(409).json({ successful: false, message: 'Vendor fulfillment unlocks after guest confirmation' });
    const addOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: true });
    const addOn = findWorthItAddOn(addOns, req.params.addOnId);
    if (!addOn) return res.status(404).json({ successful: false, message: 'Add-on not found' });
    await assertWorthItVendorOwner(addOn, userId);
    if (addOn.status === 'cancelled' || addOn.status === 'delivered') {
      return res.status(409).json({ successful: false, message: 'Add-on is not available for vendor updates' });
    }

    const now = new Date().toISOString();
    let nextAddOns = addOns;
    let notifyTitle = 'Worth It add-on updated';
    if (action === 'accept') {
      if (addOn.guest_preference_status !== 'approved') {
        return res.status(409).json({ successful: false, message: 'Guest add-on preferences must be approved before vendor acceptance' });
      }
      const paymentStatus = worthItPaymentState(addOn, plan);
      if (!['authorized', 'captured', 'authorization_not_required'].includes(paymentStatus)) {
        return res.status(409).json({ successful: false, message: 'Payment authorization is required before vendor acceptance' });
      }
      const capturedAuths = paymentStatus === 'authorization_not_required' ? worthItPaymentAuthorizations(addOn) : await captureWorthItAuthorizations(addOn);
      nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, 'confirmed', {
        status: 'confirmed',
        vendor_status: 'accepted',
        vendor_response: { action, note: cleanString(req.body?.note, 800), at: now, by_user_id: userId },
        vendor_accepted_at: now,
        payment_authorizations: capturedAuths,
        payment_status: capturedAuths.length ? 'captured' : 'authorization_not_required',
        payment_captured_at: capturedAuths.length ? now : item.payment_captured_at,
      }));
      notifyTitle = 'Vendor accepted a date add-on';
    } else if (action === 'reject') {
      const fallback = await findWorthItFallbackVendor(addOn);
      if (fallback) {
        nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, 'scheduled', {
          status: 'scheduled',
          vendor_status: 'fallback_pending_vendor_acceptance',
          vendor_response: { action, note: cleanString(req.body?.note, 800), at: now, by_user_id: userId },
          vendor_declined_at: now,
          fallback_history: [
            ...cleanJsonList(item.fallback_history, 12, 500),
            {
              at: now,
              declined_vendor_name: item.vendor_name,
              marketplace_source: item.marketplace_source,
              marketplace_ref_id: item.marketplace_ref_id,
              reason: cleanString(req.body?.note, 800),
            },
          ],
          marketplace_source: fallback.source,
          marketplace_ref_id: fallback.ref_id,
          vendor_owner_id: fallback.owner_id,
          vendor_name: fallback.name,
          vendor_type: fallback.type,
          vendor_image_url: fallback.image_url,
        }));
        notifyTitle = 'Fallback provider selected for date add-on';
      } else {
        const cancelledAuths = await cancelWorthItAuthorizations(addOn);
        nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, 'cancelled', {
          status: 'cancelled',
          vendor_status: 'rejected_no_fallback',
          vendor_response: { action, note: cleanString(req.body?.note, 800), at: now, by_user_id: userId },
          vendor_declined_at: now,
          payment_authorizations: cancelledAuths,
          payment_status: cancelledAuths.length ? 'authorization_cancelled' : item.payment_status,
        }));
        notifyTitle = 'Date add-on was cancelled';
      }
    } else if (action === 'replacement') {
      nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, 'replacement_suggested', {
        status: 'replacement_suggested',
        vendor_status: 'replacement_suggested',
        vendor_response: { action, note: cleanString(req.body?.note, 800), at: now, by_user_id: userId },
        replacement_suggestion: {
          title: cleanString(req.body?.replacement_title, 160),
          note: cleanString(req.body?.note, 1000),
          price: cleanMoney(req.body?.replacement_price),
          suggested_at: now,
          by_user_id: userId,
        },
      }));
      notifyTitle = 'Vendor suggested an add-on replacement';
    } else {
      if (!['confirmed', 'preparing', 'out_for_delivery'].includes(addOn.status)) {
        return res.status(409).json({ successful: false, message: 'Vendor must accept before fulfillment updates' });
      }
      nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, action, {
        status: action,
        vendor_status: action,
        vendor_response: { action, note: cleanString(req.body?.note, 800), at: now, by_user_id: userId },
      }));
      notifyTitle = action === 'preparing' ? 'Date add-on is being prepared' : 'Date add-on is out for delivery';
    }

    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: planId },
      data: { add_ons: nextAddOns },
      include: planInclude(),
    });
    worthItNotifyParticipants(req, plan, {
      type: 'dating.worth_it.add_on_vendor',
      title: notifyTitle,
      body: addOn.label || addOn.id,
      entityType: 'dating_date_plan',
      entityId: planId,
      urgency: 'ambient',
    }, userId);
    return res.json({ successful: true, data: serializePlan(updated, userId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/worth-it/plans/:id/add-ons/:addOnId/delivery-proof', async (req, res, next) => {
  try {
    const planId = asInt(req.params.id);
    const userId = req.user.user_id;
    const proofUrl = cleanString(req.body?.proof_url || req.body?.photo_url, 2000);
    const signatureName = cleanString(req.body?.signature_name, 160);
    const note = cleanString(req.body?.note, 1000);
    if (!proofUrl && !signatureName && !note) {
      return res.status(400).json({ successful: false, message: 'Photo, signature, or delivery note is required' });
    }
    const plan = await prisma.dating_date_plan.findUnique({ where: { dating_date_plan_id: planId }, include: planInclude() });
    if (!plan) return res.status(404).json({ successful: false, message: 'Date plan not found' });
    if (plan.status !== 'confirmed') {
      return res.status(409).json({ successful: false, message: 'Delivery proof can be added only for confirmed date plans' });
    }
    const addOns = normalizeWorthItAddOns(plan.add_ons, plan, { confirmed: true });
    const addOn = findWorthItAddOn(addOns, req.params.addOnId);
    if (!addOn) return res.status(404).json({ successful: false, message: 'Add-on not found' });
    await assertWorthItVendorOwner(addOn, userId);
    if (!['confirmed', 'preparing', 'out_for_delivery'].includes(addOn.status)) {
      return res.status(409).json({ successful: false, message: 'Delivery proof can be added after vendor acceptance' });
    }
    const now = new Date().toISOString();
    const nextAddOns = replaceWorthItAddOn(addOns, addOn.id, (item) => worthItScheduledOrderStatus(item, plan, 'delivered', {
      status: 'delivered',
      vendor_status: 'delivered',
      delivery_proof: {
        proof_url: proofUrl,
        signature_name: signatureName,
        note,
        submitted_at: now,
        submitted_by_user_id: userId,
      },
    }));
    const updated = await prisma.dating_date_plan.update({
      where: { dating_date_plan_id: planId },
      data: { add_ons: nextAddOns },
      include: planInclude(),
    });
    worthItNotifyParticipants(req, plan, {
      type: 'dating.worth_it.add_on_delivered',
      title: 'Date add-on delivered',
      body: addOn.label || addOn.id,
      entityType: 'dating_date_plan',
      entityId: planId,
      urgency: 'ambient',
    }, userId);
    return res.json({ successful: true, data: serializePlan(updated, userId) });
  } catch (err) {
    next(err);
  }
});

router.get('/safety/history', async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const reports = await prisma.dating_report.findMany({
      where: {
        OR: [{ reporter_id: userId }, { reported_user_id: userId }],
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    const safeReports = reports.map((report) => serializeSafetyReport(report, userId));
    const noShowCount = safeReports.filter((report) => /no[-\s]?show/i.test(`${report.reason || ''} ${report.details || ''}`)).length;
    return res.json({
      successful: true,
      data: {
        reports: safeReports,
        report_count: reports.length,
        no_show_count: noShowCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/report', async (req, res, next) => {
  try {
    const reason = cleanString(req.body?.reason, 80);
    if (!reason) return res.status(400).json({ successful: false, message: 'Reason is required' });
    const entityType = cleanString(req.body?.entity_type, 40);
    const entityId = asInt(req.body?.entity_id);
    const report = await prisma.dating_report.create({
      data: {
        reporter_id: req.user.user_id,
        reported_user_id: asInt(req.body?.reported_user_id),
        entity_type: entityType,
        entity_id: entityId,
        reason,
        details: cleanString(req.body?.details, 2000),
      },
    });
    if (entityType === 'dating_date_plan' && entityId) {
      const plan = await prisma.dating_date_plan.findFirst({
        where: {
          dating_date_plan_id: entityId,
          OR: [
            { organizer_id: req.user.user_id },
            { confirmed_guest_id: req.user.user_id },
            { interests: { some: { user_id: req.user.user_id } } },
            { invites: { some: { recipient_id: req.user.user_id } } },
          ],
        },
      });
      if (plan) {
        await prisma.dating_date_plan.update({
          where: { dating_date_plan_id: plan.dating_date_plan_id },
          data: { add_ons: pauseWorthItAddOnsForSafety(plan.add_ons, plan, report) },
        });
        if (plan.ride_request_id) {
          const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: plan.ride_request_id } });
          const cancelErr = assertCanCancelRide(ride);
          if (!cancelErr) {
            await cancelRideRequest(
              req.app.get('io'),
              ride.ride_request_id,
              ride.passenger_id,
              'dating_safety_reported',
            ).catch(() => null);
          }
        }
      }
    }
    return res.status(201).json({ successful: true, data: report });
  } catch (err) {
    next(err);
  }
});

export default router;
