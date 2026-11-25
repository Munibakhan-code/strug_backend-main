import express from 'express';
import multer from 'multer';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import axios from 'axios';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { notify } from '../services/notify.js';
import { isFoodVendor } from '../middleware/food-vendor-check.js';
import { uploadVideoStream } from '../utils/azure-storage.js';
import { getDistanceMatrix, geocodeAddress } from '../utils/google-maps.js';
import { computeCustomerSegments } from '../utils/customer-analytics.js';
import { getRegionData, PLATFORM_FEE_PERCENTAGE } from '../utils/tax-config.js';
import {
  assignDeliveryOrderToDriver,
  canDriverHandleFoodOrder,
  createDeliveryRunOffer,
  decideDeliveryRunOffer,
  dispatchDeliveryOrder,
  notifyDeliveryOfferClosed,
  refreshFoodDeliveryBatchRoutePlan,
  reofferDeliveryOrderAfterDecline,
  suggestDeliveryRunOffers,
  foodCourierOfferableStatuses,
} from '../utils/delivery-dispatch.js';
import {
  assertFulfillmentLocked,
  resolveFoodCourierDispatchWhere,
  isFoodPickupOrder,
  isReservedPickupSentinel,
  normalizeFulfillmentMode,
  persistDeliverLocation,
  publicDeliverLocation,
  sanitizeDeliverLocationUpdate,
} from '../utils/food-fulfillment.js';
import { resolveDeliveryDriverForUser } from '../utils/driver-identity.js';
import {
  vendorTypeNamesForAlias,
  findVendorTypeIdsByNames,
  resolveRestaurantVendorTypeId,
  restaurantVendorTypeWhere,
  verticalForVendorTypeName,
} from '../utils/vendor-type.js';
import { resolveFoodCartLines, totalFromLines } from '../utils/commerce-pricing.js';
import {
  calculateFoodDeliveryFee,
  parseNonNegativeAmount,
  parseFiniteCoord,
  readNonNegativeEnvNumber,
  resolveFoodDeliveryFee,
  assertFoodDeliveryInRange,
  FOOD_DELIVERY_MAX_KM,
} from '../utils/food-delivery-pricing.js';
import { redeemPromotion, validatePromotionForUser, attachFoodVendorOffers } from '../utils/promotion.js';
import { normalizeReferralCode, settleReferralThenRecruit } from '../utils/referral-settlement.js';
import { creditRecruiterShares } from '../utils/recruiter-share.js';
import { isFoodSettledStatus } from '../utils/food-vendor-net.js';
import { tryCreditSettledFoodOrder, reverseFoodOrderWalletCredit } from '../services/food-payout.js';
import { clearDeliveryLocation } from '../utils/delivery-location.js';
import foodWalletRouter from './food-wallet-routes.js';
import { sendEmail } from '../utils/mailer.js';
import { emailLngFromUser } from '../utils/email-lang.js';
import { decrypt } from "../utils/crypto.js";
import i18next from '../utils/i18n.js';
import mailerEvents from '../utils/mailer-event.js';
import { sendError } from '../utils/api-i18n.js';
import { applyVerticalIdentity, verticalIdentityUserSelect } from '../utils/vertical-identity.js';
import { selectBestAd, trackAdEvent } from '../utils/ads-delivery-engine.js';
import crypto from 'crypto';
import { checkRateLimit } from '../utils/rate-limiter.js';
import { RANGE_DAYS, resolveRangeParam, resolveRange, resolveAnalyticsTimeZone, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
// Bounded list queries — see utils/pagination.js for why every list endpoint needs a cap.
import { paginate, parsePagination, setPaginationHeaders } from '../utils/pagination.js';

let stripeClient;
function getStripe() {
  if (stripeClient !== undefined) return stripeClient;
  stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  return stripeClient;
}

function isFoodAdmin(user) {
  return user?.role === 'ADMIN' || user?.permission === 'admin';
}

const FOOD_VENDOR_STATUS = {
  pending: ['confirmed', 'preparing', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'dispatched', 'cancelled'],
  ready_for_pickup: ['dispatched', 'picked_up'],
  dispatched: ['delivered'],
  picked_up: ['delivered', 'dispatched'],
};
const FOOD_DRIVER_STATUS = {
  ready_for_pickup: ['picked_up', 'dispatched'],
  dispatched: ['delivered', 'picked_up'],
  picked_up: ['delivered', 'delivery_failed'],
  delivery_failed: ['delivered'],
};
const FOOD_CUSTOMER_CANCEL = new Set(['pending', 'confirmed']);
const GROCERY_VENDOR_STATUS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'ready_for_pickup', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: [],
  dispatched: [],
  picked_up: [],
  delivery_failed: [],
};
const GROCERY_CUSTOMER_CANCEL = new Set(['pending']);
const GROCERY_SUBSTITUTION_MODES = new Set(['allow', 'contact_first', 'none']);

/** Grocery/pharmacy/floral use "store" wording; restaurant/catering use "restaurant". */
function merchantKindFromVendorTypeName(vendorTypeName) {
  const name = String(vendorTypeName || '').trim().toLowerCase();
  if (['grocery', 'pharmacy', 'floral', 'flowers', 'liquor'].includes(name)) return 'store';
  return 'restaurant';
}

function isEventCateringType(name) {
  return String(name || '').trim().toLowerCase() === 'catering';
}

const FOOD_CUSTOMER_COPY_RESTAURANT = {
  confirmed:        { title: 'Your order was confirmed',   body: 'The restaurant is preparing it.' },
  preparing:        { title: 'Your order is being prepared', body: null },
  ready_for_pickup: { title: 'Your order is ready',        body: 'Waiting for a driver to collect it.' },
  dispatched:       { title: 'Your order is on the way',   body: null },
  picked_up:        { title: 'Your order is on the way',   body: 'Your driver has collected it.' },
  delivered:        { title: 'Your order was delivered',   body: 'Enjoy!' },
  cancelled:        { title: 'Your order was cancelled',   body: null },
};

const FOOD_CUSTOMER_COPY_STORE = {
  confirmed:        { title: 'Your order was confirmed',   body: 'The store is preparing your items.' },
  preparing:        { title: 'Your order is being prepared', body: null },
  ready_for_pickup: { title: 'Your order is ready',        body: 'Waiting for a courier to collect it.' },
  dispatched:       { title: 'Your order is on the way',   body: null },
  picked_up:        { title: 'Your order is on the way',   body: 'Your courier has collected it.' },
  delivered:        { title: 'Your order was delivered',   body: 'Enjoy your items!' },
  cancelled:        { title: 'Your order was cancelled',   body: null },
};

function getFoodCustomerCopy(status, merchantKind = 'restaurant') {
  const table = merchantKind === 'store' ? FOOD_CUSTOMER_COPY_STORE : FOOD_CUSTOMER_COPY_RESTAURANT;
  return table[status] ?? FOOD_CUSTOMER_COPY_RESTAURANT[status];
}

async function resolveFoodOrderMerchantKind(orderId) {
  if (!orderId) return 'restaurant';
  try {
    const order = await prisma.food_order.findUnique({
      where: { food_order_id: Number(orderId) },
      select: { vendor_type: { select: { vendor_type: true } } },
    });
    return merchantKindFromVendorTypeName(order?.vendor_type?.vendor_type);
  } catch {
    return 'restaurant';
  }
}

/** @deprecated use getFoodCustomerCopy — kept for tests referencing FOOD_CUSTOMER_COPY */
const FOOD_CUSTOMER_COPY = FOOD_CUSTOMER_COPY_RESTAURANT;

function vendorNotifyMeta(vendorTypeName) {
  const vertical = verticalForVendorTypeName(vendorTypeName) || 'food';
  if (vertical === 'catering') {
    return { vertical, title: 'New catering order', actionUrl: 'sd-catering' };
  }
  if (vertical === 'floral') {
    return { vertical, title: 'New floral order', actionUrl: 'sd-flowers' };
  }
  if (vertical === 'grocery') {
    return { vertical, title: 'New grocery order', actionUrl: 'sd-groceries' };
  }
  return { vertical: 'food', title: 'New food order', actionUrl: 'sd-food' };
}

const GROCERY_CUSTOMER_COPY = {
  pending:          { title: 'Order received', body: 'Waiting for the store to accept your grocery order.' },
  confirmed:        { title: 'Your grocery order was accepted', body: 'The store is packing your items.' },
  preparing:        { title: 'Your groceries are being packed', body: null },
  ready_for_pickup: { title: 'Your groceries are ready', body: 'A delivery partner will pick them up from the store.' },
  dispatched:       { title: 'Your grocery delivery is assigned', body: 'Your delivery partner is heading to the store.' },
  picked_up:        { title: 'Your groceries are on the way', body: 'Your delivery partner has collected the order.' },
  delivery_failed:  { title: 'Delivery needs attention', body: 'Your delivery partner reported an issue. We are reviewing the next step.' },
  delivered:        { title: 'Your groceries were delivered', body: 'Delivery complete.' },
  cancelled:        { title: 'Your grocery order was cancelled', body: null },
  substitution_requested: { title: 'Substitution approval needed', body: 'The store suggested a replacement for an unavailable item.' },
};

function parseOptionalStockQty(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    const err = new Error('Stock quantity must be a whole number greater than or equal to 0.');
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

function parseOptionalLowStockThreshold(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    const err = new Error('Low-stock threshold must be a whole number greater than or equal to 0.');
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

function parseOptionalExpiryDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const err = new Error('Expiry date must use YYYY-MM-DD format.');
    err.statusCode = 400;
    throw err;
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    const err = new Error('Expiry date is invalid.');
    err.statusCode = 400;
    throw err;
  }
  return date;
}

function formatCsvDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function csvEscapeCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (quoted) {
    const err = new Error('CSV contains an unterminated quoted cell.');
    err.statusCode = 400;
    throw err;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => String(value || '').trim() !== ''));
}

const INVENTORY_CSV_COLUMNS = [
  'food_item_id',
  'name',
  'description',
  'price',
  'food_category_id',
  'is_available',
  'stock_qty',
  'low_stock_threshold',
  'expiry_date',
  'allergen_info',
  'image_url',
];

function normalizeInventoryCsvBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'available'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'unavailable'].includes(text)) return false;
  const err = new Error('is_available must be true or false.');
  err.statusCode = 400;
  throw err;
}

function inventoryAlertForItem(item) {
  const stock = item?.stock_qty == null ? null : Number(item.stock_qty);
  const threshold = item?.low_stock_threshold == null ? 5 : Number(item.low_stock_threshold);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiringCutoff = new Date(today);
  expiringCutoff.setUTCDate(expiringCutoff.getUTCDate() + 7);
  const expiry = item?.expiry_date ? new Date(item.expiry_date) : null;
  const alerts = [];
  if (Number.isFinite(stock)) {
    if (stock <= 0 || item?.is_available === false) alerts.push('out_of_stock');
    else if (Number.isFinite(threshold) && threshold >= 0 && stock <= threshold) alerts.push('low_stock');
  }
  if (expiry && !Number.isNaN(expiry.getTime())) {
    expiry.setUTCHours(0, 0, 0, 0);
    if (expiry < today) alerts.push('expired');
    else if (expiry <= expiringCutoff) alerts.push('expiring_soon');
  }
  return alerts;
}

function normalizeCatalogText(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ');
}

function catalogTokens(value) {
  return normalizeCatalogText(value).split(' ').filter((token) => token.length >= 2);
}

function extractSizeToken(value) {
  const text = normalizeCatalogText(value);
  return text.match(/\b\d+(?:\.\d+)?\s?(?:g|kg|ml|l|oz|lb|pack|ct|count)\b/)?.[0] || null;
}

function grocerySubstitutionScore(source, candidate) {
  const sourceName = normalizeCatalogText(source?.name);
  const candidateName = normalizeCatalogText(candidate?.name);
  const sourceTokens = new Set(catalogTokens(sourceName));
  const candidateTokens = new Set(catalogTokens(`${candidateName} ${candidate?.description || ''}`));
  const sharedTokens = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
  const sourceBrand = sourceName.split(' ')[0] || '';
  const candidateBrand = candidateName.split(' ')[0] || '';
  const sourceSize = extractSizeToken(`${source?.name || ''} ${source?.description || ''}`);
  const candidateSize = extractSizeToken(`${candidate?.name || ''} ${candidate?.description || ''}`);
  const sourcePrice = Number(source?.price);
  const candidatePrice = Number(candidate?.price);
  const priceDelta = Number.isFinite(sourcePrice) && Number.isFinite(candidatePrice)
    ? candidatePrice - sourcePrice
    : null;
  const priceCloseness = priceDelta == null
    ? 0
    : Math.max(0, 30 - Math.min(30, Math.abs(priceDelta) * 6));
  let score = 0;
  if (source?.food_category_id && candidate?.food_category_id === source.food_category_id) score += 35;
  if (sourceBrand && candidateBrand && sourceBrand === candidateBrand) score += 20;
  if (sourceSize && candidateSize && sourceSize === candidateSize) score += 18;
  score += Math.min(20, sharedTokens * 5);
  score += priceCloseness;
  if (Number(candidate?.stock_qty) > 0) score += 5;
  return {
    score: Math.round(score),
    price_delta: priceDelta == null ? null : Number(priceDelta.toFixed(2)),
    match_reasons: [
      source?.food_category_id && candidate?.food_category_id === source.food_category_id ? 'same_category' : null,
      sourceBrand && candidateBrand && sourceBrand === candidateBrand ? 'similar_brand' : null,
      sourceSize && candidateSize && sourceSize === candidateSize ? 'same_size' : null,
      sharedTokens > 0 ? 'similar_name' : null,
      priceDelta != null ? 'similar_price' : null,
    ].filter(Boolean),
  };
}

const FOOD_DISPUTE_REASONS = new Set(['refund', 'missing_item', 'damaged_order', 'wrong_item', 'quality_issue', 'other']);
const FOOD_DISPUTE_STATUSES = new Set(['open', 'seller_review', 'needs_admin', 'approved', 'rejected', 'resolved', 'cancelled']);

function normalizeFoodDisputeReason(value) {
  const reason = String(value || '').trim().toLowerCase();
  return FOOD_DISPUTE_REASONS.has(reason) ? reason : null;
}

function normalizeFoodDisputeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return FOOD_DISPUTE_STATUSES.has(status) ? status : null;
}

function normalizeDisputeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).map((item) => ({
    food_item_id: Number.isInteger(Number(item?.food_item_id)) ? Number(item.food_item_id) : null,
    name: String(item?.name || item?.item_name || '').trim().slice(0, 160),
    quantity: Number.isFinite(Number(item?.quantity ?? item?.qty)) ? Math.max(0, Number(item.quantity ?? item.qty)) : null,
    issue: String(item?.issue || '').trim().slice(0, 200) || null,
  })).filter((item) => item.name || item.food_item_id);
}

function normalizeDisputeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.slice(0, 12).map((item) => ({
    type: String(item?.type || 'note').trim().slice(0, 40),
    url: item?.url ? String(item.url).trim().slice(0, 1000) : null,
    note: item?.note ? String(item.note).trim().slice(0, 500) : null,
    created_at: item?.created_at || new Date().toISOString(),
  })).filter((item) => item.url || item.note);
}

function parsePositiveIntParam(value, fallback, { min = 1, max = 365 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseClosureDate(value, fieldName) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const err = new Error(`${fieldName} must be a valid date/time.`);
    err.statusCode = 400;
    throw err;
  }
  return date;
}

function normalizeClosurePayload(body = {}) {
  const startsAt = parseClosureDate(body.starts_at, 'starts_at');
  const endsAt = parseClosureDate(body.ends_at, 'ends_at');
  if (endsAt <= startsAt) {
    const err = new Error('Closure end time must be after the start time.');
    err.statusCode = 400;
    throw err;
  }
  const maxMs = 180 * 24 * 60 * 60 * 1000;
  if (endsAt.getTime() - startsAt.getTime() > maxMs) {
    const err = new Error('Closure windows cannot be longer than 180 days.');
    err.statusCode = 400;
    throw err;
  }
  return {
    starts_at: startsAt,
    ends_at: endsAt,
    reason: body.reason ? String(body.reason).trim().slice(0, 255) : null,
  };
}

function normalizeOptionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  const err = new Error(`${fieldName} must be true or false.`);
  err.statusCode = 400;
  throw err;
}

async function findActiveVendorClosure(vendorId, at = new Date(), db = prisma) {
  if (!Number.isInteger(Number(vendorId))) return null;
  return db.food_vendor_closure.findFirst({
    where: {
      vendor_id: Number(vendorId),
      is_active: true,
      starts_at: { lte: at },
      ends_at: { gt: at },
    },
    orderBy: { starts_at: 'asc' },
  });
}

async function findOverlappingVendorClosure(vendorId, startsAt, endsAt, db = prisma) {
  if (!Number.isInteger(Number(vendorId))) return null;
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt || Date.now());
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt || start.getTime() + 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const queryEnd = end > start ? end : new Date(start.getTime() + 15 * 60 * 1000);
  return db.food_vendor_closure.findFirst({
    where: {
      vendor_id: Number(vendorId),
      is_active: true,
      starts_at: { lt: queryEnd },
      ends_at: { gt: start },
    },
    orderBy: { starts_at: 'asc' },
  });
}

function closureConflictPayload(closure) {
  return {
    starts_at: closure.starts_at,
    ends_at: closure.ends_at,
    reason: closure.reason,
  };
}

async function assertInventoryVendorAccess(req, vendorId) {
  if (!Number.isInteger(vendorId)) {
    const err = new Error('Invalid vendor id.');
    err.statusCode = 400;
    throw err;
  }
  const vendor = await prisma.food_vendor.findUnique({
    where: { vendor_id: vendorId },
    select: { vendor_id: true, owner_id: true, vendor_type_id: true },
  });
  if (!vendor) {
    const err = new Error('Food vendor not found.');
    err.statusCode = 404;
    throw err;
  }
  if (!isFoodAdmin(req.user) && vendor.owner_id !== req.user?.user_id) {
    const err = new Error('Food vendor access required.');
    err.statusCode = 403;
    throw err;
  }
  return vendor;
}

function foodRouteError(res, err, fallback) {
  const status = err?.statusCode || err?.status || 500;
  return res.status(status).json({ successful: false, error: err?.message || fallback });
}

function normalizeGrocerySubstitutionPreference(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const modeRaw = String(source.mode ?? fallback.mode ?? fallback.substitution_mode ?? '').trim().toLowerCase();
  const modeAliases = {
    allow_substitutions: 'allow',
    allow: 'allow',
    contact: 'contact_first',
    contact_first: 'contact_first',
    no_substitutions: 'none',
    none: 'none',
  };
  const mode = GROCERY_SUBSTITUTION_MODES.has(modeAliases[modeRaw] || modeRaw)
    ? (modeAliases[modeRaw] || modeRaw)
    : 'contact_first';
  const preferredRaw = source.preferred_items ?? source.preferredItems ?? fallback.preferred_items ?? fallback.preferred_substitutions ?? [];
  const preferredArray = Array.isArray(preferredRaw)
    ? preferredRaw
    : String(preferredRaw || '').split(/[\n,]/);
  const preferredItems = preferredArray
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((item) => item.slice(0, 120));
  const note = String(source.note ?? fallback.substitution_note ?? '').trim().slice(0, 500);
  return {
    mode,
    preferred_items: preferredItems,
    note: note || null,
  };
}

function normalizeOrderFlow(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'grocery' || raw === 'groceries') return 'grocery';
  return 'food';
}

function flowFromVendorTypeName(value) {
  return normalizeOrderFlow(value);
}

function orderFlow(order) {
  if (order?.order_flow) return normalizeOrderFlow(order.order_flow);
  return flowFromVendorTypeName(order?.vendor_type?.vendor_type || order?.food_vendor?.vendor_type?.vendor_type);
}

function isGroceryOrder(order) {
  return orderFlow(order) === 'grocery';
}

function customerCopyFor(flow, status) {
  if (flow === 'grocery') return GROCERY_CUSTOMER_COPY[status] ?? getFoodCustomerCopy(status, 'store');
  return getFoodCustomerCopy(status, flow === 'store' ? 'store' : 'restaurant');
}

/** Dispatch only same-day courier deliveries — pickup, catering events, and scheduled drops stay with the vendor. */
function maybeDispatchFoodDelivery(io, order, vendorTypeName) {
  if (!order || isFoodPickupOrder(order) || isReservedPickupSentinel(order?.deliver_location)) return;
  const typeName = vendorTypeName
    || order?.vendor_type?.vendor_type
    || order?.food_vendor?.vendor_type?.vendor_type
    || order?.vendor_type_name;
  if (isEventCateringType(typeName) || order.scheduled_time) return;
  dispatchDeliveryOrder(io, 'food_order', order.food_order_id).catch((err) =>
    console.error('[food] dispatch failed:', err.message));
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const [index, raw] of items.entries()) {
    const foodItemId = Number(raw?.food_item_id ?? raw?.item_id ?? raw?.id);
    if (!Number.isInteger(foodItemId) || foodItemId <= 0) {
      const err = new Error(`Invalid item at position ${index + 1}.`);
      err.statusCode = 400;
      throw err;
    }
    const qtyValue = raw?.qty ?? raw?.quantity ?? 1;
    const qty = Number(qtyValue);
    if (!Number.isInteger(qty) || qty <= 0) {
      const err = new Error(`Invalid quantity for item ${foodItemId}.`);
      err.statusCode = 400;
      throw err;
    }
    const modifierOptionIds = Array.isArray(raw?.modifier_option_ids)
      ? raw.modifier_option_ids.map((value) => Number(value))
      : [];
    if (modifierOptionIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      const err = new Error(`Invalid modifier option for item ${foodItemId}.`);
      err.statusCode = 400;
      throw err;
    }
    normalized.push({
      food_item_id: foodItemId,
      qty,
      modifier_option_ids: [...new Set(modifierOptionIds)].sort((a, b) => a - b),
      special_instructions: typeof raw?.special_instructions === 'string' ? raw.special_instructions.trim() : null,
    });
  }
  return normalized;
}

function validateOrderItemRows(orderItems, itemRows, vendorId, vendorTypeId) {
  const requestedIds = [...new Set(orderItems.map((item) => item.food_item_id))];
  if (itemRows.length !== requestedIds.length) {
    const found = new Set(itemRows.map((item) => item.food_item_id));
    const missing = requestedIds.filter((id) => !found.has(id));
    const err = new Error(`Item not found: ${missing.join(', ')}`);
    err.statusCode = 404;
    throw err;
  }

  const byId = new Map(itemRows.map((item) => [item.food_item_id, item]));
  for (const requested of orderItems) {
    const item = byId.get(requested.food_item_id);
    if (item.vendor_id !== vendorId) {
      const err = new Error(`${item.name || 'Item'} does not belong to this store.`);
      err.statusCode = 400;
      throw err;
    }
    if (item.vendor_type_id != null && vendorTypeId != null && item.vendor_type_id !== vendorTypeId) {
      const err = new Error(`${item.name || 'Item'} does not match this store type.`);
      err.statusCode = 400;
      throw err;
    }
    if (item.is_available === false) {
      const err = new Error(`${item.name || 'Item'} is unavailable.`);
      err.statusCode = 409;
      throw err;
    }
    if (item.stock_qty != null && item.stock_qty < requested.qty) {
      const err = new Error(`Insufficient stock for ${item.name || 'item'}. Only ${item.stock_qty} available.`);
      err.statusCode = 409;
      throw err;
    }
  }
  return byId;
}

function extractTipFromInstructions(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^\s*\[Tip:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)\]/i);
  if (!match) return undefined;
  return parseNonNegativeAmount(match[1]);
}

function resolveFoodTipAmount({ tip, tip_amount, delivery_instructions }) {
  const explicit = parseNonNegativeAmount(tip_amount ?? tip);
  if (explicit != null) return explicit;
  const parsed = extractTipFromInstructions(delivery_instructions);
  return parsed == null ? 0 : parsed;
}

function parseSignedMoneyAmount(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function calculateFoodOrderPricing(lines, country, deliveryFee, tip = 0, promoDiscount = 0) {
  // totalFromLines owns the promo math (discount applies to the merchandise base
  // before fee + tax) so this order total is identical to the amount the payment
  // endpoints charge for the same cart.
  const pricing = totalFromLines({
    lines,
    country,
    tip,
    shippingMode: 'delivery',
    shippingFee: deliveryFee,
    promoDiscount,
  });
  return {
    subtotal: pricing.subtotal,
    grossSubtotal: pricing.grossSubtotal,
    deliveryFee: pricing.shipping,
    platformFee: pricing.platformFee,
    govTax: pricing.tax,
    tipAmount: pricing.tip,
    promoDiscount: pricing.promoDiscount,
    totalAmount: pricing.amount,
  };
}

const FOOD_ANALYTICS_VENDOR_TYPE = {
  food: 'Restaurant',
  restaurant: 'Restaurant',
  restaurants: 'Restaurant',
  grocery: 'Grocery',
  groceries: 'Grocery',
  floral: 'Floral',
  flowers: 'Floral',
  catering: 'Catering',
  mealkit: 'Meal Kit',
  meal_kit: 'Meal Kit',
};

async function resolveFoodAnalyticsVendorTypeId(vertical) {
  const key = String(vertical || '').trim().toLowerCase();
  const typeName = FOOD_ANALYTICS_VENDOR_TYPE[key];
  if (!typeName) return null;
  const types = await prisma.vendor_type.findMany({ select: { vendor_type_id: true, vendor_type: true } });
  return types.find((t) => String(t.vendor_type || '').trim().toLowerCase() === typeName.toLowerCase())?.vendor_type_id ?? null;
}

function dashboardNavForFoodVendorType(typeName) {
  const n = String(typeName || '').trim().toLowerCase();
  if (/floral|flower/.test(n)) return 'sd-flowers';
  if (/groc/.test(n)) return 'sd-groceries';
  if (/cater/.test(n)) return 'sd-catering';
  return 'sd-food';
}

async function attachVendorRatingStats(vendors) {
  const ids = vendors
    .map((v) => Number(v.vendor_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return vendors;
  let grouped = [];
  try {
    grouped = await prisma.food_order_rating.groupBy({
      by: ['vendor_id'],
      where: { vendor_id: { in: ids } },
      _avg: { rating: true },
      _count: { _all: true },
    });
  } catch {
    grouped = [];
  }
  const map = new Map(
    grouped.map((g) => [
      g.vendor_id,
      {
        rating: g._avg?.rating != null ? Math.round(g._avg.rating * 10) / 10 : null,
        review_count: g._count?._all || 0,
      },
    ]),
  );
  return vendors.map((v) => {
    const stats = map.get(v.vendor_id) || { rating: null, review_count: 0 };
    return { ...v, rating: stats.rating, review_count: stats.review_count };
  });
}

// Fire-and-forget: a notification must never block the order mutation it describes.
// actionUrl stays on the buyer's orders page for every food-family vertical — do not
// route these to browse hubs (food/floral/groceries); call sites never override it.
function notifyFoodCustomer(io, { userId, orderId, status, body = null, merchantKind = null, flow = null }) {
  (async () => {
    const resolvedFlow = flow ? normalizeOrderFlow(flow) : null;
    const kind = merchantKind || (resolvedFlow === 'grocery' ? 'store' : await resolveFoodOrderMerchantKind(orderId));
    const copy = resolvedFlow ? customerCopyFor(resolvedFlow, status) : getFoodCustomerCopy(status, kind);
    if (!userId || !copy) return;
    notify(io, {
      userId: Number(userId),
      vertical: resolvedFlow || 'food',
      type: `order.${status}`,
      title: copy.title,
      body: body ?? copy.body,
      urgency: 'ambient',
      entityType: 'food_order',
      entityId: orderId ?? null,
      actionUrl: 'orders',
    });
  })().catch(() => {});
}

function emitOrderStatus(io, order, status, extra = {}) {
  const id = Number(order?.food_order_id ?? extra.order_id);
  if (!id || !order?.user_id) return;
  const flow = orderFlow(order);
  const safeExtra = { ...extra };
  if (flow === 'grocery' && safeExtra.driver_location) {
    safeExtra.driver_location = customerSafeDriverLocation(safeExtra.driver_location);
  }
  io?.to(`user-${order.user_id}`)?.emit(`order-status-update-${id}`, {
    status,
    order_status: status,
    order_flow: flow,
    vertical: flow,
    message: safeExtra.message || `Your ${flow === 'grocery' ? 'grocery' : 'food'} order status is now ${status}`,
    updated_at: safeExtra.updated_at || new Date(),
    ...safeExtra,
  });
}

function groceryDriverEarning(order) {
  const percent = readNonNegativeEnvNumber('GROCERY_DRIVER_PAYOUT_PERCENT', 0.79);
  const fee = Number(order?.delivery_fee) || 0;
  const tip = Number(order?.tip_amount) || 0;
  return round2((fee * percent) + tip);
}

function groceryDriverWaitCompensation(order, now = new Date()) {
  if (!isGroceryOrder(order)) return null;
  const freeMinutes = Math.max(0, Math.round(readNonNegativeEnvNumber('GROCERY_DRIVER_WAIT_FREE_MINUTES', 5)));
  const ratePerMinute = readNonNegativeEnvNumber('GROCERY_DRIVER_WAIT_RATE_PER_MINUTE', 0.25);
  const maxAmount = readNonNegativeEnvNumber('GROCERY_DRIVER_WAIT_COMP_MAX', 8);
  const readyAt = order?.ready_for_pickup_at || order?.packed_at;
  const storeWaitMinutes = minutesBetween(readyAt, order?.picked_up_at) ?? 0;
  const delay = safeJsonObject(order?.delivery_delay_reason);
  const customerWaitStart = delay.reason === 'customer_unavailable' ? delay.reported_at : null;
  const customerWaitEnd = order?.delivered_at || now;
  const customerWaitMinutes = minutesBetween(customerWaitStart, customerWaitEnd) ?? 0;
  const totalWaitMinutes = Math.max(0, storeWaitMinutes + customerWaitMinutes);
  const billableMinutes = Math.max(0, totalWaitMinutes - freeMinutes);
  const amount = round2(Math.min(maxAmount, billableMinutes * ratePerMinute));
  return {
    store_wait_minutes: storeWaitMinutes,
    customer_wait_minutes: customerWaitMinutes,
    total_wait_minutes: totalWaitMinutes,
    free_minutes: freeMinutes,
    billable_minutes: billableMinutes,
    rate_per_minute: round2(ratePerMinute),
    max_amount: round2(maxAmount),
    amount,
    currency: 'CAD',
    calculated_at: now.toISOString(),
    calculation: 'max(0,total_wait-free_minutes)*rate_capped',
  };
}

function groceryDriverFinalEarning(order, waitCompensation = groceryDriverWaitCompensation(order)) {
  const stored = Number(order?.driver_earning);
  const base = Number.isFinite(stored) && stored > 0 ? stored : groceryDriverEarning(order);
  const waitAmount = Number(waitCompensation?.amount);
  return round2(base + (Number.isFinite(waitAmount) ? waitAmount : 0));
}

function validateDeliveryWindow(startValue, endValue) {
  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;
  if ((startValue && Number.isNaN(start?.getTime())) || (endValue && Number.isNaN(end?.getTime()))) {
    const err = new Error('Invalid delivery window.');
    err.statusCode = 400;
    throw err;
  }
  if (start && end && end <= start) {
    const err = new Error('Delivery window end must be after the start time.');
    err.statusCode = 400;
    throw err;
  }
  return { start, end };
}

const FOOD_VENDOR_OPERATION_STATUSES = new Set(['normal', 'busy', 'low_staff', 'delayed_packing', 'paused']);

function normalizeVendorOperationsStatus(value, fallback = 'normal') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  return FOOD_VENDOR_OPERATION_STATUSES.has(raw) ? raw : null;
}

function isUploadedDeliveryProofUrl(order, url) {
  const value = String(url || '').trim();
  if (!value || !order?.food_order_id || !order?.driver_id) return false;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const path = decodeURIComponent(parsed.pathname || '');
    return path.includes(`/delivery-proofs/food-order-${order.food_order_id}-${order.driver_id}-`);
  } catch {
    return false;
  }
}

const DELIVERY_HANDOFF_PREFERENCES = new Set(['meet_outside', 'leave_at_door', 'call_on_arrival']);
const GROCERY_DELIVERY_DELAY_REASONS = new Set([
  'store_not_ready',
  'traffic',
  'driver_waiting',
  'customer_unavailable',
  'wrong_address',
  'unsafe_dropoff',
  'weather',
  'vehicle_issue',
  'damaged_order',
  'other',
]);
const GROCERY_FAILURE_RESOLUTION_ACTIONS = new Set(['retry_delivery', 'return_to_store', 'refund_review']);
const GROCERY_FAILED_DELIVERY_REASONS = new Set([
  'customer_unavailable',
  'wrong_address',
  'unsafe_dropoff',
  'damaged_order',
  'retry_delivery',
  'return_to_store',
  'refund_review',
]);

function normalizeDeliveryPreference(raw = {}, fallbackInstructions = '') {
  const source = safeJsonObject(raw);
  const text = String(fallbackInstructions || '').toLowerCase();
  const handoffRaw = String(source.handoff || source.handoff_preference || source.preference || '').trim().toLowerCase();
  let handoff = DELIVERY_HANDOFF_PREFERENCES.has(handoffRaw) ? handoffRaw : null;
  if (!handoff && textIncludesAny(text, ['leave at door', 'leave-at-door', 'contactless', 'no contact'])) handoff = 'leave_at_door';
  if (!handoff && textIncludesAny(text, ['call on arrival', 'call when arrive', 'call me'])) handoff = 'call_on_arrival';
  if (!handoff && textIncludesAny(text, ['meet outside', 'meet me outside', 'outside'])) handoff = 'meet_outside';
  if (!handoff) handoff = 'meet_outside';
  return {
    handoff,
    meet_outside: handoff === 'meet_outside',
    leave_at_door: handoff === 'leave_at_door',
    call_on_arrival: handoff === 'call_on_arrival',
    note: String(source.note || '').trim().slice(0, 500) || null,
  };
}

function groceryProofRequirements(order = {}) {
  if (!isGroceryOrder(order)) return null;
  const preference = normalizeDeliveryPreference(order.delivery_preference, order.delivery_instructions);
  const labels = groceryHandlingLabels(order);
  const ageCheckRequired = labels.includes('age_restricted') || labels.includes('pharmacy');
  const leaveAtDoor = preference.handoff === 'leave_at_door';
  const allowedTypes = ageCheckRequired
    ? ['signature']
    : leaveAtDoor
      ? ['photo', 'contactless']
      : ['signature', 'photo'];
  return {
    allowed_types: allowedTypes,
    required: true,
    requires_photo: allowedTypes.includes('photo') && leaveAtDoor,
    requires_signature: ageCheckRequired || preference.handoff !== 'leave_at_door',
    contactless_allowed: allowedTypes.includes('contactless'),
    age_check_required: ageCheckRequired,
    reason: ageCheckRequired
      ? 'age_or_pharmacy_item'
      : leaveAtDoor
        ? 'leave_at_door'
        : 'customer_handoff',
  };
}

function sanitizeDeliveryProof(raw = {}, order = null) {
  const type = String(raw.proof_type || raw.type || '').trim().toLowerCase();
  if (!type) return null;
  if (!['photo', 'signature', 'contactless'].includes(type)) {
    const err = new Error('Invalid delivery proof type.');
    err.statusCode = 400;
    throw err;
  }
  const requirements = groceryProofRequirements(order);
  if (requirements?.allowed_types?.length && !requirements.allowed_types.includes(type)) {
    const err = new Error('This proof type is not allowed for the customer handoff preference or order type.');
    err.statusCode = 400;
    throw err;
  }
  const proof = { type };
  if (type === 'photo') {
    const url = String(raw.proof_url || raw.photo_url || '').trim();
    if (!url) {
      const err = new Error('Photo proof is required.');
      err.statusCode = 400;
      throw err;
    }
    if (isGroceryOrder(order) && !isUploadedDeliveryProofUrl(order, url)) {
      const err = new Error('Upload the grocery delivery proof photo before completing the delivery.');
      err.statusCode = 400;
      throw err;
    }
    proof.url = url;
  }
  if (type === 'signature') {
    const name = String(raw.signature_name || '').trim();
    if (!name) {
      const err = new Error('Signature name is required.');
      err.statusCode = 400;
      throw err;
    }
    if (isGroceryOrder(order) && name.length < 2) {
      const err = new Error('A valid signature name is required.');
      err.statusCode = 400;
      throw err;
    }
    proof.signature_name = name;
  }
  if (type === 'contactless') {
    const note = String(raw.contactless_note || raw.note || '').trim().slice(0, 500);
    if (isGroceryOrder(order) && note.length < 4) {
      const err = new Error('A contactless delivery note is required.');
      err.statusCode = 400;
      throw err;
    }
    proof.note = note || null;
  }
  return proof;
}

const SELLER_HANDOFF_CHECKLIST_KEYS = new Set([
  'order_packed',
  'bags_sealed',
  'cold_items_marked',
  'receipt_attached',
  'handoff_proof_captured',
]);

function sanitizeSellerHandoffChecklist(raw = {}, existing = {}) {
  const merged = safeJsonObject(existing);
  for (const key of SELLER_HANDOFF_CHECKLIST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw || {}, key)) {
      merged[key] = Boolean(raw[key]);
    }
  }
  return {
    order_packed: Boolean(merged.order_packed),
    bags_sealed: Boolean(merged.bags_sealed),
    cold_items_marked: Boolean(merged.cold_items_marked),
    receipt_attached: Boolean(merged.receipt_attached),
    handoff_proof_captured: Boolean(merged.handoff_proof_captured),
    updated_at: new Date().toISOString(),
  };
}

const ORDER_FLOW_INCLUDE = {
  food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
  vendor_type: { select: { vendor_type: true } },
};

function groceryPendingSubstitutions(order) {
  if (!isGroceryOrder(order)) return [];
  const substitutions = Array.isArray(order?.grocery_substitutions) ? order.grocery_substitutions : [];
  return substitutions.filter((sub) => {
    const status = String(sub?.status || sub?.response || 'pending').toLowerCase().replace(/_/g, ' ').trim();
    return status === 'pending' || status === 'pending customer';
  });
}

function assertNoPendingGrocerySubstitutions(order) {
  const pending = groceryPendingSubstitutions(order);
  if (!pending.length) return;
  const err = new Error('Customer substitution approval is still pending.');
  err.statusCode = 409;
  err.pendingSubstitutions = pending;
  throw err;
}

function statusTimestampData(status, order = {}) {
  const now = new Date();
  const data = { last_update: now };
  if (status === 'confirmed') data.store_accepted_at = order.store_accepted_at || now;
  if (status === 'preparing' && isGroceryOrder(order)) data.packed_at = order.packed_at || now;
  if (status === 'ready_for_pickup') data.ready_for_pickup_at = order.ready_for_pickup_at || now;
  if (status === 'dispatched') data.driver_accepted_at = order.driver_accepted_at || now;
  if (status === 'picked_up') data.picked_up_at = order.picked_up_at || now;
  if (status === 'delivered') data.delivered_at = now;
  return data;
}

function parseOptionalFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRadiusKm(value) {
  const radius = parseOptionalFiniteNumber(value);
  if (radius == null) return 10;
  return Math.min(50, Math.max(1, radius));
}

function safeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textIncludesAny(text, needles) {
  const haystack = String(text || '').toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function groceryHandlingLabels(order) {
  if (!isGroceryOrder(order)) return [];
  const labels = new Set();
  const items = Array.isArray(order?.food_order_items) ? order.food_order_items : [];
  for (const item of items) {
    const food = item?.food_item || {};
    const text = [
      food.name,
      food.allergen_info,
      food.food_category?.name,
    ].filter(Boolean).join(' ');
    if (textIncludesAny(text, ['frozen', 'ice cream', 'ice-cream'])) labels.add('frozen');
    if (textIncludesAny(text, ['cold', 'chilled', 'milk', 'cheese', 'yogurt', 'cream'])) labels.add('cold');
    if (textIncludesAny(text, ['fragile', 'glass', 'eggs', 'egg'])) labels.add('fragile');
    if (textIncludesAny(text, ['alcohol', 'beer', 'wine', 'liquor'])) labels.add('age_restricted');
    if (textIncludesAny(text, ['pharmacy', 'medicine', 'prescription'])) labels.add('pharmacy');
  }
  return Array.from(labels);
}

function groceryDeliveryTimeline(order) {
  const steps = [
    ['confirmed', 'Store accepted', order?.store_accepted_at],
    ['preparing', 'Packing order', order?.packed_at],
    ['ready_for_pickup', 'Ready for pickup', order?.ready_for_pickup_at],
    ['dispatched', 'Driver assigned', order?.driver_accepted_at],
    ['picked_up', 'Picked up', order?.picked_up_at],
    ['delivered', 'Delivered', order?.delivered_at],
  ];
  const status = String(order?.order_status || '').toLowerCase();
  const activeIndex = steps.findIndex(([key]) => key === status);
  const failed = status === 'delivery_failed';
  return steps.map(([key, label, timestamp], index) => ({
    key,
    label,
    status: failed && key === 'delivered'
      ? 'blocked'
      : index < activeIndex || key === 'delivered' && status === 'delivered'
        ? 'done'
        : index === activeIndex
          ? 'current'
          : 'pending',
    timestamp: timestamp || null,
  })).concat(failed ? [{
    key: 'delivery_failed',
    label: 'Delivery issue reported',
    status: 'current',
    timestamp: order?.last_update || null,
  }] : []);
}

function groceryDriverEarningBreakdown(order) {
  const tip = Number(order?.tip_amount) || 0;
  const waitCompensation = safeJsonObject(order?.driver_wait_compensation);
  const waitingFee = Number(waitCompensation.amount) || 0;
  const total = Number(order?.driver_earning) || groceryDriverFinalEarning(order, waitCompensation.amount != null ? waitCompensation : undefined);
  const payoutPercent = Math.min(1, Math.max(0, Number(process.env.GROCERY_DRIVER_PAYOUT_PERCENT) || 0.79));
  return {
    base_fee: round2(Math.max(0, total - tip - waitingFee)),
    distance_fee: null,
    waiting_fee: round2(waitingFee),
    wait_minutes: Number(waitCompensation.total_wait_minutes) || null,
    store_wait_minutes: Number(waitCompensation.store_wait_minutes) || null,
    customer_wait_minutes: Number(waitCompensation.customer_wait_minutes) || null,
    free_wait_minutes: Number(waitCompensation.free_minutes) || null,
    tip: round2(tip),
    bonus: null,
    cancellation_compensation: null,
    total: round2(total),
    payout_percent: payoutPercent,
    calculation: waitingFee > 0 ? 'delivery_fee_percent_plus_tip_plus_wait' : 'delivery_fee_percent_plus_tip',
  };
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

function etaMinutesFromKm(km) {
  const distance = Number(km);
  if (!Number.isFinite(distance) || distance < 0) return null;
  return Math.max(1, Math.round((distance / 30) * 60));
}

function driverLocationPayload(driverProfile) {
  const lat = parseOptionalFiniteNumber(driverProfile?.current_lat);
  const lng = parseOptionalFiniteNumber(driverProfile?.current_long);
  if (lat == null || lng == null) return null;
  const lastPing = driverProfile?.last_ping || null;
  const lastPingTime = lastPing ? new Date(lastPing).getTime() : NaN;
  const stale = !Number.isFinite(lastPingTime) || Date.now() - lastPingTime > 2 * 60 * 1000;
  return {
    lat,
    lng,
    last_ping: lastPing,
    last_known: stale,
  };
}

function customerSafeDriverLocation(location) {
  if (!location) return null;
  const lat = parseOptionalFiniteNumber(location.lat ?? location.current_lat ?? location.latitude);
  const lng = parseOptionalFiniteNumber(location.lng ?? location.current_long ?? location.longitude);
  return {
    lat: lat == null ? null : Number(lat.toFixed(3)),
    lng: lng == null ? null : Number(lng.toFixed(3)),
    precision: 'approximate',
    last_ping: location.last_ping || null,
    last_known: Boolean(location.last_known),
  };
}

function driverEtaToStore(order, driverProfile) {
  const driver = driverLocationPayload(driverProfile);
  const vendorLat = parseOptionalFiniteNumber(order?.food_vendor?.lat);
  const vendorLng = parseOptionalFiniteNumber(order?.food_vendor?.long);
  if (!driver || vendorLat == null || vendorLng == null) return null;
  return etaMinutesFromKm(haversineKm(driver.lat, driver.lng, vendorLat, vendorLng));
}

function driverDistanceToStoreKm(order, driverProfile) {
  const driver = driverLocationPayload(driverProfile);
  const vendorLat = parseOptionalFiniteNumber(order?.food_vendor?.lat);
  const vendorLng = parseOptionalFiniteNumber(order?.food_vendor?.long);
  if (!driver || vendorLat == null || vendorLng == null) return null;
  return haversineKm(driver.lat, driver.lng, vendorLat, vendorLng);
}

function groceryRouteProgress(order, driverProfile) {
  const status = String(order?.order_status || '').toLowerCase();
  const etaToStore = driverEtaToStore(order, driverProfile);
  const statusProgress = {
    pending: [5, 'waiting_for_store', 'Waiting for store confirmation'],
    confirmed: [15, 'store_preparing', 'Store accepted'],
    preparing: [30, 'packing', 'Store is packing'],
    ready_for_pickup: [45, 'ready_for_pickup', 'Ready for driver pickup'],
    dispatched: [58, 'driver_to_store', etaToStore ? `Driver heading to store · ${etaToStore} min` : 'Driver heading to store'],
    picked_up: [78, 'out_for_delivery', 'Driver is out for delivery'],
    delivery_failed: [78, 'needs_attention', 'Delivery needs attention'],
    delivered: [100, 'delivered', 'Delivered'],
    cancelled: [100, 'cancelled', 'Cancelled'],
  };
  const [percent, state, label] = statusProgress[status] || [0, 'unknown', 'Status unavailable'];
  return {
    percent,
    state,
    label,
    eta_to_store_minutes: etaToStore,
    eta_to_customer_minutes: null,
    arriving_soon: status === 'picked_up' && Boolean(order?.delivery_window_end),
    last_known: Boolean(driverLocationPayload(driverProfile)?.last_known),
  };
}

function grocerySlaMetrics(order) {
  const acceptedAt = order?.store_accepted_at;
  const readyAt = order?.ready_for_pickup_at || order?.packed_at;
  const pickedUpAt = order?.picked_up_at;
  const deliveredAt = order?.delivered_at;
  const now = new Date();
  const currentWait =
    ['ready_for_pickup', 'dispatched'].includes(String(order?.order_status || '').toLowerCase())
      ? minutesBetween(readyAt, now)
      : null;
  const deadline = order?.delivery_window_end ? new Date(order.delivery_window_end).getTime() : NaN;
  const comparison = deliveredAt ? new Date(deliveredAt).getTime() : Date.now();
  return {
    store_accept_minutes: minutesBetween(order?.created_at, acceptedAt),
    packing_minutes: minutesBetween(acceptedAt, readyAt),
    driver_wait_minutes: minutesBetween(readyAt, pickedUpAt),
    delivery_minutes: minutesBetween(pickedUpAt, deliveredAt),
    total_minutes: minutesBetween(order?.created_at, deliveredAt),
    current_wait_minutes: currentWait,
    late: Number.isFinite(deadline) ? comparison > deadline : false,
  };
}

function groceryEtaConfidence(order, driverProfile = order?.driver_profile) {
  const status = String(order?.order_status || '').toLowerCase();
  const sla = grocerySlaMetrics(order);
  const route = groceryRouteProgress(order, driverProfile);
  const reasons = [];
  let level = 'on_time';
  let label = 'On time';
  const windowEnd = order?.delivery_window_end ? new Date(order.delivery_window_end).getTime() : NaN;
  const minutesToWindowEnd = Number.isFinite(windowEnd) ? Math.round((windowEnd - Date.now()) / 60000) : null;
  const eta = Number(route.eta_to_customer_minutes ?? route.eta_to_store_minutes);

  if (sla.late || status === 'delivery_failed') {
    level = 'delayed';
    label = status === 'delivery_failed' ? 'Needs support' : 'Delayed';
    reasons.push(status === 'delivery_failed' ? 'Delivery issue reported' : 'Past delivery window');
  } else if (Number.isFinite(eta) && minutesToWindowEnd != null && eta > minutesToWindowEnd) {
    level = 'at_risk';
    label = 'At risk';
    reasons.push('ETA is close to or beyond the delivery window');
  } else if (Number(sla.current_wait_minutes) >= 10) {
    level = 'at_risk';
    label = 'At risk';
    reasons.push('Driver has been waiting at pickup');
  } else if (route.last_known) {
    level = 'at_risk';
    label = 'At risk';
    reasons.push('Using last known driver location');
  } else if (['pending', 'confirmed', 'preparing'].includes(status) && order?.delivery_window_start) {
    reasons.push('Store is still preparing before dispatch');
  }

  return {
    level,
    label,
    reasons,
    eta_to_store_minutes: route.eta_to_store_minutes,
    eta_to_customer_minutes: route.eta_to_customer_minutes,
  };
}

function groceryScheduledState(order) {
  const anchor = order?.delivery_window_start || order?.scheduled_time || null;
  if (!anchor) return { ready: true, dispatch_after: null, minutes_until_dispatch: 0 };
  const lead = Math.max(10, Number(process.env.GROCERY_SCHEDULED_DISPATCH_LEAD_MIN || 45) || 45);
  const anchorTime = new Date(anchor).getTime();
  if (!Number.isFinite(anchorTime)) return { ready: true, dispatch_after: null, minutes_until_dispatch: 0 };
  const dispatchAfter = new Date(anchorTime - lead * 60000);
  const msUntil = dispatchAfter.getTime() - Date.now();
  return {
    ready: msUntil <= 0,
    dispatch_after: dispatchAfter,
    minutes_until_dispatch: Math.max(0, Math.ceil(msUntil / 60000)),
  };
}

function grocerySafetyControls(order, driverProfile = order?.driver_profile) {
  const proof = safeJsonObject(order?.delivery_proof);
  const failure = proof.failure || null;
  const preference = normalizeDeliveryPreference(order?.delivery_preference, order?.delivery_instructions);
  const status = String(order?.order_status || '').toLowerCase();
  const storeDistanceKm = driverDistanceToStoreKm(order, driverProfile);
  const deadline = order?.delivery_window_end ? new Date(order.delivery_window_end).getTime() : NaN;
  const lateAfterPickup = ['picked_up', 'delivery_failed'].includes(status) && Number.isFinite(deadline) && Date.now() > deadline;
  const farFromPickupBeforePickup = ['dispatched'].includes(status) && Number.isFinite(storeDistanceKm) && storeDistanceKm > 25;
  return {
    no_contact: preference.handoff === 'leave_at_door',
    issue_active: Boolean(failure),
    support_escalation: Boolean(failure?.support_escalation || failure?.reason === 'unsafe_dropoff'),
    suspicious_route: Boolean(farFromPickupBeforePickup || lateAfterPickup),
  };
}

function serializeGroceryDeliveryOrder(order, driverProfile = order?.driver_profile) {
  if (!isGroceryOrder(order)) return order;
  const deliveryFailure = safeJsonObject(order?.delivery_proof).failure || null;
  const deliveryPreference = normalizeDeliveryPreference(order?.delivery_preference, order?.delivery_instructions);
  const routeProgress = groceryRouteProgress(order, driverProfile);
  const deliveryOfferEvents = Array.isArray(order?.delivery_offer_events) ? order.delivery_offer_events : [];
  const driverLocation = driverLocationPayload(driverProfile);
  return {
    ...order,
    handling_labels: groceryHandlingLabels(order),
    delivery_timeline: groceryDeliveryTimeline(order),
    driver_earning_breakdown: groceryDriverEarningBreakdown(order),
    delivery_failure: deliveryFailure,
    delivery_preference: deliveryPreference,
    delivery_delay_reason: safeJsonObject(order?.delivery_delay_reason),
    delivery_failure_resolution: safeJsonObject(order?.delivery_failure_resolution),
    delivery_reschedule_request: safeJsonObject(order?.delivery_reschedule_request),
    driver_wait_compensation: safeJsonObject(order?.driver_wait_compensation),
    delivery_proof_requirements: groceryProofRequirements({ ...order, delivery_preference: deliveryPreference }),
    driver_location: driverLocation,
    customer_driver_location: customerSafeDriverLocation(driverLocation),
    customer_visibility: {
      driver_location_precision: 'approximate',
      exact_driver_location_visible: false,
      exact_customer_address_visible_to_driver: true,
      exact_customer_address_visible_to_store: false,
      last_known_location_supported: true,
    },
    route_progress: routeProgress,
    sla_metrics: grocerySlaMetrics(order),
    eta_confidence: groceryEtaConfidence(order, driverProfile),
    scheduled_dispatch: groceryScheduledState(order),
    safety_controls: grocerySafetyControls(order, driverProfile),
    pending_substitutions: groceryPendingSubstitutions(order),
    rejected_offer_events: deliveryOfferEvents.filter((event) => ['rejected', 'timed_out'].includes(String(event?.status || '').toLowerCase())),
    delivery_offer_events: deliveryOfferEvents,
    eta_to_store_minutes: routeProgress.eta_to_store_minutes,
    eta_to_customer_minutes: routeProgress.eta_to_customer_minutes,
    arriving_soon: routeProgress.arriving_soon,
  };
}

const router = express.Router();
router.use(foodWalletRouter);
const FOOD_CATEGORY = 'food category';
const FOOD_ITEM = 'food item';
const FOOD_AUTOCOMPLETE_LIMIT = 30;
const FOOD_AUTOCOMPLETE_WINDOW_SECONDS = 60;
const GOOGLE_MAPS_TIMEOUT_MS = readNonNegativeEnvNumber('GOOGLE_MAPS_TIMEOUT_MS', 2500) || 2500;

async function limitFoodAutocompleteProxy(req, res, next) {
  const userId = req.user?.user_id || req.user?.id || 'unknown';
  const limited = await checkRateLimit(`location-proxy:food-autocomplete:${userId}`, FOOD_AUTOCOMPLETE_LIMIT, FOOD_AUTOCOMPLETE_WINDOW_SECONDS);
  if (limited) {
    return res.status(429).json({
      successful: false,
      message: 'Too many location requests. Please wait a moment and try again.',
    });
  }
  next();
}

// Raster image types only. SVG is excluded on purpose — it can carry <script> and would be
// served as stored XSS from the public blob container.
export const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// In-memory upload for storefront branding images (logo / cover), streamed straight to blob.
const brandingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const deliveryProofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const inventoryCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file?.originalname || '').toLowerCase();
    const type = String(file?.mimetype || '').toLowerCase();
    if (name.endsWith('.csv') || type.includes('csv') || type === 'text/plain') return cb(null, true);
    return cb(new Error('Upload a CSV file.'));
  },
});

function inventoryCsvUploadMiddleware(req, res, next) {
  inventoryCsvUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({ successful: false, error: err.message || 'Upload a CSV file.' });
  });
}

/**
 * Public vendor payloads must never carry the Stripe Connect account id.
 *
 * GET /vendors, /vendors/filter, /categories and /items (plus the :id variants) all serialize a
 * food_vendor row wholesale — a bare `include`, then a `...v` spread — and none of them requires
 * a session: the two vendor lists are optionalAuth, categories and items have no guard at all.
 * That put stripe_account_id in an anonymous response for every onboarded vendor.
 *
 * Stripped here at the edge rather than via the global Prisma `omit`, because the payout paths
 * (services/food-payout.js, services/booking-host-payout.js) read the column off vendor objects
 * their callers loaded with a bare include — a global omit would silently break transfers.
 */
export function toPublicVendor(vendor) {
  if (!vendor || typeof vendor !== 'object') return vendor;
  const { stripe_account_id: _connectAccountId, ...safe } = vendor;
  return safe;
}

/** Same, for the rows that carry a food_vendor relation embed. */
export function withPublicVendorEmbed(row) {
  if (!row || typeof row !== 'object' || !row.food_vendor) return row;
  return { ...row, food_vendor: toPublicVendor(row.food_vendor) };
}

//======================================================================================================
//=========================================== FOOD CATEGORY ==========================================
//======================================================================================================
/**
 * GET Vendors by Type (Food, Grocery, or Meal Kit)
 * GET /food/vendors?type=GROCERY
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.get('/vendors/filter', optionalAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { type, lat, lng } = req.query; // 'FOOD', 'GROCERY', 'MEAL_KIT', 'Floral', 'Catering'

    const typeNames = vendorTypeNamesForAlias(type);
    const typeIds = await findVendorTypeIdsByNames(
      prisma,
      typeNames.length ? typeNames : (type ? [String(type)] : []),
    );
    // Public filter endpoint — bound it, or one request scans every vendor on the platform.
    const filterPage = parsePagination(req);
    const vendors = await prisma.food_vendor.findMany({
      take: filterPage.take,
      skip: filterPage.skip,
      where: {
        ...(typeIds.length === 1
          ? { vendor_type_id: typeIds[0] }
          : typeIds.length > 1
            ? { vendor_type_id: { in: typeIds } }
            : (type ? { vendor_type_id: -1 } : {})),
        is_open: true,
        is_active: true,  // F4: only show approved vendors to customers
        is_paused: false, // #5: a vendor that paused orders must not surface to customers
      },
      include: {
        vendor_type: true,
        food_category: { select: { food_category_id: true, name: true } },
      }
    });

    let filtered = vendors;
    const skipRadius = typeNames.some(isEventCateringType) || isEventCateringType(type);
    // When the buyer shares a pin, only surface vendors within delivery range.
    // Vendors missing coords stay visible so pre-geocode rows are not wiped from browse.
    // Catering is event-based, not a same-day 20 km courier ring.
    if (!skipRadius && lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      if (Number.isFinite(userLat) && Number.isFinite(userLng)) {
        filtered = filtered.filter((v) => {
          if (v.lat == null || v.long == null) return true;
          const dist = haversineKm(userLat, userLng, v.lat, v.long);
          return dist !== null && dist <= FOOD_DELIVERY_MAX_KM;
        });
      }
    }

    const named = filtered.map((v) => ({
      ...toPublicVendor(v),
      name: v.vendor_name || v.user?.name || null,
    }));
    let payload = named;
    try {
      payload = await attachFoodVendorOffers(named, req.user?.user_id ?? null);
    } catch (err) {
      console.error('[food.filter] attach offers failed:', err.message);
    }
    payload = await attachVendorRatingStats(payload);

    setPaginationHeaders(res, filterPage, vendors.length);
    return res.json({ successful: true, count: payload.length, data: payload });
  } catch (err) {
    return sendError(res, 500, req, 'food.filterError');
  }
});
/* GET ALL FOOD CATEGORIES */
router.get('/categories', async (req, res) => {
  try {
    const { vendor_id, vendor_type_id } = req.query;
    let where = {};
    if (vendor_id) {
      where.vendor_id = parseInt(vendor_id);
    }
    if (vendor_type_id) {
      where.vendor_type_id = parseInt(vendor_type_id);
    }

    const categories = await prisma.food_category.findMany({
      where,
      orderBy: { food_category_id: 'desc' },
      include: {
        food_vendor: true,
        vendor_type: true,
        food_item: true,
      },
    });
    res.json(categories.map(withPublicVendorEmbed));
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.fetchFailed', { resource: FOOD_CATEGORY });
  }
});

/* GET FOOD CATEGORY BY ID */
router.get('/categories/:id', async (req, res) => {
  try {
    const category = await prisma.food_category.findUnique({
      where: { food_category_id: parseInt(req.params.id) },
      include: {
        food_vendor: true,
        vendor_type: true,
        food_item: true,
      },
    });
    
    if (!category) {
      return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_CATEGORY });
    }
    
    res.json(withPublicVendorEmbed(category));
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.fetchFailed', { resource: FOOD_CATEGORY });
  }
});

/* CREATE FOOD CATEGORY */
router.post('/categories', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { vendor_id, name, sort_order, vendor_type_id } = req.body;
    const resolvedVendorId = vendor_id ? parseInt(vendor_id) : (req.foodVendor?.vendor_id ?? null);
    if (resolvedVendorId) {
      const owned = await prisma.food_vendor.findFirst({
        where: { vendor_id: resolvedVendorId, owner_id: req.user.user_id },
        select: { vendor_id: true },
      });
      if (!owned) return res.status(403).json({ successful: false, message: "You don't own this storefront." });
    }

    const category = await prisma.food_category.create({
      data: {
        vendor_id: resolvedVendorId,
        name,
        sort_order: sort_order ? parseInt(sort_order) : null,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : (req.foodVendor?.vendor_type_id ?? null),
      },
    });
    
    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.createFailed', { resource: FOOD_CATEGORY });
  }
});

/* UPDATE FOOD CATEGORY */
router.put('/categories/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { vendor_id, name, sort_order, vendor_type_id } = req.body;
    const existingCat = await prisma.food_category.findUnique({ where: { food_category_id: parseInt(req.params.id) } });
    if (!existingCat) return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_CATEGORY });
    if (existingCat.vendor_id != null) {
      const owned = await prisma.food_vendor.findFirst({
        where: { vendor_id: existingCat.vendor_id, owner_id: req.user.user_id },
        select: { vendor_id: true },
      });
      if (!owned) return res.status(403).json({ successful: false, message: "You don't own this storefront." });
    }

    const category = await prisma.food_category.update({
      where: { food_category_id: parseInt(req.params.id) },
      data: {
        vendor_id: vendor_id ? parseInt(vendor_id) : undefined,
        name: name !== undefined ? name : undefined,
        sort_order: sort_order !== undefined ? (sort_order ? parseInt(sort_order) : null) : undefined,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : undefined,
      },
    });
    
    res.json(category);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.updateFailed', { resource: FOOD_CATEGORY });
  }
});

/* DELETE FOOD CATEGORY */
router.delete('/categories/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const existingCat = await prisma.food_category.findUnique({ where: { food_category_id: parseInt(req.params.id) } });
    if (!existingCat) return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_CATEGORY });
    if (existingCat.vendor_id != null) {
      const owned = await prisma.food_vendor.findFirst({
        where: { vendor_id: existingCat.vendor_id, owner_id: req.user.user_id },
        select: { vendor_id: true },
      });
      if (!owned) return res.status(403).json({ successful: false, message: "You don't own this storefront." });
    }
    await prisma.food_category.delete({
      where: { food_category_id: parseInt(req.params.id) },
    });
    
    res.json({ message: req.t('success.deleted', { resource: FOOD_CATEGORY }) });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.deleteFailed', { resource: FOOD_CATEGORY });
  }
});

//======================================================================================================
//============================================ FOOD ITEM ==============================================
//======================================================================================================

/** Resolve category id from numeric id or name; reject missing/wrong-vendor categories. */
async function resolveFoodCategoryId(food_category_id, { vendorId, vendorTypeId }) {
  if (food_category_id === undefined || food_category_id === null || food_category_id === '') {
    return { categoryId: null };
  }
  if (Number.isInteger(Number(food_category_id))) {
    const categoryId = parseInt(food_category_id, 10);
    const category = await prisma.food_category.findUnique({ where: { food_category_id: categoryId } });
    if (!category) {
      return { error: `Food category ${categoryId} not found`, status: 400 };
    }
    if (vendorId != null && category.vendor_id != null && category.vendor_id !== vendorId) {
      return { error: 'Food category does not belong to this vendor', status: 400 };
    }
    return { categoryId };
  }
  const catName = String(food_category_id).trim();
  if (!catName) return { categoryId: null };
  let category = await prisma.food_category.findFirst({
    where: {
      vendor_id: vendorId,
      name: { equals: catName, mode: 'insensitive' },
    },
  });
  if (!category) {
    category = await prisma.food_category.create({
      data: {
        vendor_id: vendorId,
        name: catName,
        vendor_type_id: vendorTypeId,
      },
    });
  }
  return { categoryId: category.food_category_id };
}

/* GET FOOD ITEMS — filters by vendor_id when provided (customer menu fetch) */
router.get('/items', async (req, res) => {
  try {
    const { vendor_id, vendor_type_id } = req.query;
    let where = {};
    if (vendor_id) {
      where.vendor_id = parseInt(vendor_id);
    }
    if (vendor_type_id) {
      where.vendor_type_id = parseInt(vendor_type_id);
    } else if (!vendor_id) {
      // Default to Restaurant items (by name — IDs are not stable across environments)
      // to prevent mixing other verticals (Grocery, Floral, Catering).
      const restaurantIds = await findVendorTypeIdsByNames(prisma, ['Restaurant']);
      if (restaurantIds.length === 1) where.vendor_type_id = restaurantIds[0];
      else if (restaurantIds.length > 1) where.vendor_type_id = { in: restaurantIds };
    }

    const items = await prisma.food_item.findMany({
      where,
      orderBy: { food_item_id: 'desc' },
      take: 200,
      include: {
        food_category: true,
        food_vendor: true,
        vendor_type: true,
        food_item_pics: true,
        food_item_modifier_group: {
          orderBy: { sort_order: 'asc' },
          include: { options: { orderBy: { sort_order: 'asc' } } },
        },
      },
    });
    res.json(items.map(withPublicVendorEmbed));
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.fetchFailed', { resource: FOOD_ITEM });
  }
});

/* GET FOOD ITEM BY ID */
router.get('/items/:id', async (req, res) => {
  try {
    const item = await prisma.food_item.findUnique({
      where: { food_item_id: parseInt(req.params.id) },
      include: {
        food_category: true,
        food_vendor: true,
        vendor_type: true,
        food_item_pics: true,
        food_order_items: true,
        food_item_modifier_group: {
          orderBy: { sort_order: 'asc' },
          include: { options: { orderBy: { sort_order: 'asc' } } },
        },
      },
    });

    if (!item) {
      return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_ITEM });
    }

    res.json(withPublicVendorEmbed(item));
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.fetchFailed', { resource: FOOD_ITEM });
  }
});

/* CREATE FOOD ITEM */
router.post('/items', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { vendor_id, food_category_id, name, description, price, is_available, stock_qty, low_stock_threshold, expiry_date, vendor_type_id, allergen_info, image_url } = req.body;
    const normalizedStockQty = parseOptionalStockQty(stock_qty);
    const normalizedLowStockThreshold = parseOptionalLowStockThreshold(low_stock_threshold);
    const normalizedExpiryDate = parseOptionalExpiryDate(expiry_date);

    let resolvedVendorId = vendor_id ? parseInt(vendor_id) : (req.foodVendor?.vendor_id ?? null);
    let resolvedVendorTypeId = vendor_type_id ? parseInt(vendor_type_id) : (req.foodVendor?.vendor_type_id ?? null);

    if (resolvedVendorId != null && req.foodVendor?.vendor_id != null && resolvedVendorId !== req.foodVendor.vendor_id) {
      return res.status(403).json({ successful: false, error: 'vendor_id does not match your vendor account' });
    }
    if (!resolvedVendorId) {
      return res.status(400).json({ successful: false, error: 'vendor_id required' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ successful: false, error: 'name required' });
    }

    const catResult = await resolveFoodCategoryId(food_category_id, {
      vendorId: resolvedVendorId,
      vendorTypeId: resolvedVendorTypeId,
    });
    if (catResult.error) {
      return res.status(catResult.status).json({ successful: false, message: catResult.error, error: catResult.error });
    }
    const resolvedCategoryId = catResult.categoryId;

    const item = await prisma.food_item.create({
      data: {
        vendor_id: resolvedVendorId,
        food_category_id: resolvedCategoryId,
        name,
        description,
        price: price != null && price !== '' ? parseFloat(price) : null,
        is_available: normalizedStockQty === 0 ? false : (is_available !== undefined ? is_available : true),
        stock_qty: normalizedStockQty === undefined ? null : normalizedStockQty,
        low_stock_threshold: normalizedLowStockThreshold === undefined ? null : normalizedLowStockThreshold,
        expiry_date: normalizedExpiryDate === undefined ? null : normalizedExpiryDate,
        vendor_type_id: resolvedVendorTypeId,
        allergen_info: allergen_info ?? null,
      },
    });

    if (image_url) {
      await prisma.food_item_pics.create({
        data: {
          food_item_id: item.food_item_id,
          url: image_url,
          vendor_type_id: resolvedVendorTypeId,
        }
      });
    }

    const completeItem = await prisma.food_item.findUnique({
      where: { food_item_id: item.food_item_id },
      include: { food_item_pics: true }
    });
    
    res.status(201).json(completeItem);
  } catch (err) {
    console.error(err);
    if (err?.statusCode) return foodRouteError(res, err, 'Failed to create food item.');
    return sendError(res, 500, req, 'errors.createFailed', { resource: FOOD_ITEM });
  }
});

/* UPDATE FOOD ITEM */
router.put('/items/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { vendor_id, food_category_id, name, description, price, is_available, stock_qty, low_stock_threshold, expiry_date, vendor_type_id, allergen_info, image_url } = req.body;
    const food_item_id = parseInt(req.params.id);
    const normalizedStockQty = parseOptionalStockQty(stock_qty);
    const normalizedLowStockThreshold = parseOptionalLowStockThreshold(low_stock_threshold);
    const normalizedExpiryDate = parseOptionalExpiryDate(expiry_date);

    // Ownership check
    const existingItem = await prisma.food_item.findUnique({
      where: { food_item_id },
      include: { food_vendor: true }
    });
    if (!existingItem) return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_ITEM });
    if (existingItem.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, error: 'You do not own this item.' });
    }

    let resolvedVendorId = vendor_id ? parseInt(vendor_id) : (existingItem.vendor_id ?? req.foodVendor?.vendor_id ?? null);
    let resolvedVendorTypeId = vendor_type_id ? parseInt(vendor_type_id) : (existingItem.vendor_type_id ?? req.foodVendor?.vendor_type_id ?? null);

    let resolvedCategoryId = undefined;
    if (food_category_id !== undefined) {
      if (food_category_id === null || food_category_id === '') {
        resolvedCategoryId = null;
      } else {
        const catResult = await resolveFoodCategoryId(food_category_id, {
          vendorId: resolvedVendorId,
          vendorTypeId: resolvedVendorTypeId,
        });
        if (catResult.error) {
          return res.status(catResult.status).json({ successful: false, message: catResult.error, error: catResult.error });
        }
        resolvedCategoryId = catResult.categoryId;
      }
    }

    await prisma.food_item.update({
      where: { food_item_id },
      data: {
        vendor_id: vendor_id ? parseInt(vendor_id) : undefined,
        food_category_id: resolvedCategoryId,
        name: name !== undefined ? name : undefined,
        description: description !== undefined ? description : undefined,
        price: price !== undefined ? (price === null || price === '' ? null : parseFloat(price)) : undefined,
        is_available: normalizedStockQty === 0 ? false : (is_available !== undefined ? is_available : undefined),
        stock_qty: normalizedStockQty,
        low_stock_threshold: normalizedLowStockThreshold,
        expiry_date: normalizedExpiryDate,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : undefined,
        allergen_info: allergen_info !== undefined ? allergen_info : undefined,
      },
    });

    if (image_url !== undefined) {
      await prisma.food_item_pics.deleteMany({ where: { food_item_id } });
      if (image_url) {
        await prisma.food_item_pics.create({
          data: {
            food_item_id,
            url: image_url,
            vendor_type_id: resolvedVendorTypeId,
          }
        });
      }
    }

    const completeItem = await prisma.food_item.findUnique({
      where: { food_item_id },
      include: { food_item_pics: true }
    });
    
    res.json(completeItem);
  } catch (err) {
    console.error(err);
    if (err?.statusCode) return foodRouteError(res, err, 'Failed to update food item.');
    return sendError(res, 500, req, 'errors.updateFailed', { resource: FOOD_ITEM });
  }
});

/* DELETE FOOD ITEM */
router.delete('/items/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const food_item_id = parseInt(req.params.id);

    // Ownership check
    const existingItem = await prisma.food_item.findUnique({
      where: { food_item_id },
      include: { food_vendor: true }
    });
    if (!existingItem) return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_ITEM });
    if (existingItem.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, error: 'You do not own this item.' });
    }

    await prisma.$transaction([
      // Delete related cart items
      prisma.food_cart.deleteMany({ where: { food_item_id } }),
      // Delete related item pictures
      prisma.food_item_pics.deleteMany({ where: { food_item_id } }),
      // Null out references in food_order_items
      prisma.food_order_items.updateMany({ where: { food_item_id }, data: { food_item_id: null } }),
      // Finally, delete the food item itself
      prisma.food_item.delete({ where: { food_item_id } }),
    ]);
    
    res.json({ message: req.t('success.deleted', { resource: FOOD_ITEM }) });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.deleteFailed', { resource: FOOD_ITEM });
  }
});

router.get('/vendor/:vendor_id/items/export.csv', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const items = await prisma.food_item.findMany({
      where: { vendor_id: vendorId },
      orderBy: [{ food_category_id: 'asc' }, { name: 'asc' }],
      include: { food_item_pics: { orderBy: { food_item_pics_id: 'asc' }, take: 1 } },
    });
    const rows = [
      INVENTORY_CSV_COLUMNS,
      ...items.map((item) => [
        item.food_item_id,
        item.name,
        item.description,
        item.price,
        item.food_category_id,
        item.is_available,
        item.stock_qty,
        item.low_stock_threshold,
        formatCsvDate(item.expiry_date),
        item.allergen_info,
        item.food_item_pics?.[0]?.url || '',
      ]),
    ];
    const csv = rows.map((row) => row.map(csvEscapeCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-vendor-${vendorId}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to export inventory.');
  }
});

router.get('/vendor/:vendor_id/inventory-alerts', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const items = await prisma.food_item.findMany({
      where: { vendor_id: vendorId },
      orderBy: [{ expiry_date: 'asc' }, { stock_qty: 'asc' }, { name: 'asc' }],
      select: {
        food_item_id: true,
        name: true,
        is_available: true,
        stock_qty: true,
        low_stock_threshold: true,
        expiry_date: true,
      },
    });
    const alerts = items
      .map((item) => ({ ...item, alerts: inventoryAlertForItem(item) }))
      .filter((item) => item.alerts.length > 0);
    return res.json({
      successful: true,
      data: {
        alerts,
        counts: {
          out_of_stock: alerts.filter((item) => item.alerts.includes('out_of_stock')).length,
          low_stock: alerts.filter((item) => item.alerts.includes('low_stock')).length,
          expired: alerts.filter((item) => item.alerts.includes('expired')).length,
          expiring_soon: alerts.filter((item) => item.alerts.includes('expiring_soon')).length,
        },
      },
    });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to load inventory alerts.');
  }
});

router.get('/vendor/:vendor_id/reorder-suggestions', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const lookbackDays = parsePositiveIntParam(req.query.days, 14, { min: 1, max: 120 });
    const coverageDays = parsePositiveIntParam(req.query.coverage_days, 7, { min: 1, max: 60 });
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - lookbackDays);

    const items = await prisma.food_item.findMany({
      where: { vendor_id: vendorId },
      select: {
        food_item_id: true,
        name: true,
        is_available: true,
        stock_qty: true,
        low_stock_threshold: true,
        expiry_date: true,
      },
      orderBy: { name: 'asc' },
    });
    if (!items.length) {
      return res.json({ successful: true, data: { lookback_days: lookbackDays, coverage_days: coverageDays, suggestions: [] } });
    }

    const itemIds = items.map((item) => item.food_item_id);
    const sales = await prisma.food_order_items.groupBy({
      by: ['food_item_id'],
      where: {
        food_item_id: { in: itemIds },
        food_order: {
          vendor_id: vendorId,
          order_status: { in: ['delivered', 'completed', 'reconciled'] },
          created_at: { gte: since },
        },
      },
      _sum: { qty: true },
    });
    const soldByItem = new Map(sales.map((row) => [row.food_item_id, Number(row._sum?.qty || 0)]));
    const suggestions = items.map((item) => {
      const stockQty = item.stock_qty == null ? null : Number(item.stock_qty);
      const threshold = item.low_stock_threshold == null ? 0 : Number(item.low_stock_threshold);
      const soldQty = soldByItem.get(item.food_item_id) || 0;
      const avgDailySales = soldQty / lookbackDays;
      const targetStock = Math.ceil(avgDailySales * coverageDays) + Math.max(0, threshold || 0);
      const suggestedReorderQty = stockQty == null
        ? (soldQty > 0 ? targetStock : 0)
        : Math.max(0, targetStock - stockQty);
      const alerts = inventoryAlertForItem(item);
      return {
        food_item_id: item.food_item_id,
        name: item.name,
        is_available: item.is_available,
        stock_qty: stockQty,
        low_stock_threshold: item.low_stock_threshold,
        expiry_date: item.expiry_date,
        sold_qty: soldQty,
        avg_daily_sales: Number(avgDailySales.toFixed(2)),
        target_stock: targetStock,
        suggested_reorder_qty: suggestedReorderQty,
        alerts,
        reason: suggestedReorderQty > 0
          ? (soldQty > 0 ? 'recent_sales_and_stock' : 'stock_below_threshold')
          : 'stock_sufficient',
      };
    }).sort((a, b) => {
      if (b.suggested_reorder_qty !== a.suggested_reorder_qty) return b.suggested_reorder_qty - a.suggested_reorder_qty;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return res.json({
      successful: true,
      data: {
        lookback_days: lookbackDays,
        coverage_days: coverageDays,
        suggestions,
      },
    });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to load reorder suggestions.');
  }
});

router.get('/vendor/:vendor_id/substitution-recommendations', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const itemId = Number(req.query.item_id);
    const query = String(req.query.q || req.query.item_name || '').trim();
    const limit = parsePositiveIntParam(req.query.limit, 8, { min: 1, max: 20 });

    let source = null;
    if (Number.isInteger(itemId) && itemId > 0) {
      source = await prisma.food_item.findFirst({
        where: { food_item_id: itemId, vendor_id: vendorId },
        select: {
          food_item_id: true,
          food_category_id: true,
          name: true,
          description: true,
          price: true,
        },
      });
      if (!source) return res.status(404).json({ successful: false, message: 'Unavailable item was not found for this store.' });
    } else if (query) {
      source = {
        food_item_id: null,
        food_category_id: null,
        name: query,
        description: '',
        price: Number.isFinite(Number(req.query.price)) ? Number(req.query.price) : null,
      };
    } else {
      return res.status(400).json({ successful: false, message: 'item_id or item_name is required.' });
    }

    const candidates = await prisma.food_item.findMany({
      where: {
        vendor_id: vendorId,
        is_available: true,
        ...(source.food_item_id ? { food_item_id: { not: source.food_item_id } } : {}),
        OR: [
          { stock_qty: null },
          { stock_qty: { gt: 0 } },
        ],
      },
      select: {
        food_item_id: true,
        food_category_id: true,
        name: true,
        description: true,
        price: true,
        stock_qty: true,
        low_stock_threshold: true,
        food_category: { select: { name: true } },
        food_item_pics: { select: { url: true }, take: 1, orderBy: { food_item_pics_id: 'asc' } },
      },
      orderBy: [{ food_category_id: 'asc' }, { name: 'asc' }],
      take: 200,
    });

    const recommendations = candidates
      .map((candidate) => {
        const match = grocerySubstitutionScore(source, candidate);
        return {
          food_item_id: candidate.food_item_id,
          name: candidate.name,
          description: candidate.description,
          category: candidate.food_category?.name || null,
          price: candidate.price,
          stock_qty: candidate.stock_qty,
          image_url: candidate.food_item_pics?.[0]?.url || null,
          price_delta: match.price_delta,
          recommendation_score: match.score,
          match_reasons: match.match_reasons,
        };
      })
      .filter((candidate) => candidate.recommendation_score > 0)
      .sort((a, b) => {
        if (b.recommendation_score !== a.recommendation_score) return b.recommendation_score - a.recommendation_score;
        const aDelta = a.price_delta == null ? Number.MAX_SAFE_INTEGER : Math.abs(a.price_delta);
        const bDelta = b.price_delta == null ? Number.MAX_SAFE_INTEGER : Math.abs(b.price_delta);
        return aDelta - bDelta;
      })
      .slice(0, limit);

    return res.json({ successful: true, data: { source, recommendations } });
  } catch (err) {
    console.error('[food] substitution recommendations failed:', err?.message || err);
    return foodRouteError(res, err, 'Failed to load substitution recommendations.');
  }
});

router.get('/vendor/:vendor_id/disputes', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const status = normalizeFoodDisputeStatus(req.query.status);
    const reason = normalizeFoodDisputeReason(req.query.reason);
    const disputes = await prisma.food_order_dispute.findMany({
      where: {
        vendor_id: vendorId,
        ...(status ? { status } : {}),
        ...(reason ? { reason } : {}),
      },
      include: {
        food_order: {
          select: {
            food_order_id: true,
            order_status: true,
            order_flow: true,
            total_amount: true,
            created_at: true,
            delivered_at: true,
          },
        },
        opened_by: { select: { user_id: true, name: true } },
        assigned_user: { select: { user_id: true, name: true } },
      },
      orderBy: [{ updated_at: 'desc' }, { dispute_id: 'desc' }],
      take: 200,
    });
    return res.json({ successful: true, data: disputes });
  } catch (err) {
    console.error('[food] vendor disputes failed:', err?.message || err);
    return foodRouteError(res, err, 'Failed to load disputes.');
  }
});

router.get('/vendor/:vendor_id/closures', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
    const closures = await prisma.food_vendor_closure.findMany({
      where: { vendor_id: vendorId, ...(includeInactive ? {} : { is_active: true }) },
      orderBy: [{ starts_at: 'asc' }, { closure_id: 'asc' }],
      take: 100,
    });
    return res.json({ successful: true, data: closures });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to load store closures.');
  }
});

router.post('/vendor/:vendor_id/closures', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const payload = normalizeClosurePayload(req.body);
    const closure = await prisma.food_vendor_closure.create({
      data: { vendor_id: vendorId, ...payload, is_active: true },
    });
    return res.status(201).json({ successful: true, data: closure });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to create store closure.');
  }
});

router.patch('/vendor/:vendor_id/closures/:closure_id', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const closureId = parseInt(req.params.closure_id, 10);
    if (!Number.isInteger(closureId) || closureId <= 0) {
      return res.status(400).json({ successful: false, error: 'Invalid closure id.' });
    }
    const existing = await prisma.food_vendor_closure.findFirst({ where: { closure_id: closureId, vendor_id: vendorId } });
    if (!existing) return res.status(404).json({ successful: false, error: 'Closure not found.' });
    const data = {};
    if (req.body.starts_at !== undefined || req.body.ends_at !== undefined || req.body.reason !== undefined) {
      const payload = normalizeClosurePayload({
        starts_at: req.body.starts_at ?? existing.starts_at,
        ends_at: req.body.ends_at ?? existing.ends_at,
        reason: req.body.reason ?? existing.reason,
      });
      Object.assign(data, payload);
    }
    const nextActive = normalizeOptionalBoolean(req.body.is_active, 'is_active');
    if (nextActive !== undefined) data.is_active = nextActive;
    if (Object.keys(data).length === 0) {
      return res.json({ successful: true, data: existing });
    }
    const closure = await prisma.food_vendor_closure.update({
      where: { closure_id: closureId },
      data,
    });
    return res.json({ successful: true, data: closure });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to update store closure.');
  }
});

router.delete('/vendor/:vendor_id/closures/:closure_id', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const closureId = parseInt(req.params.closure_id, 10);
    if (!Number.isInteger(closureId) || closureId <= 0) {
      return res.status(400).json({ successful: false, error: 'Invalid closure id.' });
    }
    const updated = await prisma.food_vendor_closure.updateMany({
      where: { closure_id: closureId, vendor_id: vendorId },
      data: { is_active: false },
    });
    if (updated.count !== 1) return res.status(404).json({ successful: false, error: 'Closure not found.' });
    return res.json({ successful: true, message: 'Store closure removed.' });
  } catch (err) {
    console.error(err);
    return foodRouteError(res, err, 'Failed to remove store closure.');
  }
});

router.post('/vendor/:vendor_id/items/import.csv', authenticateToken, inventoryCsvUploadMiddleware, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    const vendor = await assertInventoryVendorAccess(req, vendorId);
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ successful: false, error: 'CSV file is required.' });
    }
    const rows = parseCsvText(req.file.buffer.toString('utf8'));
    if (rows.length < 2) {
      return res.status(400).json({ successful: false, error: 'CSV must include a header row and at least one item.' });
    }
    if (rows.length > 501) {
      return res.status(400).json({ successful: false, error: 'CSV import is limited to 500 items at a time.' });
    }
    const header = rows[0].map((cell) => String(cell || '').trim().toLowerCase());
    const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
    const missing = ['name', 'price'].filter((column) => indexes[column] === undefined);
    if (missing.length) {
      return res.status(400).json({ successful: false, error: `Missing required CSV column: ${missing.join(', ')}` });
    }
    const existingIds = rows.slice(1)
      .map((row) => String(row[indexes.food_item_id] || '').trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter(Number.isInteger);
    const existingItems = existingIds.length
      ? await prisma.food_item.findMany({ where: { food_item_id: { in: existingIds }, vendor_id: vendorId }, select: { food_item_id: true } })
      : [];
    const existingSet = new Set(existingItems.map((item) => item.food_item_id));
    const actions = [];
    const errors = [];
    for (const [offset, row] of rows.slice(1).entries()) {
      const rowNumber = offset + 2;
      const value = (column) => indexes[column] === undefined ? undefined : String(row[indexes[column]] ?? '').trim();
      try {
        const idText = value('food_item_id');
        const foodItemId = idText ? Number(idText) : null;
        if (idText && !Number.isInteger(foodItemId)) throw new Error('food_item_id must be a whole number.');
        if (foodItemId && !existingSet.has(foodItemId)) throw new Error('food_item_id does not belong to this vendor.');
        const name = value('name');
        if (!name) throw new Error('name is required.');
        const priceText = value('price');
        if (priceText === '') throw new Error('price is required.');
        const price = Number(priceText);
        if (!Number.isFinite(price) || price < 0) throw new Error('price must be a non-negative number.');
        const foodCategoryText = value('food_category_id');
        const foodCategoryId = foodCategoryText === undefined || foodCategoryText === '' ? null : Number(foodCategoryText);
        if (foodCategoryText && !Number.isInteger(foodCategoryId)) throw new Error('food_category_id must be a whole number.');
        if (foodCategoryId != null) {
          const catResult = await resolveFoodCategoryId(foodCategoryId, {
            vendorId,
            vendorTypeId: vendor.vendor_type_id ?? null,
          });
          if (catResult.error) throw new Error(catResult.error);
        }
        const stockQty = parseOptionalStockQty(value('stock_qty'));
        const lowStockThreshold = parseOptionalLowStockThreshold(value('low_stock_threshold'));
        const expiryDate = parseOptionalExpiryDate(value('expiry_date'));
        const available = normalizeInventoryCsvBool(value('is_available'));
        actions.push({
          foodItemId,
          imageUrl: value('image_url'),
          data: {
            vendor_id: vendorId,
            food_category_id: foodCategoryId,
            name,
            description: value('description') || null,
            price,
            is_available: stockQty === 0 ? false : (available ?? true),
            stock_qty: stockQty === undefined ? null : stockQty,
            low_stock_threshold: lowStockThreshold === undefined ? null : lowStockThreshold,
            expiry_date: expiryDate === undefined ? null : expiryDate,
            vendor_type_id: vendor.vendor_type_id ?? null,
            allergen_info: value('allergen_info') || null,
          },
        });
      } catch (err) {
        errors.push({ row: rowNumber, message: err.message || 'Invalid row.' });
      }
    }
    if (errors.length) {
      return res.status(400).json({ successful: false, errors });
    }
    const result = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const action of actions) {
        const item = action.foodItemId
          ? await tx.food_item.update({ where: { food_item_id: action.foodItemId }, data: action.data })
          : await tx.food_item.create({ data: action.data });
        if (action.foodItemId) updated += 1;
        else created += 1;
        if (action.imageUrl !== undefined) {
          await tx.food_item_pics.deleteMany({ where: { food_item_id: item.food_item_id } });
          if (action.imageUrl) {
            await tx.food_item_pics.create({
              data: {
                food_item_id: item.food_item_id,
                url: action.imageUrl,
                vendor_type_id: vendor.vendor_type_id ?? null,
              },
            });
          }
        }
      }
      return { created, updated };
    });
    return res.json({ successful: true, data: result });
  } catch (err) {
    console.error(err);
    return res.status(err.statusCode || 500).json({ successful: false, error: err.message || 'Failed to import inventory.' });
  }
});

//======================================================================================================
//======================================== FOOD ITEM MODIFIERS ========================================
//======================================================================================================
// Server-owned modifier catalog (groups + priced options). The option_id is the
// stable key the checkout sends per line so the payment route prices modifiers
// EXACTLY (see resolveLinePrices in payment-routes.js). This replaced the old
// client-only (localStorage) modifier data, which had no server price source and
// forced food carts to a price FLOOR.

/* GET MODIFIERS FOR AN ITEM — public (storefront loads these to render options) */
router.get('/items/:id/modifiers', async (req, res) => {
  try {
    const groups = await prisma.food_item_modifier_group.findMany({
      where: { food_item_id: parseInt(req.params.id) },
      orderBy: { sort_order: 'asc' },
      include: { options: { orderBy: { sort_order: 'asc' } } },
    });
    res.json(groups);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.fetchFailed', { resource: FOOD_ITEM });
  }
});

/* REPLACE MODIFIERS FOR AN ITEM — vendor only, ownership-checked.
   Accepts the full desired set of groups/options. Existing group_id/option_id are
   preserved when sent (so already-purchasable ids stay stable); omitted ones are
   deleted; new ones (no id) are created. Whole replace runs in one transaction.
   Body: { groups: [{ group_id?, name, min_select?, max_select?, sort_order?,
                       options: [{ option_id?, name, price, is_available?, sort_order? }] }] } */
router.put('/items/:id/modifiers', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const food_item_id = parseInt(req.params.id);

    // Ownership: the item must belong to the authenticated vendor.
    const item = await prisma.food_item.findUnique({
      where: { food_item_id },
      select: { food_item_id: true, vendor_id: true },
    });
    if (!item) return sendError(res, 404, req, 'errors.notFound', { resource: FOOD_ITEM });
    if (item.vendor_id !== req.foodVendor.vendor_id) {
      return res.status(403).json({ successful: false, error: 'You do not own this item.' });
    }

    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];

    await prisma.$transaction(async (tx) => {
      const existingGroups = await tx.food_item_modifier_group.findMany({
        where: { food_item_id },
        select: { group_id: true },
      });
      const existingGroupIds = new Set(existingGroups.map((g) => g.group_id));
      const keptGroupIds = new Set();

      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const groupData = {
          name: g.name ?? null,
          min_select: g.min_select != null ? parseInt(g.min_select) : 0,
          max_select: g.max_select != null ? parseInt(g.max_select) : null,
          sort_order: g.sort_order != null ? parseInt(g.sort_order) : gi,
        };

        let groupId;
        if (g.group_id != null && existingGroupIds.has(parseInt(g.group_id))) {
          groupId = parseInt(g.group_id);
          await tx.food_item_modifier_group.update({ where: { group_id: groupId }, data: groupData });
        } else {
          const created = await tx.food_item_modifier_group.create({ data: { ...groupData, food_item_id } });
          groupId = created.group_id;
        }
        keptGroupIds.add(groupId);

        // Diff options within this group.
        const opts = Array.isArray(g.options) ? g.options : [];
        const existingOpts = await tx.food_item_modifier_option.findMany({
          where: { group_id: groupId },
          select: { option_id: true },
        });
        const existingOptIds = new Set(existingOpts.map((o) => o.option_id));
        const keptOptIds = new Set();

        for (let oi = 0; oi < opts.length; oi++) {
          const o = opts[oi];
          const optData = {
            name: o.name ?? null,
            price: o.price != null ? parseFloat(o.price) : 0,
            is_available: o.is_available !== false,
            sort_order: o.sort_order != null ? parseInt(o.sort_order) : oi,
          };
          if (o.option_id != null && existingOptIds.has(parseInt(o.option_id))) {
            const oid = parseInt(o.option_id);
            await tx.food_item_modifier_option.update({ where: { option_id: oid }, data: optData });
            keptOptIds.add(oid);
          } else {
            await tx.food_item_modifier_option.create({ data: { ...optData, group_id: groupId } });
          }
        }
        const optToDelete = [...existingOptIds].filter((id) => !keptOptIds.has(id));
        if (optToDelete.length) {
          await tx.food_item_modifier_option.deleteMany({ where: { option_id: { in: optToDelete } } });
        }
      }

      // Delete groups (and their options) the seller removed.
      const groupsToDelete = [...existingGroupIds].filter((id) => !keptGroupIds.has(id));
      if (groupsToDelete.length) {
        await tx.food_item_modifier_option.deleteMany({ where: { group_id: { in: groupsToDelete } } });
        await tx.food_item_modifier_group.deleteMany({ where: { group_id: { in: groupsToDelete } } });
      }
    });

    const result = await prisma.food_item_modifier_group.findMany({
      where: { food_item_id },
      orderBy: { sort_order: 'asc' },
      include: { options: { orderBy: { sort_order: 'asc' } } },
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.updateFailed', { resource: FOOD_ITEM });
  }
});

//======================================================================================================
//========================================== FOOD ITEM PICS =========================================
//======================================================================================================

/* GET ALL FOOD ITEM PICS */
router.get('/item-pics', async (_req, res) => {
  try {
    const pics = await prisma.food_item_pics.findMany({
      orderBy: { food_item_pics_id: 'desc' },
      include: {
        food_item: true,
        vendor_type: true,
      },
    });
    res.json(pics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food item pics' });
  }
});

/* GET FOOD ITEM PIC BY ID */
router.get('/item-pics/:id', async (req, res) => {
  try {
    const pic = await prisma.food_item_pics.findUnique({
      where: { food_item_pics_id: parseInt(req.params.id) },
      include: {
        food_item: true,
        vendor_type: true,
      },
    });
    
    if (!pic) {
      return res.status(404).json({ error: 'Food item pic not found' });
    }
    
    res.json(pic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food item pic' });
  }
});

/* CREATE FOOD ITEM PIC */
router.post('/item-pics', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { food_item_id, url, vendor_type_id } = req.body;
    
    const pic = await prisma.food_item_pics.create({
      data: {
        food_item_id: food_item_id ? parseInt(food_item_id) : null,
        url,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : null,
      },
    });
    
    res.status(201).json(pic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create food item pic' });
  }
});

/* UPDATE FOOD ITEM PIC */
router.put('/item-pics/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { food_item_id, url, vendor_type_id } = req.body;
    
    const pic = await prisma.food_item_pics.update({
      where: { food_item_pics_id: parseInt(req.params.id) },
      data: {
        food_item_id: food_item_id ? parseInt(food_item_id) : undefined,
        url,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : undefined,
      },
    });
    
    res.json(pic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update food item pic' });
  }
});

/* DELETE FOOD ITEM PIC */
router.delete('/item-pics/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    await prisma.food_item_pics.delete({
      where: { food_item_pics_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Food item pic deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete food item pic' });
  }
});

/**
 * Task D2: Get Available Food/Grocery Orders for Delivery Drivers
 * GET /food/orders/available
 * Optional query params: lat, long, radius_km (default 10)
 */
router.get('/orders/available', authenticateToken, async (req, res) => {
  try {
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) {
      return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    }

    const driverLat = parseOptionalFiniteNumber(req.query.lat) ?? parseOptionalFiniteNumber(driverRecord.current_lat);
    const driverLong = parseOptionalFiniteNumber(req.query.long) ?? parseOptionalFiniteNumber(driverRecord.current_long);
    const radius = parseRadiusKm(req.query.radius_km);

    // Never serialize otp_code / payment_intent_id on the offer list (proof-of-delivery + payment).
    const courierWhere = await resolveFoodCourierDispatchWhere(prisma);
    const availableOrders = await prisma.food_order.findMany({
      where: {
        order_status: 'confirmed',
        driver_id: null,
        ...courierWhere,
      },
      select: {
        food_order_id: true,
        order_status: true,
        order_flow: true,
        total_amount: true,
        delivery_fee: true,
        driver_earning: true,
        tip_amount: true,
        created_at: true,
        scheduled_time: true,
        delivery_window_start: true,
        delivery_window_end: true,
        store_accepted_at: true,
        packed_at: true,
        ready_for_pickup_at: true,
        driver_id: true,
        driver_accepted_at: true,
        driver_en_route_at: true,
        picked_up_at: true,
        delivered_at: true,
        delivery_proof: true,
        delivery_proof_at: true,
        delivery_preference: true,
        delivery_delay_reason: true,
        delivery_failure_resolution: true,
        delivery_proof_requirements: true,
        batch_id: true,
        last_update: true,
        grocery_substitutions: true,
        delivery_offer_events: true,
        payment_method: true,
        deliver_location: true,
        fulfillment_mode: true,
        delivery_instructions: true,
        vendor_type: { select: { vendor_type: true } },
        food_vendor: {
          select: {
            vendor_name: true,
            location: true,
            cuisine_type: true,
            lat: true,
            long: true,
            vendor_type: { select: { vendor_type: true } },
          }
        },
        user: {
          select: {
            name: true
          }
        },
        food_order_items: {
          select: {
            food_order_detail_id: true,
            qty: true,
            price_item: true,
            food_item: {
              select: {
                name: true,
                allergen_info: true,
                food_category: { select: { name: true } },
              }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    let filtered = availableOrders;
    if (driverLat !== null && driverLong !== null) {
      filtered = availableOrders.filter(order => {
        const vendorLat = order.food_vendor?.lat ?? null;
        const vendorLong = order.food_vendor?.long ?? null;
        if (vendorLat == null || vendorLong == null) return true;
        return haversineKm(driverLat, driverLong, vendorLat, vendorLong) <= radius;
      });
    }

    return res.json({
      successful: true,
      count: filtered.length,
      data: filtered.map((order) => ({
        ...(isGroceryOrder(order) ? serializeGroceryDeliveryOrder(order, driverRecord) : order),
        deliver_location: publicDeliverLocation(order),
        fulfillment_mode: isFoodPickupOrder(order) ? 'pickup' : 'delivery',
      })),
    });

  } catch (err) {
    console.error('Available Orders Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});



/**
 * Task D3: Accept a Delivery Order
 * PUT /food/orders/:order_id/accept
 */
router.put('/orders/:order_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    // Driver identity comes from the JWT, never the request body — otherwise any
    // authenticated driver could claim an order under someone else's driver_id.
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const driver_id = driverRecord.driver_id;

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.food_order.findUnique({
        where: { food_order_id: order_id },
        include: ORDER_FLOW_INCLUDE,
      });
      if (!existing) throw new Error('ORDER_ALREADY_TAKEN');
      const acceptedStatus = isGroceryOrder(existing) ? 'dispatched' : null;

      // Dispatch stamps driver_id onto the offered candidate immediately. Accept means matching
      // *your own* live offer. Kitchen status may already be preparing / ready_for_pickup because
      // the vendor advances independently of the courier hand-off — never require `confirmed`.
      const current = await tx.food_order.findFirst({
        where: {
          food_order_id: order_id,
          order_status: { in: foodCourierOfferableStatuses() },
          driver_id,
          offer_expires_at: { gt: new Date() },
        },
      });
      if (!current) {
        throw new Error('ORDER_ALREADY_TAKEN');
      }
      const nextStatus = acceptedStatus || (current.order_status === 'confirmed' ? 'preparing' : current.order_status);
      const accepted = await tx.food_order.updateMany({
        where: {
          food_order_id: order_id,
          order_status: { in: foodCourierOfferableStatuses() },
          driver_id,
          offer_expires_at: { gt: new Date() },
        },
        data: {
          order_status: nextStatus,
          offer_expires_at: null,
          driver_accepted_at: new Date(),
          driver_earning: isGroceryOrder(existing) ? (existing.driver_earning ?? groceryDriverEarning(existing)) : existing.driver_earning,
          last_update: new Date(),
        },
      });
      if (accepted.count === 0) {
        throw new Error('ORDER_ALREADY_TAKEN');
      }

      return await tx.food_order.findUnique({ where: { food_order_id: order_id }, include: ORDER_FLOW_INCLUDE });
    });


    io.to(`user-${result.user_id}`).emit(`order-accepted-${result.food_order_id}`, {
      message: isGroceryOrder(result) ? "A delivery partner is heading to the store." : "A delivery partner has been assigned!",
      driver_id: driver_id
    });
    emitOrderStatus(io, result, result.order_status, {
      driver_id,
      message: isGroceryOrder(result) ? 'Your delivery partner is heading to the store.' : 'A delivery partner has been assigned.',
    });
    notifyFoodCustomer(io, {
      userId: result.user_id, orderId: result.food_order_id, status: result.order_status,
      flow: orderFlow(result),
      body: isGroceryOrder(result) ? 'Your delivery partner is heading to the store.' : 'A delivery partner has been assigned.',
    });

    try {
      const { syncFoodOrderChatMembers } = await import('../services/chat-context-service.js');
      await syncFoodOrderChatMembers(result.food_order_id);
    } catch (chatErr) {
      console.error('Food chat member sync failed:', chatErr.message);
    }

    return res.json({
      successful: true,
      message: 'Order accepted for delivery',
      data: isGroceryOrder(result) ? serializeGroceryDeliveryOrder(result, driverRecord) : result,
    });

  } catch (err) {
    if (err.message === 'ORDER_ALREADY_TAKEN') {
      return sendError(res, 409, req, 'food.orderAlreadyTaken');
    }
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

/**
 * Task D3b: Add a same-vendor order to the driver's current run (order batching, v1).
 * The driver must already have a non-terminal order from the SAME vendor — this is a direct
 * driver-initiated claim, not a dispatch offer, so there's no offer_expires_at window.
 * PUT /food/orders/:order_id/claim-additional
 */
router.put('/orders/:order_id/claim-additional', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const driver_id = driverRecord.driver_id;

    const activeOrder = await prisma.food_order.findFirst({
      where: {
        driver_id,
        OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
      },
      orderBy: { food_order_id: 'asc' },
    });
    if (!activeOrder) {
      return res.status(409).json({ successful: false, message: 'No active order to add this one to — accept an order first.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.food_order.findUnique({
        where: { food_order_id: order_id },
        include: ORDER_FLOW_INCLUDE,
      });
      if (!existing) throw new Error('ORDER_NOT_CLAIMABLE');
      const nextStatus = isGroceryOrder(existing) ? 'dispatched' : 'preparing';
      if (isGroceryOrder(existing)) {
        const capacity = await canDriverHandleFoodOrder(tx, driver_id, existing);
        if (!capacity.ok) {
          const err = new Error('DRIVER_CAPACITY_MISMATCH');
          err.statusCode = 409;
          throw err;
        }
      }
      let batch_id = activeOrder.batch_id;
      if (!batch_id) {
        const batch = await tx.delivery_batch.create({ data: { driver_profile_id: driver_id, vertical: 'food' } });
        batch_id = batch.batch_id;
        await tx.food_order.update({ where: { food_order_id: activeOrder.food_order_id }, data: { batch_id } });
      }
      let deliveryProfile = null;
      if (isGroceryOrder(existing)) {
        deliveryProfile = await tx.driver_delivery_profile.findUnique({
          where: { driver_profile_id: driver_id },
          select: { max_batch_orders: true, max_batch_distance_km: true },
        });
        const maxBatchOrders = Math.max(1, Number(deliveryProfile?.max_batch_orders) || 1);
        const activeBatchCount = await tx.food_order.count({
          where: {
            batch_id,
            OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
          },
        });
        if (activeBatchCount + 1 > maxBatchOrders) {
          const err = new Error('BATCH_CAPACITY_EXCEEDED');
          err.statusCode = 409;
          throw err;
        }
      }

      // Same atomic-guard shape as /accept: only succeeds if the order is still unclaimed and
      // from the same vendor as the driver's existing run.
      const courierWhere = await resolveFoodCourierDispatchWhere(prisma);
      const claimed = await tx.food_order.updateMany({
        where: {
          food_order_id: order_id,
          order_status: { in: foodCourierOfferableStatuses() },
          driver_id: null,
          vendor_id: activeOrder.vendor_id,
          ...courierWhere,
        },
        data: {
          order_status: nextStatus,
          driver_id,
          batch_id,
          offer_expires_at: null,
          driver_accepted_at: new Date(),
          driver_earning: isGroceryOrder(existing) ? (existing.driver_earning ?? groceryDriverEarning(existing)) : existing.driver_earning,
          last_update: new Date(),
        },
      });

      if (claimed.count === 0) {
        throw new Error('ORDER_NOT_CLAIMABLE');
      }
      if (isGroceryOrder(existing)) {
        const routePlan = await refreshFoodDeliveryBatchRoutePlan(tx, batch_id, driver_id);
        const maxBatchDistanceKm = Number(deliveryProfile?.max_batch_distance_km);
        if (Number.isFinite(maxBatchDistanceKm) && maxBatchDistanceKm > 0 && routePlan?.complete && routePlan.total_distance_km > maxBatchDistanceKm) {
          const err = new Error('BATCH_ROUTE_TOO_LONG');
          err.statusCode = 409;
          throw err;
        }
      }

      return tx.food_order.findUnique({ where: { food_order_id: order_id }, include: ORDER_FLOW_INCLUDE });
    });

    io.to(`user-${result.user_id}`).emit(`order-accepted-${result.food_order_id}`, {
      message: isGroceryOrder(result) ? 'A delivery partner is heading to the store.' : 'A delivery partner has been assigned!',
      driver_id,
    });
    emitOrderStatus(io, result, result.order_status, {
      driver_id,
      message: isGroceryOrder(result) ? 'Your delivery partner is heading to the store.' : 'A delivery partner has been assigned.',
    });
    notifyFoodCustomer(io, {
      userId: result.user_id, orderId: result.food_order_id, status: result.order_status,
      flow: orderFlow(result),
      body: isGroceryOrder(result) ? 'Your delivery partner is heading to the store.' : 'A delivery partner has been assigned.',
    });

    try {
      const { syncFoodOrderChatMembers } = await import('../services/chat-context-service.js');
      await syncFoodOrderChatMembers(result.food_order_id);
    } catch (chatErr) {
      console.error('Food chat member sync failed:', chatErr.message);
    }

    return res.json({
      successful: true,
      message: 'Order added to your current run',
      data: isGroceryOrder(result) ? serializeGroceryDeliveryOrder(result, driverRecord) : result,
    });

  } catch (err) {
    if (err.message === 'ORDER_NOT_CLAIMABLE') {
      return res.status(409).json({ successful: false, message: 'This order is no longer available, or is from a different vendor than your current run.' });
    }
    if (err.message === 'BATCH_CAPACITY_EXCEEDED') {
      return res.status(409).json({ successful: false, message: 'This order would exceed your active delivery batch capacity.' });
    }
    if (err.message === 'BATCH_ROUTE_TOO_LONG') {
      return res.status(409).json({ successful: false, message: 'This order would make the delivery route longer than your batch distance limit.' });
    }
    if (err.message === 'DRIVER_CAPACITY_MISMATCH') {
      return res.status(409).json({ successful: false, message: 'This order requires delivery capacity that is not enabled on your driver profile.' });
    }
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.get('/delivery-runs/:batch_id/offers', authenticateToken, async (req, res) => {
  try {
    const batch_id = Number(req.params.batch_id);
    if (!Number.isInteger(batch_id) || batch_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid delivery run id' });
    }
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const offers = await prisma.delivery_run_offer.findMany({
      where: {
        batch_id,
        driver_profile_id: driverRecord.driver_id,
        status: 'pending',
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ successful: true, data: offers });
  } catch (err) {
    console.error('[delivery-runs] list offers failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not load delivery run offers' });
  }
});

router.post('/delivery-runs/:batch_id/suggestions', authenticateToken, async (req, res) => {
  try {
    const batch_id = Number(req.params.batch_id);
    const limit = Number(req.body?.limit || req.query?.limit || 5);
    if (!Number.isInteger(batch_id) || batch_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid delivery run id' });
    }
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const result = await suggestDeliveryRunOffers(prisma, batch_id, driverRecord.driver_id, limit);
    if (!result.ok) return res.status(404).json({ successful: false, message: result.reason || 'Active delivery run not found' });
    const io = req.app.get('io');
    for (const offer of result.offers) {
      io?.to(`user-${req.user.user_id}`).emit('delivery-run-offer', offer);
    }
    return res.json({ successful: true, data: result.offers });
  } catch (err) {
    console.error('[delivery-runs] suggestions failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not suggest delivery run add-ons' });
  }
});

router.post('/delivery-runs/:batch_id/offers', authenticateToken, async (req, res) => {
  try {
    const batch_id = Number(req.params.batch_id);
    const orderType = String(req.body?.order_type || '').trim();
    const orderId = Number(req.body?.order_id);
    if (!Number.isInteger(batch_id) || batch_id <= 0 || !['food_order', 'courier_order'].includes(orderType) || !Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid delivery run offer request' });
    }
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const batch = await prisma.delivery_batch.findFirst({
      where: { batch_id, driver_profile_id: driverRecord.driver_id, status: 'active' },
      select: { batch_id: true },
    });
    if (!batch) return res.status(404).json({ successful: false, message: 'Active delivery run not found' });

    const result = await createDeliveryRunOffer(prisma, batch_id, driverRecord.driver_id, orderType, orderId);
    if (!result.ok) return res.status(409).json({ successful: false, message: result.reason || 'Order is not compatible with this delivery run' });
    const io = req.app.get('io');
    io?.to(`user-${req.user.user_id}`).emit('delivery-run-offer', result.offer);
    return res.status(201).json({ successful: true, data: result.offer });
  } catch (err) {
    console.error('[delivery-runs] create offer failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not create delivery run offer' });
  }
});

router.patch('/delivery-runs/offers/:offer_id', authenticateToken, async (req, res) => {
  try {
    const offerId = Number(req.params.offer_id);
    const action = String(req.body?.action || req.body?.status || '').toLowerCase();
    if (!Number.isInteger(offerId) || offerId <= 0 || !['accepted', 'rejected'].includes(action)) {
      return res.status(400).json({ successful: false, message: 'Offer action must be accepted or rejected' });
    }
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    const result = await prisma.$transaction((tx) => decideDeliveryRunOffer(tx, offerId, driverRecord.driver_id, action, req.body?.reason));
    if (!result.ok) return res.status(409).json({ successful: false, message: result.reason || 'Delivery run offer is no longer available' });
    const io = req.app.get('io');
    io?.to(`driver-${driverRecord.driver_id}`).emit('delivery-batch-updated', {
      batch_id: result.offer.batch_id,
      order_type: result.offer.order_type,
      order_id: result.offer.order_id,
      route_plan: result.route_plan || null,
    });
    return res.json({ successful: true, data: result.offer, route_plan: result.route_plan || null });
  } catch (err) {
    console.error('[delivery-runs] decide offer failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not update delivery run offer' });
  }
});

router.get('/admin/delivery-runs', authenticateToken, async (req, res) => {
  try {
    if (!isFoodAdmin(req.user)) return res.status(403).json({ successful: false, message: 'Admin access required' });
    const runs = await prisma.delivery_batch.findMany({
      where: { status: { in: ['active', 'delayed', 'failed'] } },
      include: {
        driver_profile: { select: { driver_profile_id: true, user_id: true, current_lat: true, current_long: true, last_ping: true, rating: true } },
        food_order: { include: ORDER_FLOW_INCLUDE },
        courier_order: true,
        delivery_run_offer: { orderBy: { created_at: 'desc' } },
      },
      orderBy: { updated_at: 'desc' },
      take: 100,
    });
    return res.json({ successful: true, data: runs });
  } catch (err) {
    console.error('[delivery-runs] admin list failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not load delivery runs' });
  }
});

router.patch('/admin/delivery-runs/:batch_id/unbundle', authenticateToken, async (req, res) => {
  try {
    if (!isFoodAdmin(req.user)) return res.status(403).json({ successful: false, message: 'Admin access required' });
    const batch_id = Number(req.params.batch_id);
    const orderType = String(req.body?.order_type || '').trim();
    const orderId = Number(req.body?.order_id);
    if (!Number.isInteger(batch_id) || batch_id <= 0 || !['food_order', 'courier_order'].includes(orderType) || !Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid unbundle request' });
    }
    const result = await prisma.$transaction(async (tx) => {
      let changed;
      if (orderType === 'food_order') {
        changed = await tx.food_order.updateMany({ where: { food_order_id: orderId, batch_id }, data: { batch_id: null } });
      } else {
        changed = await tx.courier_order.updateMany({ where: { courier_order_id: orderId, batch_id }, data: { batch_id: null } });
      }
      if (changed.count === 0) {
        const err = new Error('ORDER_NOT_IN_DELIVERY_RUN');
        err.statusCode = 404;
        throw err;
      }
      await tx.delivery_run_offer.updateMany({
        where: { batch_id, order_type: orderType, order_id: orderId, status: 'pending' },
        data: { status: 'cancelled', rejection_reason: 'admin_unbundled', decided_at: new Date() },
      });
      const batch = await tx.delivery_batch.findUnique({ where: { batch_id }, select: { driver_profile_id: true } });
      return refreshFoodDeliveryBatchRoutePlan(tx, batch_id, batch?.driver_profile_id);
    });
    return res.json({ successful: true, data: result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: 'Delivery order was not found in this run' });
    console.error('[delivery-runs] admin unbundle failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not unbundle delivery order' });
  }
});

router.patch('/admin/delivery-runs/:batch_id/reassign', authenticateToken, async (req, res) => {
  try {
    if (!isFoodAdmin(req.user)) return res.status(403).json({ successful: false, message: 'Admin access required' });
    const batch_id = Number(req.params.batch_id);
    const orderType = String(req.body?.order_type || '').trim();
    const orderId = Number(req.body?.order_id);
    const nextDriverId = Number(req.body?.driver_profile_id || req.body?.driver_id);
    if (
      !Number.isInteger(batch_id) || batch_id <= 0
      || !['food_order', 'courier_order'].includes(orderType)
      || !Number.isInteger(orderId) || orderId <= 0
      || !Number.isInteger(nextDriverId) || nextDriverId <= 0
    ) {
      return res.status(400).json({ successful: false, message: 'Invalid delivery reassignment request' });
    }
    const io = req.app.get('io');
    let newBatchId = null;
    if (orderType === 'food_order') {
      const order = await prisma.food_order.findFirst({ where: { food_order_id: orderId, batch_id }, include: ORDER_FLOW_INCLUDE });
      if (!order || ['delivered', 'cancelled'].includes(String(order.order_status || '').toLowerCase())) {
        return res.status(409).json({ successful: false, message: 'This food order cannot be reassigned.' });
      }
      if (isGroceryOrder(order)) {
        const capacity = await canDriverHandleFoodOrder(prisma, nextDriverId, order);
        if (!capacity.ok) {
          return res.status(409).json({ successful: false, message: 'Selected driver cannot handle this grocery order capacity.' });
        }
      }
      const result = await prisma.$transaction(async (tx) => {
        const batch = await tx.delivery_batch.create({ data: { driver_profile_id: nextDriverId, vertical: 'food' } });
        const claimed = await tx.food_order.updateMany({
          where: {
            food_order_id: orderId,
            batch_id,
            OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
          },
          data: {
            driver_id: nextDriverId,
            batch_id: batch.batch_id,
            offer_expires_at: null,
            driver_accepted_at: order.driver_accepted_at || new Date(),
            last_update: new Date(),
          },
        });
        if (claimed.count === 0) {
          const err = new Error('REASSIGN_CLAIM_FAILED');
          err.statusCode = 409;
          throw err;
        }
        await tx.delivery_run_offer.updateMany({
          where: { batch_id, order_type: orderType, order_id: orderId, status: 'pending' },
          data: { status: 'cancelled', rejection_reason: 'admin_reassigned', decided_at: new Date() },
        });
        return batch;
      });
      newBatchId = result.batch_id;
      await refreshFoodDeliveryBatchRoutePlan(prisma, newBatchId, nextDriverId);
    } else if (orderType === 'courier_order') {
      const existing = await prisma.courier_order.findFirst({ where: { courier_order_id: orderId, batch_id } });
      if (!existing || ['delivered', 'cancelled'].includes(String(existing.status || '').toLowerCase())) {
        return res.status(409).json({ successful: false, message: 'This courier order cannot be reassigned.' });
      }
      const result = await prisma.$transaction(async (tx) => {
        const batch = await tx.delivery_batch.create({ data: { driver_profile_id: nextDriverId, vertical: 'courier' } });
        const claimed = await tx.courier_order.updateMany({
          where: { courier_order_id: orderId, batch_id, OR: [{ status: null }, { status: { notIn: ['delivered', 'cancelled'] } }] },
          data: {
            courier_service_provider_id: nextDriverId,
            batch_id: batch.batch_id,
            status: existing.status || 'accepted',
            last_update: new Date(),
          },
        });
        if (claimed.count === 0) {
          const err = new Error('REASSIGN_CLAIM_FAILED');
          err.statusCode = 409;
          throw err;
        }
        await tx.delivery_run_offer.updateMany({
          where: { batch_id, order_type: orderType, order_id: orderId, status: 'pending' },
          data: { status: 'cancelled', rejection_reason: 'admin_reassigned', decided_at: new Date() },
        });
        return batch;
      });
      newBatchId = result.batch_id;
      await refreshFoodDeliveryBatchRoutePlan(prisma, newBatchId, nextDriverId);
    }
    const oldBatch = await prisma.delivery_batch.findUnique({ where: { batch_id }, select: { driver_profile_id: true } });
    if (oldBatch?.driver_profile_id) await refreshFoodDeliveryBatchRoutePlan(prisma, batch_id, oldBatch.driver_profile_id);
    return res.json({ successful: true, message: 'Delivery order reassigned', data: { batch_id: newBatchId } });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ successful: false, message: 'Could not reassign this order to the selected driver' });
    console.error('[delivery-runs] admin reassign failed:', err);
    return res.status(500).json({ successful: false, message: 'Could not reassign delivery order' });
  }
});

/**
 * Driver declines their current delivery offer — moves it to the next nearest driver.
 * PUT /food/orders/:order_id/decline
 */
router.put('/orders/:order_id/decline', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.driver_id !== driverRecord.driver_id) {
      return res.status(409).json({ successful: false, message: 'This offer is no longer yours to decline' });
    }

    const result = await reofferDeliveryOrderAfterDecline(io, 'food_order', order_id, driverRecord.driver_id);
    return res.json({ successful: true, ...result });
  } catch (err) {
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

/**
 * Restaurant marks order as ready for driver pickup
 * PATCH /food/orders/:order_id/prepare
 */
router.patch('/orders/:order_id/prepare', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!['confirmed', 'preparing'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order cannot be marked ready now.' });
    }
    assertNoPendingGrocerySubstitutions(existing);

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        order_status: 'ready_for_pickup',
        ready_for_pickup_at: new Date(),
        last_update: new Date(),
      },
      include: ORDER_FLOW_INCLUDE,
    });

    io.to(`user-${updated.user_id}`).emit(`order-status-update-${order_id}`, { order_status: 'ready_for_pickup' });
    emitOrderStatus(io, updated, 'ready_for_pickup', {
      message: isGroceryOrder(updated) ? 'Your grocery order is packed and ready for pickup.' : 'Your order is ready for pickup.',
    });
    notifyFoodCustomer(io, { userId: updated.user_id, orderId: order_id, status: 'ready_for_pickup', flow: orderFlow(updated) });

    maybeDispatchFoodDelivery(io, updated);

    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        successful: false,
        message: err.message,
        pending_substitutions: err.pendingSubstitutions || undefined,
      });
    }
    console.error('Prepare Order Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Store accepts an order. Grocery delivery dispatch starts here so riders are not
 * assigned before the store has confirmed the order can be fulfilled.
 * PATCH /food/orders/:order_id/vendor-accept
 */
router.patch('/orders/:order_id/vendor-accept', authenticateToken, isFoodVendor, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }

    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (existing.order_status !== 'pending') {
      return res.status(409).json({ successful: false, message: 'Only pending orders can be accepted by the store.' });
    }

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        order_status: 'confirmed',
        order_flow: orderFlow(existing),
        store_accepted_at: new Date(),
        last_update: new Date(),
        driver_earning: isGroceryOrder(existing) ? groceryDriverEarning(existing) : existing.driver_earning,
      },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });

    emitOrderStatus(io, updated, 'confirmed', {
      message: isGroceryOrder(updated) ? 'The store accepted your grocery order.' : 'The restaurant confirmed your order.',
    });
    notifyFoodCustomer(io, {
      userId: updated.user_id,
      orderId: updated.food_order_id,
      status: 'confirmed',
      flow: orderFlow(updated),
    });

    if (isGroceryOrder(updated) && updated.deliver_location) {
      dispatchDeliveryOrder(io, 'food_order', updated.food_order_id).catch((err) =>
        console.error('[grocery] dispatch failed:', err.message));
    }

    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('Accept Order Error:', err);
    return res.status(err.statusCode || 500).json({ successful: false, message: clientErrorMessage(err, 'Failed to accept order.') });
  }
});

/**
 * Grocery store marks the order packed before final ready-for-pickup.
 * PATCH /food/orders/:order_id/packed
 */
router.patch('/orders/:order_id/packed', authenticateToken, isFoodVendor, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!isGroceryOrder(existing)) {
      return res.status(400).json({ successful: false, message: 'Packed status is only used for grocery orders.' });
    }
    if (!['confirmed', 'preparing'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This grocery order cannot be marked packed now.' });
    }

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { order_status: 'preparing', packed_at: new Date(), last_update: new Date() },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });
    emitOrderStatus(io, updated, 'preparing', { message: 'The store is packing your grocery order.' });
    notifyFoodCustomer(io, { userId: updated.user_id, orderId: updated.food_order_id, status: 'preparing', flow: 'grocery' });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('Pack Grocery Order Error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to mark order packed.' });
  }
});

/**
 * Grocery seller handoff checklist before rider pickup.
 * PATCH /food/orders/:order_id/handoff-checklist
 */
router.patch('/orders/:order_id/handoff-checklist', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!isGroceryOrder(existing)) {
      return res.status(400).json({ successful: false, message: 'Handoff checklist is only available for grocery orders.' });
    }
    if (['picked_up', 'delivered', 'cancelled'].includes(String(existing.order_status || '').toLowerCase())) {
      return res.status(409).json({ successful: false, message: 'This handoff checklist can no longer be changed.' });
    }

    const checklist = sanitizeSellerHandoffChecklist(req.body, existing.seller_handoff_checklist);
    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { seller_handoff_checklist: checklist, last_update: new Date() },
      include: ORDER_FLOW_INCLUDE,
    });
    return res.json({ successful: true, data: updated, seller_handoff_checklist: checklist });
  } catch (err) {
    console.error('Grocery Handoff Checklist Error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to update handoff checklist.' });
  }
});

/**
 * Driver decline an available order
 * PUT /food/orders/:order_id/decline-driver
 */
router.put('/orders/:order_id/decline-driver', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true } },
      },
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.driver_id !== driverRecord.driver_id) {
      return res.status(409).json({ successful: false, message: 'This offer is no longer yours to decline' });
    }

    const result = await reofferDeliveryOrderAfterDecline(io, 'food_order', order_id, driverRecord.driver_id);
    return res.json({ successful: true, ...result });
  } catch (err) {
    console.error('Food Decline Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Driver marks that they are navigating to the grocery store. This is intentionally separate
 * from pickup so the customer sees assignment progress without pretending the order left store.
 * PATCH /food/orders/:order_id/navigate-to-store
 */
router.patch('/orders/:order_id/navigate-to-store', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });

    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (existing.driver_id !== driverRecord.driver_id) {
      return res.status(403).json({ successful: false, message: 'This order is assigned to another driver.' });
    }
    if (!isGroceryOrder(existing)) {
      return res.status(400).json({ successful: false, message: 'Store navigation is only used for grocery delivery.' });
    }
    if (!['dispatched', 'ready_for_pickup'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order is not ready for store navigation.' });
    }

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { driver_en_route_at: new Date(), last_update: new Date() },
      include: ORDER_FLOW_INCLUDE,
    });
    emitOrderStatus(io, updated, updated.order_status, {
      event: 'driver_en_route_to_store',
      message: 'Your delivery partner is heading to the store.',
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('Navigate To Store Error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to update store navigation.' });
  }
});

/**
 * Grocery substitution requested by store before pickup.
 * POST /food/orders/:order_id/substitutions
 */
router.post('/orders/:order_id/substitutions', authenticateToken, isFoodVendor, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!isGroceryOrder(existing)) {
      return res.status(400).json({ successful: false, message: 'Substitutions are only available for grocery orders.' });
    }
    if (['picked_up', 'delivered', 'cancelled'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order can no longer accept substitutions.' });
    }
    const substitutionPreference = normalizeGrocerySubstitutionPreference(existing.substitution_preference);
    if (substitutionPreference.mode === 'none') {
      return res.status(409).json({ successful: false, message: 'The customer chose no substitutions for this order.' });
    }

    const itemName = String(req.body?.item_name || '').trim();
    const replacementName = String(req.body?.replacement_name || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const priceDelta = parseSignedMoneyAmount(req.body?.price_delta) ?? 0;
    const replacementItemId = Number.isInteger(Number(req.body?.replacement_item_id)) ? Number(req.body.replacement_item_id) : null;
    if (!itemName || !replacementName) {
      return res.status(400).json({ successful: false, message: 'Item and replacement names are required.' });
    }
    if (replacementItemId) {
      const replacementItem = await prisma.food_item.findFirst({
        where: {
          food_item_id: replacementItemId,
          vendor_id: existing.vendor_id,
          is_available: true,
          OR: [
            { stock_qty: null },
            { stock_qty: { gt: 0 } },
          ],
        },
        select: { food_item_id: true, name: true, price: true },
      });
      if (!replacementItem) {
        return res.status(400).json({ successful: false, message: 'Replacement item is unavailable for this store.' });
      }
    }
    const current = Array.isArray(existing.grocery_substitutions) ? existing.grocery_substitutions : [];
    const substitution = {
      id: crypto.randomUUID(),
      item_id: Number.isInteger(Number(req.body?.item_id)) ? Number(req.body.item_id) : null,
      item_name: itemName.slice(0, 120),
      replacement_item_id: replacementItemId,
      replacement_name: replacementName.slice(0, 120),
      reason: reason.slice(0, 300) || null,
      price_delta: priceDelta,
      status: substitutionPreference.mode === 'allow' ? 'approved' : 'pending_customer',
      customer_preference: substitutionPreference,
      created_at: new Date().toISOString(),
      responded_at: substitutionPreference.mode === 'allow' ? new Date().toISOString() : null,
    };
    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { grocery_substitutions: [...current, substitution], last_update: new Date() },
      include: ORDER_FLOW_INCLUDE,
    });
    emitOrderStatus(io, updated, 'substitution_requested', {
      substitution,
      message: 'The store suggested a replacement for an unavailable item.',
    });
    notifyFoodCustomer(io, { userId: updated.user_id, orderId: order_id, status: 'substitution_requested', flow: 'grocery' });
    return res.status(201).json({ successful: true, data: substitution });
  } catch (err) {
    console.error('Grocery Substitution Error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to create substitution request.' });
  }
});

/**
 * Customer approves or rejects a grocery substitution before pickup.
 * PATCH /food/orders/:order_id/substitutions/:substitution_id
 */
router.patch('/orders/:order_id/substitutions/:substitution_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const action = String(req.body?.action || req.body?.status || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ successful: false, message: 'Action must be approved or rejected.' });
    }
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!isGroceryOrder(existing)) {
      return res.status(400).json({ successful: false, message: 'Substitutions are only available for grocery orders.' });
    }
    if (['picked_up', 'delivered', 'cancelled'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order can no longer update substitutions.' });
    }
    const current = Array.isArray(existing.grocery_substitutions) ? existing.grocery_substitutions : [];
    let found = false;
    const updatedSubs = current.map((item) => {
      if (item?.id !== req.params.substitution_id) return item;
      found = true;
      return {
        ...item,
        status: action,
        customer_note: String(req.body?.note || '').trim().slice(0, 300) || null,
        responded_at: new Date().toISOString(),
      };
    });
    if (!found) return res.status(404).json({ successful: false, message: 'Substitution not found.' });
    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { grocery_substitutions: updatedSubs, last_update: new Date() },
      include: ORDER_FLOW_INCLUDE,
    });
    emitOrderStatus(io, updated, existing.order_status, {
      event: 'substitution_updated',
      substitution_id: req.params.substitution_id,
      substitution_status: action,
    });
    return res.json({ successful: true, data: updatedSubs.find((item) => item.id === req.params.substitution_id) });
  } catch (err) {
    console.error('Grocery Substitution Response Error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to update substitution.' });
  }
});

router.post('/orders/:order_id/disputes', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const reason = normalizeFoodDisputeReason(req.body?.reason);
    if (!reason) {
      return res.status(400).json({ successful: false, message: 'Dispute reason must be refund, missing_item, damaged_order, wrong_item, quality_issue, or other.' });
    }
    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_vendor: { select: { vendor_id: true, owner_id: true } },
        user: { select: { user_id: true, currency: true } },
        food_order_items: {
          include: { food_item: { select: { food_item_id: true, name: true, price: true } } },
        },
      },
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found.' });
    const isOwner = order.user_id === req.user.user_id;
    const isVendorOwner = order.food_vendor?.owner_id === req.user.user_id;
    if (!isFoodAdmin(req.user) && !isOwner && !isVendorOwner) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!isGroceryOrder(order)) {
      return res.status(400).json({ successful: false, message: 'Dispute center is available for grocery orders.' });
    }
    const requestedAmount = parseNonNegativeAmount(req.body?.requested_amount);
    if (requestedAmount === null) {
      return res.status(400).json({ successful: false, message: 'Requested refund must be a non-negative amount.' });
    }
    const maxAmount = Number(order.total_amount) || 0;
    if (requestedAmount != null && requestedAmount > maxAmount) {
      return res.status(400).json({ successful: false, message: 'Requested refund cannot exceed order total.' });
    }
    const dispute = await prisma.food_order_dispute.create({
      data: {
        food_order_id: order.food_order_id,
        vendor_id: order.vendor_id,
        opened_by_user_id: req.user.user_id,
        reason,
        status: isVendorOwner ? 'seller_review' : 'open',
        requested_amount: requestedAmount,
        currency: req.body?.currency ? String(req.body.currency).trim().slice(0, 10).toUpperCase() : order.user?.currency || 'CAD',
        item_payload: {
          items: normalizeDisputeItems(req.body?.items),
          order_items: order.food_order_items.map((item) => ({
            food_order_detail_id: item.food_order_detail_id,
            food_item_id: item.food_item_id,
            name: item.food_item?.name || null,
            qty: item.qty,
            price_item: item.price_item,
          })),
        },
        evidence: normalizeDisputeEvidence(req.body?.evidence),
        seller_response: req.body?.seller_response ? String(req.body.seller_response).trim().slice(0, 2000) : null,
      },
      include: {
        food_order: { select: { food_order_id: true, order_status: true, order_flow: true, total_amount: true, created_at: true, delivered_at: true } },
        opened_by: { select: { user_id: true, name: true } },
        assigned_user: { select: { user_id: true, name: true } },
      },
    });
    return res.status(201).json({ successful: true, data: dispute });
  } catch (err) {
    console.error('[food] create dispute failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to create dispute.' });
  }
});

router.patch('/vendor/:vendor_id/disputes/:dispute_id', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendor_id, 10);
    await assertInventoryVendorAccess(req, vendorId);
    const disputeId = Number(req.params.dispute_id);
    if (!Number.isInteger(disputeId) || disputeId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid dispute id.' });
    }
    const existing = await prisma.food_order_dispute.findFirst({
      where: { dispute_id: disputeId, vendor_id: vendorId },
      include: { food_order: { select: { total_amount: true } } },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Dispute not found.' });
    const status = req.body?.status === undefined ? null : normalizeFoodDisputeStatus(req.body.status);
    if (req.body?.status !== undefined && !status) {
      return res.status(400).json({ successful: false, message: 'Invalid dispute status.' });
    }
    const approvedAmount = req.body?.approved_amount === undefined ? undefined : parseNonNegativeAmount(req.body.approved_amount);
    if (approvedAmount === null) {
      return res.status(400).json({ successful: false, message: 'Approved refund must be a non-negative amount.' });
    }
    if (approvedAmount != null && approvedAmount > (Number(existing.food_order?.total_amount) || 0)) {
      return res.status(400).json({ successful: false, message: 'Approved refund cannot exceed order total.' });
    }
    const nextStatus = status || existing.status;
    const assignedUserId = req.body?.assigned_user_id == null ? null : Number(req.body.assigned_user_id);
    if (req.body?.assigned_user_id !== undefined && (!isFoodAdmin(req.user) || (assignedUserId != null && (!Number.isInteger(assignedUserId) || assignedUserId <= 0)))) {
      return res.status(400).json({ successful: false, message: 'Invalid assigned user.' });
    }
    const updated = await prisma.food_order_dispute.update({
      where: { dispute_id: disputeId },
      data: {
        updated_at: new Date(),
        ...(status ? { status } : {}),
        ...(approvedAmount !== undefined ? { approved_amount: approvedAmount } : {}),
        ...(req.body?.seller_response !== undefined ? { seller_response: String(req.body.seller_response || '').trim().slice(0, 2000) || null } : {}),
        ...(req.body?.resolution_note !== undefined ? { resolution_note: String(req.body.resolution_note || '').trim().slice(0, 2000) || null } : {}),
        ...(req.body?.assigned_user_id !== undefined ? { assigned_user_id: assignedUserId } : {}),
        ...(req.body?.evidence !== undefined ? { evidence: normalizeDisputeEvidence(req.body.evidence) } : {}),
        ...(['approved', 'rejected', 'resolved', 'cancelled'].includes(nextStatus) ? { resolved_at: new Date() } : {}),
      },
      include: {
        food_order: { select: { food_order_id: true, order_status: true, order_flow: true, total_amount: true, created_at: true, delivered_at: true } },
        opened_by: { select: { user_id: true, name: true } },
        assigned_user: { select: { user_id: true, name: true } },
      },
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('[food] update dispute failed:', err?.message || err);
    return foodRouteError(res, err, 'Failed to update dispute.');
  }
});

/**
 * Restaurant reject an order with a reason
 * PUT /food/orders/:order_id/reject
 */
router.put('/orders/:order_id/reject', authenticateToken, isFoodVendor, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const { rejection_reason } = req.body;

    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
      },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && existing.food_vendor?.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (['picked_up', 'delivered'].includes(existing.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order can no longer be rejected.' });
    }
    if (existing?.wallet_credited_at) {
      await reverseFoodOrderWalletCredit(existing).catch((err) =>
        console.error('[food] wallet reverse on reject failed:', err?.message || err),
      );
    }

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { order_status: 'cancelled', last_update: new Date() },
    });

    emitOrderStatus(io, { ...updated, vendor_type: existing.vendor_type, food_vendor: existing.food_vendor }, 'cancelled', {
      rejection_reason: rejection_reason ?? null,
      message: rejection_reason || (isGroceryOrder(existing) ? 'The store could not accept your order.' : 'The restaurant could not accept your order.'),
    });
    notifyFoodCustomer(io, {
      userId: updated.user_id,
      orderId: order_id,
      status: 'cancelled',
      flow: orderFlow(existing),
      body: rejection_reason || (isGroceryOrder(existing) ? 'The store could not accept your order.' : 'The restaurant could not accept your order.'),
    });
    clearDeliveryLocation('food', order_id);

    return res.json({ successful: true, message: 'Order rejected.', data: updated });
  } catch (err) {
    console.error('Reject Order Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PATCH /orders/:order_id/cancel — customer-initiated cancel.
 *
 * Only allowed while the order is still 'pending' or 'confirmed' (i.e. before the vendor has
 * started preparing it) — mirrors how the vendor's own /reject route works, just gated to the
 * order's owner and to the early window a customer can still back out for free. No refund call
 * here: /reject (the existing vendor-side cancel path) doesn't issue one either, so payment
 * capture/refund for food orders isn't wired up yet — this stays consistent with that, not a
 * regression.
 */
router.patch('/orders/:order_id/cancel', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.food_order.findUnique({ where: { food_order_id: order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (order.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'You can only cancel your own orders.' });
    }
    const allowedCancelStatuses = isGroceryOrder(order) ? GROCERY_CUSTOMER_CANCEL : FOOD_CUSTOMER_CANCEL;
    if (!allowedCancelStatuses.has(order.order_status)) {
      return res.status(409).json({
        successful: false,
        message: isGroceryOrder(order)
          ? 'This grocery order can no longer be cancelled because the store has accepted or started packing it.'
          : 'This order can no longer be cancelled because the restaurant has already started preparing it.',
      });
    }

    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: { order_status: 'cancelled', last_update: new Date() },
    });

    emitOrderStatus(io, { ...updated, vendor_type: order.vendor_type, food_vendor: order.food_vendor }, 'cancelled');
    notifyFoodCustomer(io, { userId: updated.user_id, orderId: order_id, status: 'cancelled', flow: orderFlow(order) });

    clearDeliveryLocation('food', order_id);
    return res.json({ successful: true, message: 'Order cancelled.', data: updated });
  } catch (err) {
    console.error('Cancel Food Order Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* POST /orders/:order_id/review — the customer's rating/comment for a delivered order.
 *
 * Backed by food_order_rating (the model that landed on main from a concurrent PR — same
 * purpose as what this route was originally built against, so this writes to that table
 * instead of carrying a duplicate one). One rating per order (food_order_id is unique) — a
 * customer re-submitting just updates their existing rating rather than erroring, matching
 * how the tracking-screen rating modal only ever offers one rate-this-order prompt per
 * delivery. Response shape (id/rating/comment) is kept as the frontend already expects it.
 */
router.post('/orders/:order_id/review', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const rating = Number(req.body?.rating);
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : null;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ successful: false, message: 'rating must be an integer from 1 to 5.' });
    }

    const order = await prisma.food_order.findUnique({ where: { food_order_id: order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (order.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'You can only review your own orders.' });
    }
    if (order.order_status !== 'delivered') {
      return res.status(409).json({ successful: false, message: 'You can only review an order after it has been delivered.' });
    }
    if (!order.vendor_id) {
      return res.status(409).json({ successful: false, message: 'This order has no associated restaurant.' });
    }

    const review = await prisma.food_order_rating.upsert({
      where: { food_order_id: order_id },
      update: { rating, review: comment },
      create: { food_order_id: order_id, vendor_id: order.vendor_id, user_id: req.user.user_id, rating, review: comment },
    });

    return res.json({ successful: true, data: { ...review, comment: review.review } });
  } catch (err) {
    console.error('Submit Food Review Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* GET /vendors/:vendor_id/reviews — public reviews list + average, for the restaurant page's
 * Reviews tab. Reviewer identified by first name only (matches the customer-privacy pattern
 * used for feed/reservation reviews elsewhere — no email/full profile exposed to other diners).
 * Complements GET /vendor/:vendor_id/ratings (authenticated, vendor-dashboard-only) with a
 * public, no-auth endpoint for the storefront. */
router.get('/vendors/:vendor_id/reviews', async (req, res) => {
  try {
    const vendor_id = Number(req.params.vendor_id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const [reviews, agg] = await Promise.all([
      prisma.food_order_rating.findMany({
        where: { vendor_id },
        orderBy: { created_at: 'desc' },
        take: limit,
        include: { user: { select: { name: true } } },
      }),
      prisma.food_order_rating.aggregate({
        where: { vendor_id },
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    const data = reviews.map(r => ({
      id: r.rating_id,
      rating: r.rating,
      comment: r.review,
      created_at: r.created_at,
      reviewer_name: r.user?.name ? String(r.user.name).split(' ')[0] : 'Diner',
    }));

    return res.json({
      successful: true,
      data,
      average_rating: agg._avg.rating != null ? Math.round(agg._avg.rating * 10) / 10 : null,
      review_count: agg._count.rating,
    });
  } catch (err) {
    console.error('Get Food Reviews Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

//======================================================================================================
//============================================ FOOD ORDER =============================================
//======================================================================================================

/* GET FOOD ORDERS — scoped to the authenticated vendor owner */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const vendor = await prisma.food_vendor.findFirst({
      where: { owner_id: req.user.user_id },
      select: { vendor_id: true },
    });
    if (!vendor) {
      return res.status(404).json({ error: 'No vendor profile found for this account.' });
    }
    // A vendor's order history only grows. Unbounded, this loaded every order they had ever
    // taken — with five relations joined on each — on every dashboard open. Page metadata rides
    // on response headers so the body stays the bare array callers already destructure.
    const where = { vendor_id: vendor.vendor_id };
    const orders = await paginate(
      req,
      res,
      ({ take, skip }) => prisma.food_order.findMany({
        where,
        take,
        skip,
        orderBy: { food_order_id: 'desc' },
        include: {
          user: { select: { name: true, email: true } },
          food_vendor: true,
          driver_profile: true,
          vendor_type: true,
          food_order_items: true,
        },
      }),
      { total: () => prisma.food_order.count({ where }) },
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food orders' });
  }
});

/* GET MY FOOD ORDERS — the authenticated customer's own order history.
 *
 * GET /orders above is vendor-scoped only (404s for any account without a food_vendor row) — a
 * regular customer has no endpoint to list their own food orders at all. Must be registered
 * before GET /orders/:id or Express would try to parse "mine" as the numeric id.
 */
router.get('/orders/mine', authenticateToken, async (req, res) => {
  try {
    const where = { user_id: req.user.user_id };
    const orders = await paginate(
      req,
      res,
      ({ take, skip }) => prisma.food_order.findMany({
        where,
        take,
        skip,
        orderBy: { food_order_id: 'desc' },
        include: {
          food_vendor: { select: { vendor_id: true, vendor_name: true, location: true, vendor_type_id: true } },
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
      }),
      { total: () => prisma.food_order.count({ where }) },
    );
    res.json({ successful: true, data: orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id/delivery-location', authenticateToken, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: orderId },
      include: {
        user: { select: { user_id: true } },
        food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
        driver_profile: true,
        vendor_type: true,
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
    });

    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    const viewerId = req.user.user_id;
    const isCustomer = order.user_id === viewerId;
    const isVendorOwner = order.food_vendor?.owner_id === viewerId;
    const isAssignedDriver = order.driver_profile?.user_id === viewerId;
    if (!isCustomer && !isVendorOwner && !isAssignedDriver) {
      return res.status(404).json({ successful: false, message: 'Order not found' });
    }

    const payload = isGroceryOrder(order) ? serializeGroceryDeliveryOrder(order, order.driver_profile) : order;
    return res.json({
      successful: true,
      data: {
        order_id: order.food_order_id,
        order_status: order.order_status,
        order_flow: orderFlow(order),
        driver_location: payload.customer_driver_location ?? null,
        customer_driver_location: payload.customer_driver_location ?? null,
        customer_visibility: payload.customer_visibility ?? null,
        eta_to_store_minutes: payload.eta_to_store_minutes ?? null,
        eta_to_customer_minutes: payload.eta_to_customer_minutes ?? null,
        eta_confidence: payload.eta_confidence ?? null,
        arriving_soon: Boolean(payload.arriving_soon),
        route_progress: payload.route_progress ?? null,
        sla_metrics: payload.sla_metrics ?? null,
        scheduled_dispatch: payload.scheduled_dispatch ?? null,
        safety_controls: payload.safety_controls ?? null,
        handling_labels: payload.handling_labels ?? [],
        delivery_timeline: payload.delivery_timeline ?? [],
        delivery_failure: payload.delivery_failure ?? null,
        delivery_preference: payload.delivery_preference ?? null,
        delivery_delay_reason: payload.delivery_delay_reason ?? null,
        delivery_failure_resolution: payload.delivery_failure_resolution ?? null,
        delivery_reschedule_request: payload.delivery_reschedule_request ?? null,
        driver_wait_compensation: payload.driver_wait_compensation ?? null,
        delivery_proof_requirements: payload.delivery_proof_requirements ?? null,
        delivery_window_start: order.delivery_window_start ?? null,
        delivery_window_end: order.delivery_window_end ?? null,
        delivery_proof_at: order.delivery_proof_at ?? null,
      },
    });
  } catch (err) {
    console.error('[food] failed to fetch delivery telemetry:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch delivery status.' });
  }
});

router.get('/grocery-delivery/analytics', authenticateToken, async (req, res) => {
  try {
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const timeZone = resolveAnalyticsTimeZone(req.query.tz);
    const { start } = resolveRange(days, timeZone);
    const requestedVendorId = Number(req.query.vendor_id);
    const vendorWhere = {};
    if (Number.isInteger(requestedVendorId) && requestedVendorId > 0) vendorWhere.vendor_id = requestedVendorId;
    if (!isFoodAdmin(req.user)) vendorWhere.owner_id = req.user.user_id;

    const vendors = await prisma.food_vendor.findMany({
      where: vendorWhere,
      select: { vendor_id: true, vendor_name: true },
    });
    const vendorIds = vendors.map((vendor) => vendor.vendor_id);
    if (!vendorIds.length) {
      return res.json({
        successful: true,
        data: {
          range: rangeParam,
          timezone: timeZone,
          summary: {
            total_orders: 0,
            active_orders: 0,
            failed_orders: 0,
            late_orders: 0,
            avg_store_accept_minutes: null,
            avg_packing_minutes: null,
            avg_driver_wait_minutes: null,
            avg_delivery_minutes: null,
          },
          status_breakdown: [],
          orders: [],
        },
      });
    }

    const orders = await prisma.food_order.findMany({
      where: {
        order_flow: 'grocery',
        vendor_id: { in: vendorIds },
        created_at: { gte: start },
      },
      include: {
        food_vendor: { select: { vendor_id: true, vendor_name: true, lat: true, long: true } },
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
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
      orderBy: { created_at: 'desc' },
      take: 500,
    });

    const metrics = orders.map(grocerySlaMetrics);
    const average = (key) => {
      const values = metrics.map((row) => row[key]).filter((value) => Number.isFinite(value));
      if (!values.length) return null;
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    };
    const statusCounts = new Map();
    for (const order of orders) {
      const status = order.order_status || 'unknown';
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    }

    return res.json({
      successful: true,
      data: {
        range: rangeParam,
        timezone: timeZone,
        summary: {
          total_orders: orders.length,
          active_orders: orders.filter((order) => !['delivered', 'cancelled'].includes(String(order.order_status || '').toLowerCase())).length,
          failed_orders: orders.filter((order) => String(order.order_status || '').toLowerCase() === 'delivery_failed').length,
          late_orders: metrics.filter((row) => row.late).length,
          avg_store_accept_minutes: average('store_accept_minutes'),
          avg_packing_minutes: average('packing_minutes'),
          avg_driver_wait_minutes: average('driver_wait_minutes'),
          avg_delivery_minutes: average('delivery_minutes'),
        },
        status_breakdown: Array.from(statusCounts.entries()).map(([status, count]) => ({ status, count })),
        orders: orders.slice(0, 50).map((order, index) => ({
          order_id: order.food_order_id,
          vendor_id: order.food_vendor?.vendor_id ?? null,
          vendor_name: order.food_vendor?.vendor_name ?? null,
          status: order.order_status,
          created_at: order.created_at,
          delivery_window_start: order.delivery_window_start,
          delivery_window_end: order.delivery_window_end,
          handling_labels: groceryHandlingLabels(order),
          route_progress: groceryRouteProgress(order, order.driver_profile),
          sla_metrics: metrics[index],
          safety_controls: grocerySafetyControls(order, order.driver_profile),
          pending_substitutions: groceryPendingSubstitutions(order),
          rejected_offer_events: (Array.isArray(order.delivery_offer_events) ? order.delivery_offer_events : []).filter((event) => ['rejected', 'timed_out'].includes(String(event?.status || '').toLowerCase())),
        })),
      },
    });
  } catch (err) {
    console.error('[food] grocery delivery analytics failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to load grocery delivery analytics.' });
  }
});

router.get('/grocery-delivery/dispatch', authenticateToken, async (req, res) => {
  try {
    const vendorId = Number(req.query.vendor_id);
    const vendorWhere = {};
    if (Number.isInteger(vendorId) && vendorId > 0) vendorWhere.vendor_id = vendorId;
    if (!isFoodAdmin(req.user)) vendorWhere.owner_id = req.user.user_id;

    const vendors = await prisma.food_vendor.findMany({
      where: vendorWhere,
      select: { vendor_id: true },
    });
    const vendorIds = vendors.map((vendor) => vendor.vendor_id);
    if (!vendorIds.length) return res.json({ successful: true, data: [] });

    const orders = await prisma.food_order.findMany({
      where: {
        order_flow: 'grocery',
        vendor_id: { in: vendorIds },
        OR: [{ order_status: null }, { order_status: { notIn: ['delivered', 'cancelled'] } }],
      },
      include: {
        ...ORDER_FLOW_INCLUDE,
        user: { select: { user_id: true, name: true } },
        driver_profile: {
          select: {
            driver_profile_id: true,
            user_id: true,
            rating: true,
            current_lat: true,
            current_long: true,
            last_ping: true,
            user: { select: { name: true } },
          },
        },
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
      orderBy: [{ delivery_window_start: 'asc' }, { created_at: 'desc' }],
      take: 200,
    });

    return res.json({
      successful: true,
      data: orders.map((order) => serializeGroceryDeliveryOrder(order, order.driver_profile)),
    });
  } catch (err) {
    console.error('[food] grocery dispatch dashboard failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to load grocery dispatch.' });
  }
});

router.patch('/grocery-delivery/:order_id/reassign', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    if (!isFoodAdmin(req.user)) {
      return res.status(403).json({ successful: false, message: 'Admin access required.' });
    }
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const driverProfileId = req.body?.driver_profile_id == null ? null : Number(req.body.driver_profile_id);
    if (driverProfileId != null && (!Number.isInteger(driverProfileId) || driverProfileId <= 0)) {
      return res.status(400).json({ successful: false, message: 'Invalid driver profile id.' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true } },
      },
    });
    if (!order || !isGroceryOrder(order)) {
      return res.status(404).json({ successful: false, message: 'Grocery delivery not found.' });
    }
    if (['delivered', 'cancelled'].includes(String(order.order_status || '').toLowerCase())) {
      return res.status(409).json({ successful: false, message: 'Closed grocery deliveries cannot be reassigned.' });
    }

    const oldDriverId = Number(order.driver_id);
    const oldDriverUserId = Number(order.driver_profile?.user_id);
    const reassignReason = String(req.body?.reason || 'manual_reassignment').trim().slice(0, 160);

    let assignedDriverId = null;
    if (driverProfileId) {
      assignedDriverId = await assignDeliveryOrderToDriver(io, 'food_order', order_id, driverProfileId, 'manual_reassignment');
      if (!assignedDriverId) {
        return res.status(409).json({ successful: false, message: 'Selected driver is not eligible for this grocery delivery.' });
      }
      if (Number.isInteger(oldDriverUserId) && oldDriverUserId > 0 && oldDriverId !== assignedDriverId) {
        await notifyDeliveryOfferClosed(io, { idField: 'food_order_id' }, oldDriverUserId, 'food_order', order_id, 'manual_reassigned');
      }
    } else {
      await prisma.food_order.update({
        where: { food_order_id: order_id },
        data: {
          driver_id: null,
          offer_expires_at: null,
          declined_driver_ids: Number.isInteger(oldDriverId)
            ? [...new Set([...(order.declined_driver_ids || []).map(Number), oldDriverId])].filter((id) => Number.isInteger(id))
            : order.declined_driver_ids,
          delivery_offer_events: [
            ...(Array.isArray(order.delivery_offer_events) ? order.delivery_offer_events : []),
            {
              id: `${Date.now()}-admin-reassign`,
              status: 'admin_reassign_requested',
              driver_profile_id: Number.isInteger(oldDriverId) ? oldDriverId : null,
              user_id: Number.isInteger(oldDriverUserId) ? oldDriverUserId : null,
              reason: reassignReason,
              created_at: new Date().toISOString(),
            },
          ].slice(-50),
          last_update: new Date(),
        },
      });
      if (Number.isInteger(oldDriverUserId) && oldDriverUserId > 0) {
        await notifyDeliveryOfferClosed(io, { idField: 'food_order_id' }, oldDriverUserId, 'food_order', order_id, 'manual_reassigned');
      }
      assignedDriverId = await dispatchDeliveryOrder(io, 'food_order', order_id, Number.isInteger(oldDriverId) ? [oldDriverId] : []);
    }

    const updated = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
      },
    });
    emitOrderStatus(io, updated, updated.order_status, {
      event: 'grocery_dispatch_reassigned',
      driver_id: assignedDriverId,
    });
    return res.json({
      successful: true,
      message: assignedDriverId ? 'Grocery delivery reassigned.' : 'Grocery delivery returned to dispatch queue.',
      data: serializeGroceryDeliveryOrder(updated, updated.driver_profile),
    });
  } catch (err) {
    console.error('[food] grocery delivery reassign failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to reassign grocery delivery.' });
  }
});

router.patch('/grocery-delivery/:order_id/resolve', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    if (!isFoodAdmin(req.user)) {
      return res.status(403).json({ successful: false, message: 'Admin access required.' });
    }
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const action = String(req.body?.action || req.body?.resolution_action || '').trim().toLowerCase();
    if (!GROCERY_FAILURE_RESOLUTION_ACTIONS.has(action)) {
      return res.status(400).json({ successful: false, message: 'Select retry_delivery, return_to_store, or refund_review.' });
    }
    const note = String(req.body?.note || '').trim().slice(0, 500);

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
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
    });
    if (!order || !isGroceryOrder(order)) {
      return res.status(404).json({ successful: false, message: 'Grocery delivery not found.' });
    }
    if (['delivered', 'cancelled'].includes(String(order.order_status || '').toLowerCase())) {
      return res.status(409).json({ successful: false, message: 'Closed grocery deliveries cannot be changed.' });
    }

    const now = new Date();
    const resolution = {
      action,
      status: action === 'refund_review' ? 'refund_review' : 'resolved',
      note: note || null,
      resolved_by: req.user.user_id,
      resolved_by_role: 'admin',
      resolved_at: now.toISOString(),
    };
    const nextStatus =
      action === 'retry_delivery'
        ? (order.driver_id ? 'picked_up' : 'ready_for_pickup')
        : action === 'return_to_store'
          ? 'ready_for_pickup'
          : 'delivery_failed';
    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        order_status: nextStatus,
        delivery_failure_resolution: resolution,
        delivery_proof: {
          ...safeJsonObject(order.delivery_proof),
          failure_resolution: resolution,
        },
        ...(action === 'return_to_store' ? { driver_id: null, offer_expires_at: null } : {}),
        last_update: now,
      },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
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
    });
    if (action === 'return_to_store') {
      await dispatchDeliveryOrder(io, 'food_order', order_id, Number.isInteger(Number(order.driver_id)) ? [Number(order.driver_id)] : []);
    }
    emitOrderStatus(io, updated, nextStatus, { delivery_failure_resolution: resolution });
    io.to(`user-${updated.user_id}`).emit(`order-update-${order_id}`, {
      order_status: nextStatus,
      status: nextStatus,
      delivery_failure_resolution: resolution,
    });
    notifyFoodCustomer(io, {
      userId: updated.user_id,
      orderId: order_id,
      status: nextStatus,
      flow: 'grocery',
    });
    return res.json({
      successful: true,
      message: 'Delivery resolution saved.',
      data: serializeGroceryDeliveryOrder(updated, updated.driver_profile),
    });
  } catch (err) {
    console.error('[food] grocery delivery resolution failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to resolve grocery delivery.' });
  }
});

router.patch('/orders/:order_id/reschedule-delivery', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const note = String(req.body?.note || req.body?.reason || '').trim().slice(0, 500);
    const deliveryWindow = validateDeliveryWindow(req.body?.delivery_window_start, req.body?.delivery_window_end);
    if (!deliveryWindow.start) {
      return res.status(400).json({ successful: false, message: 'Select a delivery window start time.' });
    }
    if (deliveryWindow.start.getTime() <= Date.now()) {
      return res.status(400).json({ successful: false, message: 'Delivery window must be in the future.' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
      },
    });
    if (!order || !isGroceryOrder(order) || order.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: 'Grocery order not found.' });
    }
    const status = String(order.order_status || '').toLowerCase();
    if (!['pending', 'confirmed'].includes(status) || order.packed_at || order.ready_for_pickup_at || order.picked_up_at) {
      return res.status(409).json({ successful: false, message: 'Delivery can only be rescheduled before packing starts.' });
    }

    const closureDuringWindow = await findOverlappingVendorClosure(
      order.vendor_id,
      deliveryWindow.start,
      deliveryWindow.end || deliveryWindow.start,
    );
    if (closureDuringWindow) {
      return res.status(409).json({
        successful: false,
        message: 'The store is closed during that delivery window.',
      });
    }

    const now = new Date();
    const previousDriverUserId = order.driver_profile?.user_id;
    const requestRecord = {
      status: 'applied',
      requested_by: req.user.user_id,
      requested_by_role: 'customer',
      requested_at: now.toISOString(),
      previous_window_start: order.delivery_window_start || null,
      previous_window_end: order.delivery_window_end || null,
      new_window_start: deliveryWindow.start.toISOString(),
      new_window_end: deliveryWindow.end ? deliveryWindow.end.toISOString() : null,
      note: note || null,
    };

    const write = await prisma.food_order.updateMany({
      where: {
        food_order_id: order_id,
        user_id: req.user.user_id,
        order_status: { in: ['pending', 'confirmed'] },
        packed_at: null,
        ready_for_pickup_at: null,
        picked_up_at: null,
      },
      data: {
        delivery_window_start: deliveryWindow.start,
        delivery_window_end: deliveryWindow.end || null,
        scheduled_time: deliveryWindow.start,
        delivery_reschedule_request: requestRecord,
        ...(order.driver_id ? { driver_id: null, offer_expires_at: null } : {}),
        last_update: now,
      },
    });
    if (write.count !== 1) {
      return res.status(409).json({ successful: false, message: 'Delivery can only be rescheduled before packing starts.' });
    }

    const updated = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
        driver_profile: { select: { driver_profile_id: true, user_id: true, rating: true, current_lat: true, current_long: true, last_ping: true } },
      },
    });

    if (previousDriverUserId) {
      await notifyDeliveryOfferClosed(io, { idField: 'food_order_id' }, previousDriverUserId, 'food_order', order_id, 'customer_rescheduled');
    }
    emitOrderStatus(io, updated, updated.order_status, {
      event: 'grocery_delivery_rescheduled',
      delivery_reschedule_request: requestRecord,
      delivery_window_start: updated.delivery_window_start,
      delivery_window_end: updated.delivery_window_end,
    });
    io.to(`user-${updated.user_id}`).emit(`order-update-${order_id}`, {
      order_status: updated.order_status,
      status: updated.order_status,
      delivery_reschedule_request: requestRecord,
      delivery_window_start: updated.delivery_window_start,
      delivery_window_end: updated.delivery_window_end,
    });
    notifyFoodCustomer(io, {
      userId: updated.user_id,
      orderId: order_id,
      status: updated.order_status,
      flow: 'grocery',
      title: 'Delivery window updated',
      body: 'Your grocery delivery window was rescheduled before packing started.',
    });

    return res.json({
      successful: true,
      message: 'Delivery window updated.',
      data: serializeGroceryDeliveryOrder(updated, updated.driver_profile),
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    if (status >= 500) console.error('[food] grocery delivery reschedule failed:', err?.message || err);
    return res.status(status).json({
      successful: false,
      message: err?.message || 'Failed to reschedule delivery.',
    });
  }
});

/* GET FOOD ORDER BY ID — restricted to the parties on the order.
 *
 * This was previously unauthenticated. food_order carries otp_code (the proof-of-delivery
 * code), deliver_location, delivery_instructions and payment_intent_id, and food_order_id is a
 * sequential integer, so the route allowed anyone to enumerate every order on the platform and
 * read the customer's address plus the OTP that authorises handover. Password hashes and
 * precise saved coordinates were never exposed here (utils/prisma-client.js omits them
 * globally), but name/email/phone were.
 *
 * Visibility now matches the write paths below: the customer who placed it, the vendor owner,
 * or the driver assigned to it.
 */
router.get('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await prisma.food_order.findUnique({
      where: { food_order_id: parseInt(req.params.id) },
      include: {
        user: { select: { user_id: true, name: true, email: true } },
        food_vendor: true,
        driver_profile: true,
        vendor_type: true,
        // Nest food_item so callers (customer tracking screen, vendor/driver views) get the
        // dish name without a second round-trip — matches the shape POST /orders already returns.
        food_order_items: { include: { food_item: { select: { name: true } } } },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Food order not found' });
    }

    const viewerId = req.user.user_id;
    const isCustomer = order.user_id === viewerId;
    const isVendorOwner = order.food_vendor?.owner_id === viewerId;
    const isAssignedDriver = order.driver_profile?.user_id === viewerId;
    if (!isCustomer && !isVendorOwner && !isAssignedDriver) {
      // 404 rather than 403 so the endpoint doesn't confirm which order ids exist.
      return res.status(404).json({ error: 'Food order not found' });
    }

    res.json({
      ...(isGroceryOrder(order) ? serializeGroceryDeliveryOrder(order, order.driver_profile) : order),
      deliver_location: publicDeliverLocation(order),
      fulfillment_mode: isFoodPickupOrder(order) ? 'pickup' : 'delivery',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food order' });
  }
});

const FOOD_RATING_ELIGIBLE = new Set(['picked_up', 'delivered']);

function parseFoodRatingBody(body = {}) {
  const rawRating = body.rating ?? body.stars ?? body.score;
  const rating = Number(rawRating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'rating must be an integer from 1 to 5' };
  }
  const reviewRaw = body.review ?? body.comment ?? body.feedback ?? body.text ?? null;
  const review =
    reviewRaw == null || reviewRaw === ''
      ? null
      : String(reviewRaw).trim().slice(0, 2000) || null;
  return { ok: true, data: { rating, review } };
}

/** Indexed aggregate — cheap Overview stats without loading order rows. */
async function getFoodVendorRatingStats(vendorId) {
  const agg = await prisma.food_order_rating.aggregate({
    where: { vendor_id: vendorId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const review_count = agg._count._all || 0;
  const rating =
    agg._avg.rating != null ? Math.round(agg._avg.rating * 10) / 10 : null;
  return { rating, review_count };
}

/**
 * GET /food/orders/:id/rating — customer/vendor/driver can read the order rating.
 */
router.get('/orders/:id/rating', authenticateToken, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: orderId },
      include: {
        food_vendor: { select: { owner_id: true } },
        driver_profile: { select: { user_id: true } },
        food_order_rating: true,
      },
    });
    if (!order) {
      return res.status(404).json({ successful: false, message: 'Food order not found' });
    }

    const viewerId = req.user.user_id;
    const allowed =
      order.user_id === viewerId
      || order.food_vendor?.owner_id === viewerId
      || order.driver_profile?.user_id === viewerId;
    if (!allowed) {
      return res.status(404).json({ successful: false, message: 'Food order not found' });
    }

    if (!order.food_order_rating) {
      return res.status(404).json({ successful: false, message: 'No rating for this order' });
    }
    return res.json({ successful: true, data: order.food_order_rating });
  } catch (err) {
    console.error('Failed to fetch food order rating:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch rating' });
  }
});

/**
 * POST /food/orders/:id/rating — customer rates the restaurant (one per order).
 * Body: { rating: 1-5, review|comment|feedback?: string }
 */
router.post('/orders/:id/rating', authenticateToken, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id' });
    }

    const parsed = parseFoodRatingBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: orderId },
      include: { food_order_rating: true },
    });
    if (!order) {
      return res.status(404).json({ successful: false, message: 'Food order not found' });
    }
    if (order.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the customer who placed this order can rate it' });
    }
    if (!FOOD_RATING_ELIGIBLE.has(order.order_status)) {
      return res.status(400).json({
        successful: false,
        message: 'Order must be picked up or delivered before rating',
      });
    }
    if (order.food_order_rating) {
      return res.status(400).json({ successful: false, message: 'Rating already submitted for this order' });
    }

    const created = await prisma.food_order_rating.create({
      data: {
        food_order_id: orderId,
        user_id: req.user.user_id,
        vendor_id: order.vendor_id,
        rating: parsed.data.rating,
        review: parsed.data.review,
      },
    });

    return res.status(201).json({ successful: true, data: created });
  } catch (err) {
    if (err?.code === 'P2002') {
      return res.status(400).json({ successful: false, message: 'Rating already submitted for this order' });
    }
    console.error('Failed to create food order rating:', err);
    return res.status(500).json({ successful: false, message: 'Failed to submit rating' });
  }
});

/* CREATE FOOD ORDER (Production Standard) */
router.post('/orders', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const {
      vendor_id, delivery_instructions, scheduled_time,
      delivery_window_start, delivery_window_end,
      payment_method, payment_intent_id, items, tip, tip_amount,
      promo_code, referral_code, fulfillment_mode: fulfillmentModeRaw,
      substitution_preference, substitution_mode, preferred_substitutions, substitution_note,
      delivery_preference, handoff_preference,
    } = req.body;
    let { deliver_location } = req.body;
    const user_id = req.user.user_id;
    const orderItems = normalizeOrderItems(items);
    const numericVendorId = Number(vendor_id);
    const orderReferralCode = normalizeReferralCode(referral_code);
    const fulfillment_mode = normalizeFulfillmentMode(fulfillmentModeRaw);
    const isPickup = fulfillment_mode === 'pickup';
    // Self-pickup has no courier destination — don't fall back to a saved delivery address.
    if (isPickup) deliver_location = null;

    if (!user_id) {
        return res.status(401).json({ successful: false, message: "User session expired or invalid." });
    }
    if (!Number.isInteger(numericVendorId) || numericVendorId <= 0) {
      return res.status(400).json({ successful: false, message: "A valid store is required." });
    }
    const rawPaymentMethod = String(payment_method || '').trim();
    if (!rawPaymentMethod) {
      return res.status(400).json({ successful: false, message: 'Payment method is required.' });
    }
    const payMethod = rawPaymentMethod.toUpperCase();
    if (!['CARD', 'WALLET'].includes(payMethod)) {
      return res.status(400).json({ successful: false, message: 'Invalid payment method. Use CARD or WALLET.' });
    }
    if (!orderItems.length) {
      return res.status(400).json({ successful: false, message: "At least one valid order item is required." });
    }

    const requestedDeliveryLat = parseFiniteCoord(req.body.delivery_lat ?? req.body.deliver_lat);
    const requestedDeliveryLng = parseFiniteCoord(req.body.delivery_lng ?? req.body.deliver_lng);
    if (!isPickup) {
      deliver_location = String(deliver_location || '').trim() || null;
      if (!deliver_location) {
        return res.status(400).json({ successful: false, message: 'Delivery address is required.' });
      }
      if (isReservedPickupSentinel(deliver_location)) {
        return res.status(400).json({ successful: false, message: 'Invalid delivery address.' });
      }
    }

    const user = await prisma.user.findUnique({
      where: { user_id },
      select: { name: true, country: true, currency: true },
    });

    // #5: server-side guard — never accept an order for a vendor that has paused orders
    // or is deactivated. The client hides paused stores, but the browse cache can be
    // stale, so enforce it here on the money path too.
    const vendorState = await prisma.food_vendor.findUnique({
      where: { vendor_id: numericVendorId },
      select: {
        is_paused: true,
        is_active: true,
        owner_id: true,
        vendor_type_id: true,
        location: true,
        lat: true,
        long: true,
        vendor_type: { select: { vendor_type: true } },
      },
    });
    if (!vendorState || vendorState.is_active === false) {
      return res.status(404).json({ successful: false, message: "This store is no longer available." });
    }
    if (vendorState.is_paused === true) {
      return res.status(409).json({ successful: false, message: "This store has paused orders and isn't accepting new orders right now." });
    }
    const activeClosure = await findActiveVendorClosure(numericVendorId);
    if (activeClosure) {
      return res.status(409).json({
        successful: false,
        message: 'This store is temporarily closed and is not accepting new orders right now.',
        closure: closureConflictPayload(activeClosure),
      });
    }

    const ids = orderItems.map((item) => item.food_item_id);
    const itemRows = await prisma.food_item.findMany({
      where: { food_item_id: { in: ids } },
      select: {
        food_item_id: true,
        vendor_id: true,
        vendor_type_id: true,
        name: true,
        price: true,
        is_available: true,
        stock_qty: true,
      },
    });
    validateOrderItemRows(orderItems, itemRows, numericVendorId, vendorState.vendor_type_id);
    const vendorTypeName = vendorState.vendor_type?.vendor_type;
    const isCateringOrder = isEventCateringType(vendorTypeName);

    // Block cross-city courier deliveries after cart validation (e.g. restaurant in Lahore,
    // guest address in Toronto) so stock/item errors still win first.
    // Catering is a scheduled event drop, not a same-day courier radius.
    if (!isPickup && !isCateringOrder) {
      // parseFiniteCoord — never Number(null), which is 0 and invents Null Island (~8328 km false rejects).
      const range = await assertFoodDeliveryInRange({
        vendorLocation: vendorState.location,
        deliverLocation: deliver_location,
        vendorLat: vendorState.lat,
        vendorLong: vendorState.long,
        deliverLat: requestedDeliveryLat,
        deliverLng: requestedDeliveryLng,
      });
      if (!range.ok) {
        return res.status(422).json({ successful: false, message: range.message, distance_km: range.distanceKm });
      }
    }

    const resolvedDeliveryFee = isPickup || isCateringOrder
      ? 0
      : await resolveFoodDeliveryFee({
          vendorLocation: vendorState.location,
          deliverLocation: deliver_location,
        });
    const resolvedTipAmount = isPickup
      ? 0
      : resolveFoodTipAmount({ tip, tip_amount, delivery_instructions });
    const resolvedOrderFlow = flowFromVendorTypeName(vendorState.vendor_type?.vendor_type);
    const deliveryWindow = validateDeliveryWindow(delivery_window_start || scheduled_time, delivery_window_end);
    const groceryDeliveryPreference = resolvedOrderFlow === 'grocery' && !isPickup
      ? normalizeDeliveryPreference(delivery_preference || { handoff: handoff_preference }, delivery_instructions)
      : null;
    const groceryDeliveryProofRequirements = groceryDeliveryPreference
      ? groceryProofRequirements({
          order_flow: resolvedOrderFlow,
          delivery_preference: groceryDeliveryPreference,
          delivery_instructions,
          food_order_items: [],
        })
      : null;
    const closureDuringWindow = await findOverlappingVendorClosure(
      numericVendorId,
      deliveryWindow.start || scheduled_time || new Date(),
      deliveryWindow.end || deliveryWindow.start || scheduled_time || new Date(),
    );
    if (closureDuringWindow) {
      return res.status(409).json({
        successful: false,
        message: 'This store is closed during the selected delivery window.',
        closure: closureConflictPayload(closureDuringWindow),
      });
    }
    const grocerySubstitutionPreference = resolvedOrderFlow === 'grocery'
      ? normalizeGrocerySubstitutionPreference(substitution_preference, {
          substitution_mode,
          preferred_substitutions,
          substitution_note,
        })
      : null;

    // CARD stays unpaid until Stripe verifies (webhook or checkout retrieve).
    // WALLET is paid only after a real debit.
    const order = await prisma.$transaction(async (tx) => {
      const freshItemRows = await tx.food_item.findMany({
        where: { food_item_id: { in: ids } },
        select: {
          food_item_id: true,
          vendor_id: true,
          vendor_type_id: true,
          name: true,
          price: true,
          is_available: true,
          stock_qty: true,
        },
      });
      const freshById = validateOrderItemRows(orderItems, freshItemRows, numericVendorId, vendorState.vendor_type_id);
      const resolvedLines = await resolveFoodCartLines(orderItems, tx);
      if (!resolvedLines.ok) {
        const err = new Error(resolvedLines.error || 'Could not price order items.');
        err.statusCode = 400;
        throw err;
      }
      const resolvedVendorTypeId = vendorState.vendor_type_id ?? freshItemRows.find((item) => item.vendor_type_id != null)?.vendor_type_id ?? null;
      const provisional = calculateFoodOrderPricing(resolvedLines.lines, user?.country || "default", resolvedDeliveryFee, resolvedTipAmount);
      let promoDiscount = 0;
      let normalizedPromoCode = null;
      let validatedPromo = null;
      if (promo_code) {
        validatedPromo = await validatePromotionForUser({
          code: promo_code,
          userId: user_id,
          subtotal: provisional.subtotal,
          vertical: verticalForVendorTypeName(vendorTypeName) || 'food',
          vendorId: numericVendorId,
          vendorOwnerId: vendorState.owner_id ?? null,
        });
        if (!validatedPromo.ok) {
          const err = new Error(validatedPromo.message || 'Invalid promo code.');
          err.statusCode = validatedPromo.status || 400;
          throw err;
        }
        promoDiscount = Number(validatedPromo.amount) || 0;
        normalizedPromoCode = validatedPromo.code;
      }
      const pricing = calculateFoodOrderPricing(
        resolvedLines.lines,
        user?.country || "default",
        resolvedDeliveryFee,
        resolvedTipAmount,
        promoDiscount,
      );
      let markPaid = false;
      if (payMethod === 'WALLET') {
        const need = Number(pricing.totalAmount) || 0;
        const wallet = await tx.strug_wallet.findUnique({ where: { user_id } });
        if (!wallet || wallet.status !== 'active') {
          const err = new Error('Insufficient wallet balance.');
          err.statusCode = 402;
          throw err;
        }
        // Conditional decrement so concurrent checkouts cannot overdraw.
        const debited = await tx.strug_wallet.updateMany({
          where: { user_id, status: 'active', balance: { gte: need } },
          data: { balance: { decrement: need } },
        });
        if (debited.count !== 1) {
          const err = new Error('Insufficient wallet balance.');
          err.statusCode = 402;
          throw err;
        }
        await tx.wallet_transaction.create({
          data: {
            user_id,
            amount: need,
            type: 'debit',
            source: 'food_order',
            status: 'completed',
            description: 'Food order',
          },
        });
        markPaid = true;
      }

      const createdOrder = await tx.food_order.create({
        data: {
          user_id,
          vendor_id: numericVendorId,
          order_status: 'pending',
          created_at: new Date(),
          deliver_location: persistDeliverLocation(fulfillment_mode, deliver_location),
          fulfillment_mode,
          vendor_type_id: resolvedVendorTypeId,
          delivery_instructions: delivery_instructions ?? null,
          delivery_lat: isPickup ? null : requestedDeliveryLat,
          delivery_lng: isPickup ? null : requestedDeliveryLng,
          scheduled_time: scheduled_time ? new Date(scheduled_time) : null,
          order_flow: resolvedOrderFlow,
          delivery_window_start: deliveryWindow.start,
          delivery_window_end: deliveryWindow.end,
          total_amount: pricing.totalAmount,
          delivery_fee: pricing.deliveryFee,
          platform_fee: pricing.platformFee,
          tip_amount: pricing.tipAmount,
          promo_code: normalizedPromoCode,
          promo_discount: promoDiscount,
          referral_code: orderReferralCode,
          payment_method: payMethod,
          payment_intent_id: payment_intent_id ?? null,
          ispaid: markPaid,
          substitution_preference: grocerySubstitutionPreference,
          delivery_preference: groceryDeliveryPreference,
          delivery_proof_requirements: groceryDeliveryProofRequirements,
        },
      });
      if (validatedPromo?.ok) {
        await redeemPromotion({
          promotionId: validatedPromo.promo.promotion_id,
          userId: user_id,
          amount: promoDiscount,
          orderId: null,
          orderRef: `food_order:${createdOrder.food_order_id}`,
        });
      }

      await tx.food_order_items.createMany({
        data: resolvedLines.lines.map((requested) => {
          const item = freshById.get(requested.food_item_id);
          return {
            order_id: createdOrder.food_order_id,
            food_item_id: requested.food_item_id,
            qty: requested.qty,
            price_item: Number(requested.price) || 0,
            modifier_option_ids: requested.modifier_option_ids,
            special_instructions: requested.special_instructions || null,
            vendor_type_id: item?.vendor_type_id ?? createdOrder.vendor_type_id,
          };
        }),
      });
      for (const requested of orderItems) {
        const item = freshById.get(requested.food_item_id);
        if (item?.stock_qty == null) continue;
        const updated = await tx.food_item.updateMany({
          where: {
            food_item_id: requested.food_item_id,
            stock_qty: { gte: requested.qty },
          },
          data: { stock_qty: { decrement: requested.qty } },
        });
        if (updated.count !== 1) {
          const err = new Error(`Insufficient stock for ${item.name || 'item'}.`);
          err.statusCode = 409;
          throw err;
        }
        const remaining = await tx.food_item.findUnique({
          where: { food_item_id: requested.food_item_id },
          select: { stock_qty: true },
        });
        if (remaining?.stock_qty != null && remaining.stock_qty <= 0) {
          await tx.food_item.update({
            where: { food_item_id: requested.food_item_id },
            data: { stock_qty: 0, is_available: false },
          });
        }
      }

      return tx.food_order.findUnique({
        where: { food_order_id: createdOrder.food_order_id },
        include: { food_order_items: { include: { food_item: true } }, food_vendor: true, vendor_type: true },
      });
    });

    // Wallet: paid on create. Settle Referral + Recruit now (card waits for webhook).
    if (order?.ispaid) {
      await settleReferralThenRecruit({
        referralCode: order.referral_code,
        buyerUserId: order.user_id,
        recruitParticipantUserIds: [vendorState.owner_id],
        subtotal: order.platform_fee != null ? order.platform_fee / PLATFORM_FEE_PERCENTAGE : (order.total_amount || 0),
        platformTake: order.platform_fee != null ? order.platform_fee : (order.total_amount || 0) * PLATFORM_FEE_PERCENTAGE,
        orderType: 'food',
        orderRef: order.food_order_id,
        creditRecruiterShares,
      });
    }

    // If the webhook recorded this charge as an orphan before the row existed,
    // reconcile it now (and mark the order paid since the charge already settled).
    if (payment_intent_id) {
      const orphan = await prisma.stripe_orphan_payment.findUnique({ where: { payment_intent_id } }).catch(() => null);
      if (orphan && orphan.status === 'unreconciled') {
        const reconciledStatus = orderFlow(order) === 'grocery' ? 'pending' : 'confirmed';
        await prisma.food_order.update({ where: { food_order_id: order.food_order_id }, data: { ispaid: true, order_status: reconciledStatus } });
        await prisma.stripe_orphan_payment.update({ where: { payment_intent_id }, data: { status: 'reconciled' } });
        await settleReferralThenRecruit({
          referralCode: order.referral_code,
          buyerUserId: order.user_id,
          recruitParticipantUserIds: [vendorState.owner_id],
          subtotal: order.platform_fee != null ? order.platform_fee / PLATFORM_FEE_PERCENTAGE : (order.total_amount || 0),
          platformTake: order.platform_fee != null ? order.platform_fee : (order.total_amount || 0) * PLATFORM_FEE_PERCENTAGE,
          orderType: 'food',
          orderRef: order.food_order_id,
          creditRecruiterShares,
        });
        if (reconciledStatus === 'confirmed') {
          maybeDispatchFoodDelivery(io, { ...order, order_status: reconciledStatus, ispaid: true }, vendorTypeName);
        }
      }
    }

    // Notify the VENDOR — and only the vendor.
    //
    // This used to be a bare `io.emit(...)`, which has no room and therefore fans out to EVERY
    // connected socket on the server: every logged-in user on Strug received this customer's
    // name and delivery address, and every vendor received every other vendor's orders (the SPA
    // filtered by vendor_id client-side, so it looked correct while leaking on the wire).
    // `user-<id>` is the per-user room every socket auto-joins from its JWT (index.js:195).
    if (vendorState.owner_id != null) {
      // Existing real-time path (the vendor dashboard listens for this specific event).
      io?.to(`user-${vendorState.owner_id}`).emit('food-order-created', {
        order_id: order.food_order_id,
        vendor_id: order.vendor_id,
        user_name: user?.name ?? 'Customer',
        deliver_location,
      });
      // Epic 10: durable notification into the global bell. Food orders had NO persisted
      // notification before — the vendor only saw it if their dashboard socket was live.
      // Ambient (not actionable): the vendor reviews it, there's no per-order countdown.
      const notifyMeta = vendorNotifyMeta(vendorTypeName);
      notify(io, {
        userId: vendorState.owner_id,
        vertical: notifyMeta.vertical,
        type: 'order.placed',
        urgency: 'ambient',
        title: notifyMeta.title,
        body: `Order from ${user?.name ?? 'a customer'}`,
        entityType: 'food_order',
        entityId: order.food_order_id,
        actionUrl: dashboardNavForFoodVendorType(vendorState.vendor_type?.vendor_type) || notifyMeta.actionUrl,
        data: { order_id: order.food_order_id, vendor_id: order.vendor_id, vertical: notifyMeta.vertical, order_flow: resolvedOrderFlow },
      });
    }

    res.status(201).json({
      successful: true,
      data: {
        ...order,
        deliver_location: publicDeliverLocation(order),
        fulfillment_mode: isPickup ? 'pickup' : 'delivery',
      },
    });
  } catch (err) {
    console.error("❌ Create Order Error:", err);
    const status = err.statusCode || 500;
    const message = err.statusCode
      ? err.message
      : (process.env.NODE_ENV === 'production'
        ? 'Failed to create food order'
        : (err.message || 'Failed to create food order'));
    res.status(status).json({ successful: false, message });
  }
});

/**
 * PRODUCTION READY: Update Food Order Status/Details
 * Handles: Status changes, Driver assignments, and Payment updates.
 * PUT /food/orders/:id
 */
router.put('/orders/:id', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.id);

        
        if (Number.isNaN(order_id)) {
            return res.status(400).json({ successful: false, message: "Invalid order ID format." });
        }

   
        const existingOrder = await prisma.food_order.findUnique({
            where: { food_order_id: order_id },
            include: {
              food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
              vendor_type: { select: { vendor_type: true } },
            },
        });

        if (!existingOrder) {
            return res.status(404).json({ successful: false, message: "Order not found." });
        }

        const uid = req.user.user_id;
        const isCustomer = existingOrder.user_id === uid;
        const isVendor = existingOrder.food_vendor?.owner_id === uid;
        let isDriver = false;
        if (existingOrder.driver_id != null) {
          const driver = await resolveDeliveryDriverForUser(uid);
          isDriver = Boolean(driver && driver.driver_id === existingOrder.driver_id);
        }
        if (!isFoodAdmin(req.user) && !isCustomer && !isVendor && !isDriver) {
          return res.status(403).json({ successful: false, message: 'Forbidden' });
        }

        const { driver_id, order_status, deliver_location, fulfillment_mode: fulfillmentModeRaw } = req.body;
        const data = { last_update: new Date() };

        const fulfillmentLock = assertFulfillmentLocked(existingOrder, fulfillmentModeRaw);
        if (!fulfillmentLock.ok) {
          return res.status(fulfillmentLock.status).json({ successful: false, message: fulfillmentLock.message });
        }
        const locationUpdate = sanitizeDeliverLocationUpdate(existingOrder, deliver_location);
        if (!locationUpdate.ok) {
          return res.status(locationUpdate.status).json({ successful: false, message: locationUpdate.message });
        }

        if (isCustomer && !isVendor && !isFoodAdmin(req.user)) {
          if (locationUpdate.deliver_location !== undefined) data.deliver_location = locationUpdate.deliver_location;
          if (order_status && order_status !== existingOrder.order_status) {
            const cancelSet = isGroceryOrder(existingOrder) ? GROCERY_CUSTOMER_CANCEL : FOOD_CUSTOMER_CANCEL;
            if (order_status !== 'cancelled' || !cancelSet.has(existingOrder.order_status)) {
              return res.status(403).json({ successful: false, message: isGroceryOrder(existingOrder) ? 'Grocery orders can only be cancelled before the store accepts.' : 'Customers can only cancel pending orders.' });
            }
            data.order_status = 'cancelled';
          }
        } else if (isVendor || isFoodAdmin(req.user)) {
          if (locationUpdate.deliver_location !== undefined) data.deliver_location = locationUpdate.deliver_location;
          if (driver_id != null) data.driver_id = Number(driver_id);
          if (order_status && order_status !== existingOrder.order_status) {
            const allowed = (isGroceryOrder(existingOrder) ? GROCERY_VENDOR_STATUS : FOOD_VENDOR_STATUS)[existingOrder.order_status] || [];
            if (!isFoodAdmin(req.user) && !allowed.includes(order_status)) {
              return res.status(400).json({ successful: false, message: 'Invalid status transition.' });
            }
            data.order_status = order_status;
            Object.assign(data, statusTimestampData(order_status, existingOrder));
          }
        } else if (isDriver) {
          if (order_status && order_status !== existingOrder.order_status) {
            const allowed = FOOD_DRIVER_STATUS[existingOrder.order_status] || [];
            if (!allowed.includes(order_status)) {
              return res.status(400).json({ successful: false, message: 'Invalid status transition.' });
            }
            data.order_status = order_status;
            Object.assign(data, statusTimestampData(order_status, existingOrder));
          }
        }

        const updatedOrder = await prisma.food_order.update({
            where: { food_order_id: order_id },
            data,
            include: {
                user: { select: { name: true, email: true, language: true } },
                food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
                vendor_type: { select: { vendor_type: true } },
                driver_profile: { include: { user: { select: { name: true } } } }
            }
        });

        if (isFoodSettledStatus(updatedOrder.order_status)) {
          await tryCreditSettledFoodOrder(updatedOrder).catch((err) =>
            console.error('[food] wallet credit failed:', err?.message || err),
          );
        } else if (updatedOrder.order_status === 'cancelled' && existingOrder.wallet_credited_at) {
          await reverseFoodOrderWalletCredit(existingOrder).catch((err) =>
            console.error('[food] wallet reverse failed:', err?.message || err),
          );
        }

          const statusMailMap = {
              'preparing': { sub: 'preparing', msg: 'preparing' },
              'dispatched': { sub: 'dispatched', msg: 'dispatched' },
              'delivered': { sub: 'delivered', msg: 'delivered' },
              'cancelled': { sub: 'cancelled', msg: 'cancelled' }
          };

          const mailInfo = statusMailMap[order_status];

          if (mailInfo && updatedOrder.user?.email) {
              try {
                  let plainEmail = updatedOrder.user.email;
                  try {
                      plainEmail = decrypt(plainEmail);
                  } catch {
                      // Emails are stored plaintext while encryptedFields is empty.
                  }
                  const buyerLng = emailLngFromUser(updatedOrder.user);
                  const tStatus = i18next.getFixedT(buyerLng);
                  mailerEvents.emit('send_email', {
                      templateName: 'food-order-status',
                      variables: {
                          order_id: updatedOrder.food_order_id,
                          status_title: tStatus(`emails.food_status.subjects.${mailInfo.sub}`),
                          status_message: tStatus(`emails.food_status.messages.${mailInfo.msg}`),
                      },
                      to: plainEmail,
                      subjectKey: `emails.food_status.subjects.${mailInfo.sub}`,
                      user: updatedOrder.user,
                  });
              } catch (mailErr) {
                  console.error('food order status email failed:', mailErr.message);
              }
          }

        const io = req.app.get('io');
        io?.to(`user-${updatedOrder.user_id}`)?.emit(`order-status-update-${order_id}`, {
            status: updatedOrder.order_status,
            order_status: updatedOrder.order_status,
            order_flow: orderFlow(updatedOrder),
            vertical: orderFlow(updatedOrder),
            message: `Your ${isGroceryOrder(updatedOrder) ? 'grocery' : 'food'} order status has been updated to ${updatedOrder.order_status}`,
            updated_at: updatedOrder.last_update
        });
        // This route accepts an arbitrary order_status, so notifyFoodCustomer() no-ops on any
        // status with no customer-facing copy rather than inventing a title for it.
        notifyFoodCustomer(io, {
            userId: updatedOrder.user_id, orderId: order_id, status: updatedOrder.order_status,
            flow: orderFlow(updatedOrder),
        });

        const nextStatus = updatedOrder.order_status;
        if (
          (isVendor || isFoodAdmin(req.user)) &&
          nextStatus &&
          foodCourierOfferableStatuses().includes(nextStatus)
        ) {
          maybeDispatchFoodDelivery(io, updatedOrder);
        }

        // Optional
        if (order_status === 'delivered') {
            console.log(`📧 Dispatching delivery completion email to ${updatedOrder.user.email}`);
            
        }

        res.json({ 
            successful: true, 
            message: "Order updated successfully.", 
            data: {
                ...updatedOrder,
                deliver_location: publicDeliverLocation(updatedOrder),
                fulfillment_mode: isFoodPickupOrder(updatedOrder) ? 'pickup' : 'delivery',
            },
        });

    } catch (err) {
        console.error("❌ Update Order Error:", err.message);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/* DELETE FOOD ORDER */
router.delete('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.food_order.findUnique({
      where: { food_order_id: parseInt(req.params.id) },
    });
    if (!existing) return res.status(404).json({ error: 'Food order not found' });
    if (existing.user_id !== req.user.user_id && req.user.role !== 'ADMIN')
      return res.status(403).json({ error: 'Forbidden' });

    await prisma.food_order.delete({
      where: { food_order_id: parseInt(req.params.id) },
    });

    res.json({ message: 'Food order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete food order' });
  }
});

//======================================================================================================
//========================================= FOOD ORDER ITEMS =========================================
//======================================================================================================

// Non-sensitive food_order fields safe to expose via order-items includes.
// NEVER add otp_code, deliver_location, delivery_instructions, or payment_intent_id
// here — those are proof-of-delivery / PII and must not leak through this route.
const SAFE_FOOD_ORDER_SELECT = {
  food_order_id: true,
  user_id: true,
  vendor_id: true,
  driver_id: true,
  order_status: true,
  order_flow: true,
  total_amount: true,
  delivery_fee: true,
  driver_earning: true,
  platform_fee: true,
  created_at: true,
  delivered_at: true,
  vendor_type_id: true,
  ispaid: true,
  payment_method: true,
  last_update: true,
  scheduled_time: true,
  delivery_window_start: true,
  delivery_window_end: true,
  store_accepted_at: true,
  packed_at: true,
  ready_for_pickup_at: true,
  driver_accepted_at: true,
  driver_en_route_at: true,
  picked_up_at: true,
  delivery_proof_at: true,
  grocery_substitutions: true,
  tip_amount: true,
};

// Authorize a food_order_item for the caller: admin, the customer who placed the
// order, or the owner of the vendor the order belongs to. `orderItem.food_order`
// must include at least { user_id, vendor_id }.
async function canManageOrderItem(user, orderItem) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  const fo = orderItem?.food_order;
  if (!fo) return false;
  if (fo.user_id === user.user_id) return true;
  if (fo.vendor_id != null) {
    const owned = await prisma.food_vendor.findFirst({
      where: { vendor_id: fo.vendor_id, owner_id: user.user_id },
      select: { vendor_id: true },
    });
    return Boolean(owned);
  }
  return false;
}

/* GET FOOD ORDER ITEMS — scoped to the caller (customer, vendor owner, or admin).
 * Authenticated + never serializes food_order.otp_code / deliver_location / PII. */
router.get('/order-items', authenticateToken, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'ADMIN';
    let where = {};
    if (!isAdmin) {
      const myVendors = await prisma.food_vendor.findMany({
        where: { owner_id: req.user.user_id },
        select: { vendor_id: true },
      });
      const vendorIds = myVendors.map((v) => v.vendor_id);
      where = {
        food_order: {
          OR: [
            { user_id: req.user.user_id },
            ...(vendorIds.length ? [{ vendor_id: { in: vendorIds } }] : []),
          ],
        },
      };
    }
    // For an admin `where` is {}, so unbounded this returned every order item on the platform
    // with three relations joined on each — the single most expensive query in this file.
    const orderItems = await paginate(
      req,
      res,
      ({ take, skip }) => prisma.food_order_items.findMany({
        where,
        take,
        skip,
        orderBy: { food_order_detail_id: 'desc' },
        include: {
          food_item: true,
          food_order: { select: SAFE_FOOD_ORDER_SELECT },
          vendor_type: true,
        },
      }),
      { total: () => prisma.food_order_items.count({ where }) },
    );
    res.json(orderItems);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food order items' });
  }
});

/* GET FOOD ORDER ITEM BY ID — authenticated + ownership-scoped. */
router.get('/order-items/:id', authenticateToken, async (req, res) => {
  try {
    const orderItem = await prisma.food_order_items.findUnique({
      where: { food_order_detail_id: parseInt(req.params.id) },
      include: {
        food_item: true,
        food_order: { select: SAFE_FOOD_ORDER_SELECT },
        vendor_type: true,
      },
    });

    if (!orderItem) {
      return res.status(404).json({ error: 'Food order item not found' });
    }
    if (!(await canManageOrderItem(req.user, orderItem))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(orderItem);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food order item' });
  }
});

/* ADD ITEM TO FOOD ORDER (Secure Version) */
/* ADD ITEM TO FOOD ORDER (With Stock Validation) */
router.post('/order-items', authenticateToken, async (req, res) => {
  try {
    const { order_id, food_item_id, qty } = req.body;

    const parentOrder = await prisma.food_order.findUnique({
      where: { food_order_id: Number(order_id) },
      include: { food_vendor: { select: { owner_id: true } } },
    });
    if (!parentOrder) return res.status(404).json({ successful: false, message: 'Order not found.' });
    const canAdd = isFoodAdmin(req.user)
      || parentOrder.user_id === req.user.user_id
      || parentOrder.food_vendor?.owner_id === req.user.user_id;
    if (!canAdd) return res.status(403).json({ successful: false, message: 'Forbidden' });

   
    const item = await prisma.food_item.findUnique({
      where: { food_item_id: Number(food_item_id) }
    });

    if (!item) return res.status(404).json({ successful: false, message: "Item not found." });

    if (item.stock_qty < Number(qty)) {
      return res.status(400).json({ 
          successful: false, 
          message: `Insufficient stock. Only ${item.stock_qty} items available.` 
      });
    }

    const result = await prisma.food_order_items.create({
      data: {
        order_id: Number(order_id),
        food_item_id: Number(food_item_id),
        qty: Number(qty),
        price_item: item.price,
        vendor_type_id: item.vendor_type_id
      }
    });

    res.status(201).json({ successful: true, data: result });

  } catch (err) {
    res.status(500).json({ successful: false, message: "Failed to add item." });
  }
});


/**
 * FINAL PRODUCTION CHECKOUT: Inventory Management + Precision Billing + Dual Emails
 * Handles: Stock validation/decrement, Rounding fixes, and i18n Subject Interpolation.
 * PATCH /food/orders/:order_id/checkout
 */
router.patch('/orders/:order_id/checkout', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const { transaction_id } = req.body;

    if (!transaction_id) return res.status(402).json({ successful: false, message: 'Payment required.' });

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        food_order_items: { include: { food_item: true } },
        food_vendor: { include: { user: true, vendor_type: { select: { vendor_type: true } } } },
        vendor_type: { select: { vendor_type: true } },
        user: true,
      }
    });

    if (!order) return res.status(404).json({ successful: false, message: 'Order not found.' });
    if (!isFoodAdmin(req.user) && order.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    if (!order.user?.country) return res.status(400).json({ successful: false, message: "Incomplete order or user profile." });
    if (order.ispaid) {
      return res.json({ successful: true, data: order, message: 'Already paid.' });
    }

    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ successful: false, message: 'Payments are temporarily unavailable.' });
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(String(transaction_id));
    } catch {
      return res.status(400).json({ successful: false, message: 'Invalid payment reference.' });
    }
    if (!pi || pi.status !== 'succeeded') {
      return res.status(409).json({ successful: false, message: 'Payment has not succeeded.' });
    }
    if (pi.metadata?.user_id && pi.metadata.user_id !== String(req.user.user_id)) {
      return res.status(403).json({ successful: false, message: 'This payment does not belong to your account.' });
    }
    if (pi.metadata?.order_id && String(pi.metadata.order_id) !== String(order_id)) {
      return res.status(403).json({ successful: false, message: 'This payment is not for this order.' });
    }

    const regionData = getRegionData(order.user.country);
    const userCurrency = order.user.currency || regionData.currency || "CAD";

    const orderLines = order.food_order_items.map((item) => ({
      qty: item.qty,
      price: item.price_item,
    }));
    const deliveryFee = isFoodPickupOrder(order)
      ? 0
      : await resolveFoodDeliveryFee({
          vendorLocation: order.food_vendor?.location,
          deliverLocation: order.deliver_location,
          fallbackFee: order.delivery_fee,
        });
    // Keep the promo the order was created with — recomputing without it used to
    // silently restore full price on the row the buyer already paid a discount on.
    const pricing = calculateFoodOrderPricing(
      orderLines,
      order.user.country,
      deliveryFee,
      isFoodPickupOrder(order) ? 0 : (order.tip_amount || 0),
      order.promo_discount || 0,
    );
    const paidAmt = (pi.amount_received ?? pi.amount) / 100;
    if (Math.round(paidAmt * 100) !== Math.round(Number(pricing.totalAmount) * 100)) {
      return res.status(400).json({ successful: false, message: 'Payment amount does not match the order total.' });
    }

    const checkoutFlow = orderFlow(order);
    const checkoutStatus = checkoutFlow === 'grocery' ? 'pending' : 'confirmed';

	    const finalOrder = await prisma.$transaction(async (tx) => {
	      return await tx.food_order.update({
	        where: { food_order_id: order_id },
	        data: {
            total_amount: pricing.totalAmount,
            delivery_fee: pricing.deliveryFee,
            platform_fee: pricing.platformFee,
            tip_amount: pricing.tipAmount,
            order_status: checkoutStatus,
            order_flow: checkoutFlow,
            ispaid: true,
            payment_method: 'CARD',
            payment_intent_id: String(transaction_id),
            ...statusTimestampData(checkoutStatus, order),
          },
	        include: {
            food_order_items: { include: { food_item: true } },
            user: true,
            food_vendor: { include: { user: true, vendor_type: { select: { vendor_type: true } } } },
            vendor_type: { select: { vendor_type: true } },
          }
	      });
    }, { timeout: 20000 });

    // `io` was referenced below (trackAdEvent) but never declared in this handler — a latent
    // ReferenceError that fired only when the vendor happened to have an ACTIVE ad campaign.
    const io = req.app.get('io');

    notifyFoodCustomer(io, {
      userId: finalOrder.user_id,
      orderId: finalOrder.food_order_id,
      status: checkoutStatus,
      flow: checkoutFlow,
    });

    emitOrderStatus(io, finalOrder, checkoutStatus);
    maybeDispatchFoodDelivery(io, finalOrder);

    const activeAd = await prisma.ads_campaign.findFirst({
      where: { status: "ACTIVE", ads_wallet: { user_id: finalOrder.food_vendor.owner_id } }
    });
    if (activeAd) {
      await trackAdEvent(
        activeAd.campaign_id,
        "impression",
        finalOrder.user_id,
        req.ip || "127.0.0.1",
        io
      ).catch(() => null);
    }

    const emailPayload = {
        order_id: finalOrder.food_order_id,
        items: finalOrder.food_order_items.map(i => ({ name: i.food_item.name, qty: i.qty, price: i.price_item.toFixed(2) })),
        currency: userCurrency, // 🔥
        subtotal: pricing.subtotal.toFixed(2),
        delivery_fee: pricing.deliveryFee.toFixed(2),
        gov_tax: pricing.govTax.toFixed(2),
        platform_fee: pricing.platformFee.toFixed(2),
        total_amount: pricing.totalAmount.toFixed(2),
        delivery_location: publicDeliverLocation(finalOrder)
    };

    const buyerEmail = decrypt(finalOrder.user.email);
    sendEmail(
      'food-order-receipt',
      { ...emailPayload, isVendor: false },
      buyerEmail,
      'emails.food.subjects.order_confirm_buyer',
      emailLngFromUser(finalOrder.user),
    ).catch((err) => console.error('Food buyer email failed:', err?.message || err));

    const vendorUser = finalOrder.food_vendor?.user;
    if (vendorUser?.email) {
      const vendorEmail = decrypt(vendorUser.email);
      sendEmail(
        'food-order-receipt',
        { ...emailPayload, isVendor: true },
        vendorEmail,
        'emails.food.subjects.new_order_vendor',
        emailLngFromUser(vendorUser),
      ).catch((err) => console.error('Food vendor email failed:', err?.message || err));
    }

    res.json({ successful: true, message: 'Order confirmed!', data: finalOrder });
  } catch (err) {
    res.status(500).json({ successful: false, message: clientErrorMessage(err) });
  }
});


/* UPDATE FOOD ORDER ITEM — authenticated + ownership-scoped. */
router.put('/order-items/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.food_order_items.findUnique({
      where: { food_order_detail_id: parseInt(req.params.id) },
      include: { food_order: { select: { user_id: true, vendor_id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Food order item not found' });
    if (!(await canManageOrderItem(req.user, existing))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { order_id, food_item_id, qty, price_item, special_instructions, vendor_type_id } = req.body;
    
    const orderItem = await prisma.food_order_items.update({
      where: { food_order_detail_id: parseInt(req.params.id) },
      data: {
        order_id: order_id ? parseInt(order_id) : undefined,
        food_item_id: food_item_id ? parseInt(food_item_id) : undefined,
        qty: qty ? parseInt(qty) : undefined,
        price_item: price_item ? parseFloat(price_item) : undefined,
        special_instructions,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : undefined,
      },
    });
    
    res.json(orderItem);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update food order item' });
  }
});

/* DELETE FOOD ORDER ITEM — authenticated + ownership-scoped. */
router.delete('/order-items/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.food_order_items.findUnique({
      where: { food_order_detail_id: parseInt(req.params.id) },
      include: { food_order: { select: { user_id: true, vendor_id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Food order item not found' });
    if (!(await canManageOrderItem(req.user, existing))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.food_order_items.delete({
      where: { food_order_detail_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Food order item deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete food order item' });
  }
});

//======================================================================================================
//============================================ FOOD VENDOR ============================================
//======================================================================================================

/* GET ALL FOOD VENDORS (public customer-facing — only approved/active vendors) */
router.get('/vendors', optionalAuth, async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const { lat, lng, vendor_type_id, type } = req.query;

    // #5: exclude vendors that have paused orders from the public browse (showAll is the
    // seller/admin view, which still sees everything).
    let where = showAll ? {} : { is_active: true, is_paused: false };

    // Resolve type by NAME from vendor_type (IDs are not stable across seeds/DBs).
    // Hardcoding restaurant→1 previously hid real Restaurant rows when that name lived on another id.
    async function vendorTypeIdsForNames(names) {
      return findVendorTypeIdsByNames(prisma, names);
    }

    if (vendor_type_id) {
      where.vendor_type_id = parseInt(vendor_type_id);
    } else if (type) {
      const names = vendorTypeNamesForAlias(type);
      const ids = await vendorTypeIdsForNames(names);
      if (ids.length === 1) where.vendor_type_id = ids[0];
      else if (ids.length > 1) where.vendor_type_id = { in: ids };
    } else if (!showAll) {
      // Restaurant browse: show Restaurant rows + legacy vendors created without a type.
      Object.assign(where, await restaurantVendorTypeWhere(prisma));
    }

    // Public browse endpoint. Unbounded, it returned every vendor on the platform along with
    // each vendor's full item catalogue and every order id — one request, arbitrary work.
    const browsePage = parsePagination(req);
    const [vendors, activeAd] = await Promise.all([
      prisma.food_vendor.findMany({
        where,
        take: browsePage.take,
        skip: browsePage.skip,
        orderBy: { vendor_id: 'desc' },
        include: {
          user: { select: verticalIdentityUserSelect },
          vendor_type: true,
          food_category: true,
          food_item: {
            include: {
              food_item_pics: true
            }
          },
          // Ids only: this route is public (and `?all=1` even bypasses is_active/is_paused), so a
          // bare `food_order: true` serialised every customer's deliver_location, otp_code,
          // delivery_instructions and payment_intent_id to anonymous callers. Callers only ever
          // used this to count orders, so the array shape is preserved.
          food_order: { select: { food_order_id: true } },
        },
      }),
      selectBestAd(req.adContext).catch(() => null)
    ]);

    vendors.forEach((v) => applyVerticalIdentity(v.user, 'food'));

    // When the buyer shares a pin, only surface vendors within delivery range.
    // Vendors missing coords stay visible so pre-geocode rows are not wiped from browse.
    let filtered = vendors;
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      if (Number.isFinite(userLat) && Number.isFinite(userLng)) {
        filtered = vendors.filter((v) => {
          if (isEventCateringType(v.vendor_type?.vendor_type)) return true;
          if (v.lat == null || v.long == null) return true;
          const dist = haversineKm(userLat, userLng, v.lat, v.long);
          return dist !== null && dist <= FOOD_DELIVERY_MAX_KM;
        });
      }
    }

    if (activeAd) {
      const adVendor = await prisma.food_vendor.findFirst({
        where: { owner_id: activeAd.advertiser_id, is_active: true },
        include: {
          vendor_type: true,
          food_category: true,
          food_item: true,
        }
      });

      const region = getRegionData(req.adContext?.country || "default");

      if (adVendor && adVendor.is_open) {
        let deliveryFee = 0;
        if (lat && lng && adVendor.location) {
          const matrix = await getDistanceMatrix(adVendor.location, `${lat},${lng}`);
          deliveryFee = calculateFoodDeliveryFee(matrix?.distance?.value) ?? 0;
        }

        const promotedCard = {
          ...adVendor,
          vendor_id: adVendor.vendor_id,
          vendor_name: activeAd.headline || adVendor.vendor_name,
          cuisine_type: adVendor.cuisine_type,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || "ORDER_NOW",
          delivery_fee: deliveryFee,
          currency: region.currency,
          tax_rate: region.tax,
          sponsored: true,
          is_generic_ad: false
        };

        filtered.unshift(promotedCard);
      } else {
        const genericAdCard = {
          vendor_id: `ad_${activeAd.campaign_id}`,
          owner_id: activeAd.advertiser_id,
          vendor_name: activeAd.headline || activeAd.title,
          cuisine_type: "Sponsored",
          is_open: true,
          is_active: true,
          min_order_value: 0,
          location: activeAd.description,
          vendor_type_id: null,
          opening_hours: null,
          closing_hours: null,
          is_paused: false,
          lat: null,
          long: null,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || "LEARN_MORE",
          media_url: activeAd.media_url,
          delivery_fee: 0,
          currency: region.currency,
          tax_rate: region.tax,
          sponsored: true,
          is_generic_ad: true,
          food_category: [],
          food_item: []
        };

        filtered.unshift(genericAdCard);
      }
    }

    // Frontend cards often read `name`; DB column is vendor_name.
    // Attach Opportunities offers / badges for the current viewer when possible.
    const named = filtered.map((v) => ({
      ...toPublicVendor(v),
      name: v.vendor_name || v.user?.name || null,
    }));
    const payload = await attachFoodVendorOffers(named, req.user?.user_id ?? null);

    // `vendors.length` (pre distance-filter, pre ad injection) is what the page size actually
    // bounded, so it is the honest signal for whether another page exists.
    setPaginationHeaders(res, browsePage, vendors.length);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food vendors' });
  }
});
/* GET FOOD VENDOR BY OWNER — allows vendor to access their own dashboard before approval */
router.get('/vendors/mine', authenticateToken, async (req, res) => {
  try {
    const { vendor_type_id } = req.query;
    let where = { owner_id: req.user.user_id };
    if (vendor_type_id) {
      where.vendor_type_id = parseInt(vendor_type_id);
    }

    const vendor = await prisma.food_vendor.findFirst({
      where,
      include: {
        vendor_type: true,
        food_category: true,
        food_item: {
          include: {
            food_item_pics: true,
          },
        },
        food_order: true,
        food_vendor_closure: {
          where: { is_active: true },
          orderBy: [{ starts_at: 'asc' }, { closure_id: 'asc' }],
          take: 50,
        },
      },
    });
    if (!vendor) return res.status(404).json({ successful: false, error: 'No vendor profile found.' });

    // Overview Avg Rating / review_count — aggregate only (not derived from food_order rows).
    const { rating, review_count } = await getFoodVendorRatingStats(vendor.vendor_id);
    res.json({ successful: true, data: { ...vendor, rating, review_count } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vendor profile' });
  }
});

/* GET FOOD VENDOR BY ID */
router.get('/vendors/:id', optionalAuth, async (req, res) => {
  try {
    const vendor = await prisma.food_vendor.findUnique({
      where: { vendor_id: parseInt(req.params.id) },
      include: {
        user: { select: verticalIdentityUserSelect },
        vendor_type: true,
        food_category: true,
        food_item: true,
        // Ids only — public route, same reasoning as GET /vendors above.
        food_order: { select: { food_order_id: true } },
      },
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Food vendor not found' });
    }
    applyVerticalIdentity(vendor.user, 'food');

    const [enriched] = await attachFoodVendorOffers(
      [{ ...vendor, name: vendor.vendor_name || vendor.user?.name || null }],
      req.user?.user_id ?? null,
    );
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch food vendor' });
  }
});

/* CREATE FOOD VENDOR */
router.post('/vendors', authenticateToken, async (req, res) => {
  try {
    const { vendor_name, cuisine_type, is_open, min_order_value, location, vendor_type_id, opening_hours, closing_hours, is_paused, operations_status, operations_note, lat, long } = req.body;

    if (!vendor_name) {
      return res.status(400).json({ error: 'vendor_name is required.' });
    }

    // Ownership always comes from the authenticated user — never trust body.user_id / owner_id.
    const ownerId = req.user.user_id;
    let resolvedTypeId = vendor_type_id ? parseInt(vendor_type_id) : null;
    if (!resolvedTypeId) {
      resolvedTypeId = await resolveRestaurantVendorTypeId(prisma);
    }
    if (!resolvedTypeId) {
      return res.status(400).json({ error: 'Restaurant vendor_type is not configured in this environment.' });
    }

    const normalizedOpsStatus = normalizeVendorOperationsStatus(operations_status, is_paused ? 'paused' : 'normal');
    if (!normalizedOpsStatus) {
      return res.status(400).json({ error: 'Invalid operations_status.' });
    }

    const vendor = await prisma.food_vendor.create({
      data: {
        owner_id: ownerId,
        vendor_name,
        cuisine_type,
        is_open: is_open || false,
        is_active: true, // Bypass KYC for initial restaurant experience
        min_order_value: min_order_value ? parseFloat(min_order_value) : null,
        location,
        vendor_type_id: resolvedTypeId,
        opening_hours: opening_hours ?? null,
        closing_hours: closing_hours ?? null,
        is_paused: is_paused ?? false,
        operations_status: normalizedOpsStatus,
        operations_note: operations_note ? String(operations_note).trim().slice(0, 240) : null,
        lat: lat ? parseFloat(lat) : null,
        long: long ? parseFloat(long) : null,
      },
    });

    // Return a virtual vendor_status field as active since we auto-activated
    res.status(201).json({ ...vendor, vendor_status: 'active' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create food vendor' });
  }
});

/* UPDATE FOOD VENDOR */
router.put('/vendors/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const { vendor_name, cuisine_type, is_open, is_active, min_order_value, location, vendor_type_id, opening_hours, closing_hours, is_paused, operations_status, operations_note, lat, long, logo_url, cover_url, banner_url, max_party_size } = req.body;

    // isFoodVendor confirms the caller is a vendor but not that they own THIS :id (owner_id
    // isn't unique). Bind the update to a vendor the caller actually owns.
    const targetId = parseInt(req.params.id);
    const owned = await prisma.food_vendor.findFirst({ where: { vendor_id: targetId, owner_id: req.user.user_id }, select: { vendor_id: true, location: true, lat: true, long: true } });
    if (!owned) return res.status(403).json({ error: "You don't own this vendor" });

    // Keep location text and lat/long in lock-step. Courier dispatch matches on lat/long while
    // the driver UI label uses `location` — updating only the string left drivers matching the
    // old city and showing stale pickup pins.
    let nextLat = lat !== undefined ? (lat != null && lat !== '' ? parseFloat(lat) : null) : undefined;
    let nextLong = long !== undefined ? (long != null && long !== '' ? parseFloat(long) : null) : undefined;
    const locationChanging = location !== undefined && location != null && String(location).trim() !== '' &&
      String(location).trim() !== String(owned.location || '').trim();
    if (locationChanging) {
      const hasCoords = Number.isFinite(nextLat) && Number.isFinite(nextLong);
      if (!hasCoords) {
        const geo = await geocodeAddress(String(location).trim());
        if (geo?.lat != null && geo?.lng != null) {
          nextLat = geo.lat;
          nextLong = geo.lng;
        } else {
          return res.status(400).json({
            error: 'Could not resolve coordinates for this address. Pick an address from suggestions or try a more specific location.',
          });
        }
      }
    }
    const normalizedOpsStatus = operations_status !== undefined
      ? normalizeVendorOperationsStatus(operations_status, is_paused ? 'paused' : 'normal')
      : (is_paused !== undefined ? (is_paused ? 'paused' : 'normal') : undefined);
    if (operations_status !== undefined && !normalizedOpsStatus) {
      return res.status(400).json({ error: 'Invalid operations_status.' });
    }
    const nextPaused = is_paused !== undefined
      ? is_paused
      : (normalizedOpsStatus === 'paused' ? true : undefined);

    const vendor = await prisma.food_vendor.update({
      where: { vendor_id: targetId },
      data: {
        vendor_name,
        cuisine_type,
        is_open,
        // Owners can (re)activate their own store: creation already auto-activates,
        // so a store left inactive had no way back and stayed stuck "Under Review".
        is_active: typeof is_active === 'boolean' ? is_active : undefined,
        min_order_value: min_order_value ? parseFloat(min_order_value) : undefined,
        location,
        vendor_type_id: vendor_type_id ? parseInt(vendor_type_id) : undefined,
        opening_hours: opening_hours ?? undefined,
        closing_hours: closing_hours ?? undefined,
        is_paused: nextPaused,
        operations_status: normalizedOpsStatus,
        operations_note: operations_note !== undefined ? (operations_note ? String(operations_note).trim().slice(0, 240) : null) : undefined,
        lat: nextLat !== undefined ? nextLat : undefined,
        long: nextLong !== undefined ? nextLong : undefined,
        logo_url: logo_url !== undefined ? (logo_url || null) : undefined,
        cover_url: cover_url !== undefined ? (cover_url || null) : undefined,
        // Same clear semantics as cover_url: null/"" wipe the column so Remove banner persists.
        banner_url: banner_url !== undefined ? (banner_url || null) : undefined,
        // null clears an unset/cleared seating field; undefined leaves the column alone.
        max_party_size: max_party_size === null || max_party_size === ""
          ? null
          : max_party_size !== undefined
            ? parseInt(max_party_size, 10)
            : undefined,
      },
    });

    res.json(vendor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update food vendor' });
  }
});

/* UPLOAD FOOD STOREFRONT BRANDING (logo | cover)
 * POST /food/vendors/:id/branding  (multipart: image + type)
 * Mirrors the channel /branding/upload pattern. Backs food + grocery + catering + floral
 * (all food_vendor rows). Ownership enforced by isFoodVendor. */
router.post('/vendors/:id/branding', authenticateToken, isFoodVendor, brandingUpload.single('image'), async (req, res) => {
  try {
    const type = String(req.body.type || '').toLowerCase();
    if (!req.file || !['logo', 'cover', 'banner'].includes(type)) {
      return res.status(400).json({ successful: false, message: 'A valid image file and type ("logo" | "cover" | "banner") are required.' });
    }
    if (!ALLOWED_IMAGE_MIME.has(req.file.mimetype)) {
      return res.status(400).json({ successful: false, message: 'Unsupported image type. Use JPEG, PNG, WebP or GIF.' });
    }
    const vendor_id = parseInt(req.params.id);
    // isFoodVendor only proves the caller owns SOME vendor (owner_id lookup, not bound to
    // :id, and owner_id is not unique). Authoritatively bind the write to a vendor the
    // caller actually owns before touching it.
    const owned = await prisma.food_vendor.findFirst({ where: { vendor_id, owner_id: req.user.user_id }, select: { vendor_id: true } });
    if (!owned) {
      return res.status(403).json({ successful: false, message: "You don't own this storefront." });
    }

    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const blobName = `storefront/food-${type}-${vendor_id}-${Date.now()}.${ext}`;
    const imageUrl = await uploadVideoStream(
      process.env.AZURE_THUMBNAIL_CONTAINER,
      blobName,
      req.file.buffer,
      req.file.mimetype,
      { access: 'blob' },
    );

    const data = type === 'logo' ? { logo_url: imageUrl } : type === 'banner' ? { banner_url: imageUrl } : { cover_url: imageUrl };
    const updated = await prisma.food_vendor.update({ where: { vendor_id }, data });
    res.json({ successful: true, message: `Storefront ${type} updated.`, url: imageUrl, data: updated });
  } catch (err) {
    console.error('food branding upload error:', err);
    res.status(500).json({ successful: false, message: 'Failed to upload storefront image' });
  }
});

/* DELETE FOOD VENDOR */
router.delete('/vendors/:id', authenticateToken, isFoodVendor, async (req, res) => {
  try {
    const vendor_id = parseInt(req.params.id);
    const owned = await prisma.food_vendor.findFirst({
      where: { vendor_id, owner_id: req.user.user_id },
      select: { vendor_id: true },
    });
    if (!owned) return res.status(403).json({ successful: false, message: "You don't own this storefront." });
    await prisma.food_vendor.delete({
      where: { vendor_id },
    });
    
    res.json({ message: 'Food vendor deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete food vendor' });
  }
});



/**
 * Task D4: Driver picks up order from Vendor
 * PATCH /food/orders/:order_id/picked-up
 */
router.patch('/orders/:order_id/picked-up', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (['delivered', 'cancelled'].includes(order.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order is already closed.' });
    }

    const isPickup = isFoodPickupOrder(order);
    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    const isAssignedDriver = Boolean(driverRecord && order.driver_id === driverRecord.driver_id);
    const isVendorOwner = order.food_vendor?.owner_id === req.user.user_id || req.user.role === 'ADMIN';

    if (isPickup) {
      if (!isVendorOwner) {
        return res.status(403).json({ successful: false, message: 'Only the restaurant can mark a self-pickup order as collected.' });
      }
    } else if (!isAssignedDriver) {
      return res.status(403).json({ successful: false, message: 'Only the assigned courier can pick up this order.' });
    }

    if (isGroceryOrder(order) && order.order_status !== 'ready_for_pickup') {
      return res.status(409).json({ successful: false, message: 'Groceries must be marked ready by the store before pickup.' });
    }
    assertNoPendingGrocerySubstitutions(order);
    if (!isPickup && !isGroceryOrder(order) && !['ready_for_pickup', 'dispatched'].includes(order.order_status)) {
      return res.status(409).json({ successful: false, message: 'This order is not ready for pickup.' });
    }

    // Proof-of-delivery OTP is courier-delivery only — guests never need a code for self-pickup.
    const otp = isPickup ? null : crypto.randomInt(100000, 1000000).toString();

    const pickedUpOrder = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        order_status: 'picked_up',
        otp_code: otp,
        ...(isPickup ? { delivered_at: new Date() } : {}),
        picked_up_at: new Date(),
        last_update: new Date(),
        driver_earning: isGroceryOrder(order) ? (order.driver_earning ?? groceryDriverEarning(order)) : order.driver_earning,
      },
      include: ORDER_FLOW_INCLUDE,
    });

    await tryCreditSettledFoodOrder(pickedUpOrder).catch((err) =>
      console.error('[food] wallet credit on pickup failed:', err?.message || err),
    );

    // Scoped to the customer's room — the OTP must not be broadcast to every client.
    io.to(`user-${pickedUpOrder.user_id}`).emit(`order-update-${order_id}`, {
      status: 'picked_up',
      ...(otp ? { otp } : {}),
    });
    io.to(`user-${pickedUpOrder.user_id}`).emit(`order-status-update-${order_id}`, { order_status: 'picked_up', status: 'picked_up' });
    emitOrderStatus(io, pickedUpOrder, 'picked_up');
    // Deliberately WITHOUT the OTP: this fans out to web push, which renders on a lock screen.
    // The handoff code stays on the authenticated socket/API surface only.
    notifyFoodCustomer(io, {
      userId: pickedUpOrder.user_id,
      orderId: order_id,
      status: 'picked_up',
      flow: orderFlow(pickedUpOrder),
      body: isPickup ? 'You have collected your order. Enjoy!' : undefined,
    });

    return res.json({
      successful: true,
      message: isPickup ? 'Self-pickup marked complete.' : 'Order picked up. OTP sent to customer.',
      ...(otp ? { otp } : {}),
    });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        successful: false,
        message: err.message,
        pending_substitutions: err.pendingSubstitutions || undefined,
      });
    }
    if (err?.code === 'P2025') {
      return res.status(404).json({ error: 'Order not found' });
    }
    console.error('Failed to update food order pickup status:', err);
    return res.status(500).json({ error: 'Failed to update pickup status' });
  }
});

router.post('/orders/:order_id/delivery-proof-photo', authenticateToken, deliveryProofUpload.single('image'), async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    if (!req.file) {
      return res.status(400).json({ successful: false, message: 'Delivery proof photo is required.' });
    }
    if (!ALLOWED_IMAGE_MIME.has(req.file.mimetype)) {
      return res.status(400).json({ successful: false, message: 'Unsupported image type.' });
    }

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) {
      return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: ORDER_FLOW_INCLUDE,
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (!isGroceryOrder(order)) {
      return res.status(400).json({ successful: false, message: 'Photo proof uploads are only available for grocery deliveries.' });
    }
    if (order.driver_id !== driverRecord.driver_id) {
      return res.status(403).json({ successful: false, message: 'This order is assigned to another driver.' });
    }
    if (!['picked_up', 'delivery_failed'].includes(order.order_status)) {
      return res.status(409).json({ successful: false, message: 'Order must be picked up before uploading delivery proof.' });
    }
    const limited = await checkRateLimit(`rl:grocery-proof:${driverRecord.driver_id}:${order_id}`, 12, 600);
    if (limited) {
      return res.status(429).json({ successful: false, message: 'Too many proof upload attempts. Please wait and try again.' });
    }

    const extensionByMime = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const ext = extensionByMime[req.file.mimetype] || 'jpg';
    const blobName = `delivery-proofs/food-order-${order_id}-${driverRecord.driver_id}-${Date.now()}.${ext}`;
    const url = await uploadVideoStream(
      process.env.AZURE_THUMBNAIL_CONTAINER,
      blobName,
      req.file.buffer,
      req.file.mimetype,
      { access: 'blob' },
    );

    return res.json({ successful: true, url });
  } catch (err) {
    console.error('[food] delivery proof upload failed:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to upload delivery proof.' });
  }
});

const GROCERY_DELIVERY_ISSUE_REASONS = new Set([
  'store_not_ready',
  'traffic',
  'driver_waiting',
  'customer_unavailable',
  'wrong_address',
  'unsafe_dropoff',
  'weather',
  'vehicle_issue',
  'damaged_order',
  'retry_delivery',
  'return_to_store',
  'refund_review',
  'other',
]);

router.patch('/orders/:order_id/delivery-issue', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid order id.' });
    }
    const reason = String(req.body?.reason || '').trim().toLowerCase();
    if (!GROCERY_DELIVERY_ISSUE_REASONS.has(reason)) {
      return res.status(400).json({ successful: false, message: 'Select a valid delivery issue reason.' });
    }
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const resolutionAction = String(req.body?.resolution_action || '').trim().toLowerCase();
    if (resolutionAction && !GROCERY_FAILURE_RESOLUTION_ACTIONS.has(resolutionAction)) {
      return res.status(400).json({ successful: false, message: 'Select a valid delivery resolution action.' });
    }

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) {
      return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });
    }

    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      include: {
        ...ORDER_FLOW_INCLUDE,
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
    });

    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (!isGroceryOrder(order)) {
      return res.status(400).json({ successful: false, message: 'Delivery issue reporting is only available for grocery deliveries.' });
    }
    if (order.driver_id !== driverRecord.driver_id) {
      return res.status(403).json({ successful: false, message: 'This order is assigned to another driver.' });
    }
    const failedDeliveryReport = GROCERY_FAILED_DELIVERY_REASONS.has(reason) || Boolean(resolutionAction);
    if (failedDeliveryReport && !['picked_up', 'delivery_failed'].includes(order.order_status)) {
      return res.status(409).json({ successful: false, message: 'Failed delivery resolution can be reported after pickup.' });
    }
    if (!failedDeliveryReport && !['confirmed', 'preparing', 'ready_for_pickup', 'dispatched', 'picked_up', 'delivery_failed'].includes(order.order_status)) {
      return res.status(409).json({ successful: false, message: 'Delivery delay can be reported after store acceptance.' });
    }

    const failure = {
      reason,
      note: note || null,
      reported_at: new Date().toISOString(),
      driver_id: driverRecord.driver_id,
    };
    const delayReason = GROCERY_DELIVERY_DELAY_REASONS.has(reason)
      ? {
          reason,
          note: note || null,
          reported_by: req.user.user_id,
          reported_by_role: 'driver',
          reported_at: failure.reported_at,
        }
      : null;
    const failureResolution = resolutionAction
      ? {
          action: resolutionAction,
          status: 'pending',
          note: note || null,
          requested_by: req.user.user_id,
          requested_by_role: 'driver',
          requested_at: failure.reported_at,
        }
      : null;
    const deliveryProof = {
      ...safeJsonObject(order.delivery_proof),
      failure,
    };
    const updated = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        ...(failedDeliveryReport ? { order_status: 'delivery_failed', delivery_proof: deliveryProof } : {}),
        ...(delayReason ? { delivery_delay_reason: delayReason } : {}),
        ...(failureResolution ? { delivery_failure_resolution: failureResolution } : {}),
        last_update: new Date(),
      },
      include: {
        ...ORDER_FLOW_INCLUDE,
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
    });

    const extra = {
      delivery_failure: failure,
      ...(delayReason ? { delivery_delay_reason: delayReason } : {}),
      ...(failureResolution ? { delivery_failure_resolution: failureResolution } : {}),
    };
    const nextStatus = failedDeliveryReport ? 'delivery_failed' : updated.order_status;
    io.to(`user-${order.user_id}`).emit(`order-update-${order_id}`, {
      order_status: nextStatus,
      status: nextStatus,
      ...extra,
    });
    emitOrderStatus(io, updated, nextStatus, extra);
    notifyFoodCustomer(io, {
      userId: order.user_id,
      orderId: order_id,
      status: nextStatus,
      flow: 'grocery',
    });

    return res.json({
      successful: true,
      message: 'Delivery issue reported.',
      data: serializeGroceryDeliveryOrder(updated, driverRecord),
    });
  } catch (err) {
    console.error('[food] failed to report grocery delivery issue:', err?.message || err);
    return res.status(500).json({ successful: false, message: 'Failed to report delivery issue.' });
  }
});

/**
 * Task D5: Complete Delivery with OTP Verification
 * PATCH /food/orders/:order_id/deliver
 */
router.patch('/orders/:order_id/deliver', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const { otp } = req.body;

    const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
    if (!driverRecord) return res.status(403).json({ successful: false, message: 'Not a registered delivery driver' });

    // Cap OTP guesses per order so the 4-digit code can't be brute-forced (10 tries / 10 min).
    const limited = await checkRateLimit(`rl:food-otp:${order_id}`, 10, 600);
    if (limited) {
      return res.status(429).json({ successful: false, message: 'Too many attempts. Please try again later.' });
    }

    // Opt otp_code back in for verify only (global omit #1292). Never serialize it on list/detail.
    const order = await prisma.food_order.findUnique({
      where: { food_order_id: order_id },
      omit: { otp_code: false },
      include: {
        ...ORDER_FLOW_INCLUDE,
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
    });
    if (!order) {
      return res.status(404).json({ successful: false, message: 'Order not found' });
    }

    // Only the assigned courier can complete the delivery — the OTP alone is not enough, since
    // the customer legitimately sees the code and could otherwise close their own order.
    if (order.driver_id !== driverRecord.driver_id) {
      return res.status(403).json({ successful: false, message: 'Only the assigned courier can complete this delivery.' });
    }
    const groceryDelivery = isGroceryOrder(order);
    const proof = sanitizeDeliveryProof(req.body, groceryDelivery ? order : null);
    if (order.order_status !== 'picked_up' && !(groceryDelivery && order.order_status === 'delivery_failed')) {
      return res.status(409).json({ successful: false, message: 'Order must be picked up before delivery completion.' });
    }
    if (groceryDelivery && !proof) {
      return res.status(400).json({ successful: false, message: 'Delivery proof is required for grocery orders.' });
    }
    if (!groceryDelivery && (!order.otp_code || otp == null || String(order.otp_code) !== String(otp))) {
      return res.status(400).json({ successful: false, message: 'Invalid OTP code' });
    }

    const persistedProof = groceryDelivery
      ? { ...safeJsonObject(order.delivery_proof), completion: proof, ...proof }
      : proof;
    const waitCompensation = groceryDelivery ? groceryDriverWaitCompensation(order) : null;
    const finalDriverEarning = groceryDelivery ? groceryDriverFinalEarning(order, waitCompensation) : order.driver_earning;
    const legacyCashPayment = ['COD', 'CASH'].includes(String(order.payment_method || '').toUpperCase());
    const markLegacyCashPaid = legacyCashPayment && !order.ispaid;
    const deliveredOrder = await prisma.food_order.update({
      where: { food_order_id: order_id },
      data: {
        order_status: 'delivered',
        delivered_at: new Date(),
        delivery_proof: persistedProof,
        delivery_proof_at: persistedProof ? new Date() : null,
        driver_earning: finalDriverEarning,
        ...(waitCompensation ? { driver_wait_compensation: waitCompensation } : {}),
        last_update: new Date(),
        otp_code: null,
        ...(markLegacyCashPaid ? { ispaid: true } : {}),
      },
      include: ORDER_FLOW_INCLUDE,
    });

    await tryCreditSettledFoodOrder({
      ...deliveredOrder,
      food_vendor: order.food_vendor,
    }).catch((err) =>
      console.error('[food] wallet credit on deliver failed:', err?.message || err),
    );

    if (markLegacyCashPaid) {
      await settleReferralThenRecruit({
        referralCode: order.referral_code,
        buyerUserId: order.user_id,
        recruitParticipantUserIds: [order.food_vendor?.owner_id].filter(Boolean),
        subtotal: order.platform_fee != null ? order.platform_fee / PLATFORM_FEE_PERCENTAGE : (order.total_amount || 0),
        platformTake: order.platform_fee != null ? order.platform_fee : (order.total_amount || 0) * PLATFORM_FEE_PERCENTAGE,
        orderType: 'food',
        orderRef: order.food_order_id,
        creditRecruiterShares,
      }).catch((err) =>
        console.error('[food] legacy cash referral settlement failed:', err?.message || err),
      );
    }

    const deliveryExtra = {
      proof_type: proof?.type ?? null,
      ...(waitCompensation ? { driver_wait_compensation: waitCompensation } : {}),
    };
    io.to(`user-${order.user_id}`).emit(`order-update-${order_id}`, { status: 'delivered', ...deliveryExtra });
    emitOrderStatus(io, deliveredOrder, 'delivered', deliveryExtra);
    notifyFoodCustomer(io, { userId: order.user_id, orderId: order_id, status: 'delivered', flow: orderFlow(deliveredOrder) });
    clearDeliveryLocation('food', order_id);

    return res.json({
      successful: true,
      message: 'Order delivered successfully!',
      data: groceryDelivery ? serializeGroceryDeliveryOrder(deliveredOrder, driverRecord) : deliveredOrder,
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    if (status >= 500) {
      console.error('[food] delivery verification failed:', err?.message || err);
    }
    return res.status(status).json({
      successful: false,
      message: err?.message || 'Delivery verification failed',
      error: err?.message || 'Delivery verification failed',
    });
  }
});
/**
 * Task V2: Toggle Vendor Open/Closed Status
 * PATCH /food/vendor/:vendor_id/status
 */
router.patch('/vendor/:vendor_id/status', authenticateToken, async (req, res) => {
  try {
    const vendor_id = Number(req.params.vendor_id);
    const { is_open } = req.body; // true or false

    const updatedVendor = await prisma.food_vendor.update({
      where: { vendor_id: vendor_id },
      data: { is_open: is_open }
    });

    return res.json({ 
      successful: true, 
      message: is_open ? "Shop is now Open" : "Shop is now Closed",
      data: updatedVendor 
    });
  } catch (err) {
    return res.status(500).json({ successful: false, message: 'Failed to update vendor status' });
  }
});

/**
 * Task V1: Get All Orders for a Specific Vendor
 * GET /food/vendor/:vendor_id/orders
 */
router.get('/vendor/:vendor_id/orders', authenticateToken, async (req, res) => {
  try {
    const vendor_id = Number(req.params.vendor_id);
    const vendor = await prisma.food_vendor.findUnique({
      where: { vendor_id },
      select: { vendor_id: true, owner_id: true },
    });
    if (!vendor) return res.status(404).json({ successful: false, message: 'Vendor not found' });
    if (vendor.owner_id !== req.user.user_id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ successful: false, message: 'Access denied' });
    }

    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const orders = await prisma.food_order.findMany({
      where: { vendor_id: vendor_id },
      select: {
        food_order_id: true,
        order_status: true,
        order_flow: true,
        total_amount: true,
        platform_fee: true,
        delivery_fee: true,
        driver_earning: true,
        tip_amount: true,
        created_at: true,
        scheduled_time: true,
        delivery_window_start: true,
        delivery_window_end: true,
        store_accepted_at: true,
        packed_at: true,
        ready_for_pickup_at: true,
        driver_accepted_at: true,
        driver_en_route_at: true,
        picked_up_at: true,
        delivered_at: true,
        delivery_proof_at: true,
        grocery_substitutions: true,
        ispaid: true,
        payment_method: true,
        deliver_location: true,
        driver_id: true,
        vendor_type: { select: { vendor_type: true } },
        user: { select: { name: true } },
        food_order_items: {
          select: {
            food_order_detail_id: true,
            qty: true,
            price_item: true,
            food_item: { select: { name: true } },
          },
        },
        driver_profile: {
          select: { driver_profile_id: true, user: { select: { name: true } } },
        },
        // Lightweight 1:1 — optional per-order stars for order cards; not used for Overview avg.
        food_order_rating: {
          select: { rating_id: true, rating: true, review: true, created_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take,
    });

    const annotated = orders.map((o) => ({
      ...o,
      deliver_location: publicDeliverLocation(o),
      fulfillment_mode: isFoodPickupOrder(o) ? 'pickup' : 'delivery',
    }));

    return res.json({ successful: true, count: annotated.length, data: annotated });

  } catch (err) {
    return res.status(500).json({ successful: false, message: 'Failed to fetch vendor orders' });
  }
});

/**
 * GET /food/vendor/:vendor_id/ratings
 * Seller Reviews tab — list all customer ratings for this vendor (indexed by vendor_id).
 */
router.get('/vendor/:vendor_id/ratings', authenticateToken, async (req, res) => {
  try {
    const vendor_id = Number(req.params.vendor_id);
    if (!Number.isInteger(vendor_id) || vendor_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid vendor id' });
    }

    const vendor = await prisma.food_vendor.findUnique({
      where: { vendor_id },
      select: { vendor_id: true, owner_id: true, vendor_name: true },
    });
    if (!vendor) {
      return res.status(404).json({ successful: false, message: 'Vendor not found' });
    }
    if (vendor.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Access denied' });
    }

    const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const skip = Math.max(Number(req.query.offset) || 0, 0);

    const [stats, rows] = await Promise.all([
      getFoodVendorRatingStats(vendor_id),
      prisma.food_order_rating.findMany({
        where: { vendor_id },
        orderBy: { created_at: 'desc' },
        take,
        skip,
        include: {
          user: { select: { user_id: true, name: true, username: true } },
          food_order: { select: { food_order_id: true, order_status: true, created_at: true } },
        },
      }),
    ]);

    return res.json({
      successful: true,
      rating: stats.rating,
      review_count: stats.review_count,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('Failed to fetch vendor ratings:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch vendor ratings' });
  }
});

/**
 * GET /food/autocomplete?q=
 * Proxy for Google Places Autocomplete — used by frontend address input.
 */
router.get('/autocomplete', authenticateToken, limitFoodAutocompleteProxy, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ successful: false, message: 'q parameter required' });
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ successful: false, message: 'Address autocomplete is unavailable.' });
    }

    const [response, activeAd] = await Promise.all([
      axios.get(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&key=${process.env.GOOGLE_MAPS_API_KEY}`, { timeout: GOOGLE_MAPS_TIMEOUT_MS }),
      selectBestAd(req.adContext).catch(() => null)
    ]);

    let suggestions = response.data.predictions?.map((p) => ({
      place_id: p.place_id,
      description: p.description,
      is_ad: false
    })) ?? [];

    if (activeAd) {
      suggestions.unshift({
        place_id: `ad_${activeAd.campaign_id}`,
        description: `${activeAd.headline || activeAd.title} (Sponsored)`,
        is_ad: true,
        target_url: activeAd.target_url,
        cta_text: activeAd.cta_text || "ORDER_NOW"
      });
    }

    return res.json({ successful: true, data: suggestions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch suggestions' });
  }
});

/* PATCH /vendors/:vendor_id/activate — admin activates a food/grocery/floral vendor */
router.patch('/vendors/:vendor_id/activate', authenticateToken, async (req, res) => {
    try {
        const vendor_id = Number(req.params.vendor_id);
        if (Number.isNaN(vendor_id)) return res.status(400).json({ successful: false, message: 'vendor_id must be a number' });

        const admin = await prisma.admin.findFirst({ where: { user_id: req.user.user_id } });
        if (!admin) return res.status(403).json({ successful: false, message: 'Admin access required' });

        await prisma.food_vendor.update({ where: { vendor_id }, data: { is_active: true } });
        return res.json({ successful: true, message: 'Vendor activated' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ successful: false, message: 'Failed to activate vendor' });
    }
});

/* PATCH /vendors/:vendor_id/deactivate — admin deactivates a food/grocery/floral vendor */
router.patch('/vendors/:vendor_id/deactivate', authenticateToken, async (req, res) => {
    try {
        const vendor_id = Number(req.params.vendor_id);
        if (Number.isNaN(vendor_id)) return res.status(400).json({ successful: false, message: 'vendor_id must be a number' });

        const admin = await prisma.admin.findFirst({ where: { user_id: req.user.user_id } });
        if (!admin) return res.status(403).json({ successful: false, message: 'Admin access required' });

        await prisma.food_vendor.update({ where: { vendor_id }, data: { is_active: false } });
        return res.json({ successful: true, message: 'Vendor deactivated' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ successful: false, message: 'Failed to deactivate vendor' });
    }
});

/**
 * VENDOR ANALYTICS OVERVIEW (earnings + orders, range-aware)
 * GET /food/vendor/me/analytics/overview?range=7d|28d|90d|365d|lifetime&tz=IANA
 *
 * Returns the unified analytics shape the frontend AnalyticsPanel renders:
 *   summary (gross/net/count + % deltas), timeseries (per-day gross/net/count),
 *   breakdown (orders by status), top (top menu items by revenue).
 *
 * Money model: gross = food_order.total_amount (full buyer charge / GMV). net = vendor
 * item take-home. Prefer recovering subtotal from platform_fee ÷ fee rate (fee was
 * charged as subtotal × PLATFORM_FEE at checkout). Legacy fallback subtracts delivery
 * and tip when platform_fee is missing. Revenue/count/top only include fulfilled paid
 * orders (`delivered` / `picked_up`); in-progress paid (`confirmed` / `preparing` /
 * `ready_for_pickup`) and cancelled stay out of money KPIs but still appear in the
 * status breakdown. Aligns with Overview’s completed-order earnings.
 * `lifetime` = all-time for summary/top/breakdown/metrics; the trend chart still
 * shows the last 365 daily buckets so the series stays readable.
 * Day buckets use `tz` (seller browser IANA zone) when valid; otherwise the
 * platform business timezone — never raw UTC midnight.
 */
router.get('/vendor/me/analytics/overview', authenticateToken, async (req, res, next) => {
	try {
		const rangeParam = resolveRangeParam(req.query.range);
		const isLifetime = rangeParam === 'lifetime';
		const days = RANGE_DAYS[rangeParam];
		const timeZone = resolveAnalyticsTimeZone(req.query.tz);
		const { start, prevStart, prevEnd } = resolveRange(days, timeZone);
		// Settled revenue only — matches Overview earnedOrders (Delivered / Picked Up).
		const FOOD_REVENUE_STATUSES = ['delivered', 'picked_up', 'completed'];
		const vertical = String(req.query.vertical || '').trim().toLowerCase();
		const vendorTypeId = await resolveFoodAnalyticsVendorTypeId(vertical);
		const vendorWhere = { owner_id: req.user.user_id };
		if (vertical) {
			if (vendorTypeId == null) {
				return res.json({
					successful: true,
					data: {
						range: rangeParam, currency: 'CAD', vertical, timezone: timeZone,
						summary: { gross: 0, gross_change_pct: 0, net: 0, net_change_pct: 0, count: 0, count_change_pct: 0, avg_order_value: 0 },
						timeseries: buildEarningsSeries({ rows: [], dateField: 'created_at', gross: () => 0, net: () => 0, start, days, timeZone }).timeseries,
						breakdown: [], top: [], metrics: [],
						customers: computeCustomerSegments([], { audienceSize: 0 }),
					},
				});
			}
			vendorWhere.vendor_type_id = vendorTypeId;
		}

		const vendors = await prisma.food_vendor.findMany({
			where: vendorWhere,
			select: { vendor_id: true },
		});
		const vendorIds = vendors.map(v => v.vendor_id);

		const empty = {
			successful: true,
			data: {
				range: rangeParam, currency: 'CAD', vertical: vertical || null, timezone: timeZone,
				summary: { gross: 0, gross_change_pct: 0, net: 0, net_change_pct: 0, count: 0, count_change_pct: 0, avg_order_value: 0 },
				timeseries: buildEarningsSeries({ rows: [], dateField: 'created_at', gross: () => 0, net: () => 0, start, days, timeZone }).timeseries,
				breakdown: [], top: [], metrics: [],
				customers: computeCustomerSegments([], { audienceSize: 0 }),
			},
		};
		if (vendorIds.length === 0) return res.json(empty);

		const feeRaw = Number(PLATFORM_FEE_PERCENTAGE);
		const FOOD_FEE_PCT = Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : 0.08;
		const baseSelect = {
			food_order_id: true, total_amount: true, platform_fee: true, delivery_fee: true,
			tip_amount: true, order_status: true, created_at: true, delivered_at: true, user_id: true,
		};
		const paidVendor = { vendor_id: { in: vendorIds }, ispaid: true };
		const windowFilter = isLifetime ? {} : { created_at: { gte: start } };
		// Revenue = fulfilled only; status breakdown still includes in-progress + cancelled.
		const earningFilter = { ...paidVendor, ...windowFilter, order_status: { in: FOOD_REVENUE_STATUSES } };
		const statusFilter = { ...paidVendor, ...windowFilter };
		const prevEarningFilter = {
			...paidVendor,
			order_status: { in: FOOD_REVENUE_STATUSES },
			created_at: { gte: prevStart, lte: prevEnd },
		};

		const [earningRows, prevRows, statusRows, ratingAgg] = await Promise.all([
			prisma.food_order.findMany({ where: earningFilter, select: baseSelect }),
			prisma.food_order.findMany({
				where: prevEarningFilter,
				select: { total_amount: true, platform_fee: true, delivery_fee: true, tip_amount: true },
			}),
			prisma.food_order.findMany({
				where: statusFilter,
				select: { food_order_id: true, order_status: true, created_at: true, delivered_at: true, user_id: true },
			}),
			prisma.food_order_rating.aggregate({
				where: { vendor_id: { in: vendorIds } },
				_avg: { rating: true },
				_count: { rating: true },
			}).catch(() => ({ _avg: { rating: null }, _count: { rating: 0 } })),
		]);

		const grossOf = (o) => o.total_amount || 0;
		// Vendor take-home ≈ item subtotal. Recover from platform_fee when present;
		// legacy rows subtract delivery + tip (tax still unstored).
		const netOf = (o) => {
			if (o.platform_fee != null && o.platform_fee > 0) {
				return o.platform_fee / FOOD_FEE_PCT;
			}
			return Math.max(0, (o.total_amount || 0) - (o.delivery_fee || 0) - (o.tip_amount || 0));
		};

		const seriesRows = isLifetime
			? earningRows.filter((o) => o.created_at && new Date(o.created_at) >= start)
			: earningRows;
		const { timeseries, summary: seriesSummary } = buildEarningsSeries({
			rows: seriesRows, prevRows, dateField: 'created_at', gross: grossOf, net: netOf, start, days, timeZone,
		});

		let summary = seriesSummary;
		if (isLifetime) {
			const sumGross = earningRows.reduce((s, o) => s + grossOf(o), 0);
			const sumNet = earningRows.reduce((s, o) => s + netOf(o), 0);
			const count = earningRows.length;
			summary = {
				gross: round2(sumGross),
				gross_change_pct: seriesSummary.gross_change_pct,
				net: round2(sumNet),
				net_change_pct: seriesSummary.net_change_pct,
				count,
				count_change_pct: seriesSummary.count_change_pct,
				avg_order_value: count > 0 ? round2(sumGross / count) : 0,
			};
		}

		const statusMap = new Map();
		statusRows.forEach((o) => {
			const k = o.order_status || 'unknown';
			statusMap.set(k, (statusMap.get(k) || 0) + 1);
		});
		const breakdown = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

		const orderIds = earningRows.map((o) => o.food_order_id);
		let top = [];
		if (orderIds.length) {
			const items = await prisma.food_order_items.findMany({
				where: { order_id: { in: orderIds } },
				select: { food_item_id: true, qty: true, price_item: true, food_item: { select: { name: true } } },
			});
			const byItem = new Map();
			for (const it of items) {
				if (it.food_item_id == null) continue;
				const e = byItem.get(it.food_item_id) || { id: it.food_item_id, title: it.food_item?.name || 'Item', gross: 0, count: 0 };
				e.gross += (it.qty || 0) * (it.price_item || 0);
				e.count += (it.qty || 0);
				byItem.set(it.food_item_id, e);
			}
			const keepPct = 1 - FOOD_FEE_PCT;
			top = [...byItem.values()]
				.map((e) => ({
					id: e.id,
					title: e.title,
					subtitle: `${e.count} sold`,
					gross: round2(e.gross),
					net: round2(e.gross * keepPct),
					count: e.count,
				}))
				.sort((a, b) => b.gross - a.gross)
				.slice(0, 8);
		}

		// Performance metrics use the same window as the selected range (lifetime = all time).
		const countByStatus = {};
		for (const o of statusRows) {
			const k = o.order_status || 'unknown';
			countByStatus[k] = (countByStatus[k] || 0) + 1;
		}
		const deliveredAll = countByStatus.delivered || 0;
		const cancelledAll = countByStatus.cancelled || 0;
		const finishedAll = deliveredAll + cancelledAll;
		const completionRate = finishedAll ? round2((deliveredAll / finishedAll) * 100) : null;

		const fulfilMins = earningRows
			.filter((o) => o.order_status === 'delivered' && o.delivered_at && o.created_at)
			.map((o) => (new Date(o.delivered_at) - new Date(o.created_at)) / 60000)
			.filter((m) => m >= 0);
		const avgFulfilMins = fulfilMins.length ? round2(fulfilMins.reduce((s, m) => s + m, 0) / fulfilMins.length) : null;

		// Period "returning" = had any fulfilled paid order before the chart window start.
		const priorAnchor = start;
		const custIds = [...new Set(seriesRows.map((o) => o.user_id).filter((id) => id != null))];
		let newCustomers = null;
		let returningPct = null;
		if (custIds.length) {
			const prior = await prisma.food_order.findMany({
				where: {
					vendor_id: { in: vendorIds },
					ispaid: true,
					order_status: { in: FOOD_REVENUE_STATUSES },
					user_id: { in: custIds },
					created_at: { lt: priorAnchor },
				},
				select: { user_id: true },
				distinct: ['user_id'],
			});
			const returningSet = new Set(prior.map((p) => p.user_id));
			const returningCount = custIds.filter((id) => returningSet.has(id)).length;
			newCustomers = custIds.length - returningCount;
			returningPct = round2((returningCount / custIds.length) * 100);
		}

		const windowHint = isLifetime ? 'all time' : 'this period';
		const avgRating = ratingAgg?._avg?.rating != null ? round2(ratingAgg._avg.rating) : null;
		const ratingCount = ratingAgg?._count?.rating || 0;

		const metrics = [
			{ key: 'completion_rate', label: 'Completion rate', value: completionRate, format: 'pct', hint: `${deliveredAll} delivered of ${finishedAll} finished orders (${windowHint})`, tone: completionRate == null ? 'neutral' : (completionRate >= 90 ? 'good' : completionRate >= 75 ? 'neutral' : 'warn') },
			{ key: 'avg_fulfilment', label: 'Avg fulfilment time', value: avgFulfilMins, format: 'duration', hint: 'Average minutes from order placed to delivered', tone: 'neutral' },
			{ key: 'returning_customers', label: 'Returning buyers', value: returningPct, format: 'pct', hint: 'Share of this window’s buyers with a prior completed order', tone: returningPct == null ? 'neutral' : (returningPct >= 40 ? 'good' : 'neutral') },
			{ key: 'new_customers', label: 'New buyers', value: newCustomers, format: 'count', hint: 'Buyers in this window with no prior completed order', tone: 'neutral' },
			{ key: 'cancellations', label: 'Cancellations', value: cancelledAll, format: 'count', hint: `Orders cancelled (${windowHint})`, tone: cancelledAll === 0 ? 'good' : 'warn' },
			{ key: 'avg_rating', label: 'Average rating', value: avgRating, format: 'rating', hint: ratingCount ? `${ratingCount} review${ratingCount === 1 ? '' : 's'} (all time)` : 'No reviews yet', tone: avgRating == null ? 'neutral' : (avgRating >= 4.5 ? 'good' : avgRating >= 3.5 ? 'neutral' : 'warn') },
		];

		// #327 customer analytics — full segmentation over the vendor's LIFETIME buyers
		// (complements the in-range new/returning metrics above). Best-effort.
		let customers = null;
		try {
			const lifetime = await prisma.food_order.findMany({
				where: { vendor_id: { in: vendorIds }, ispaid: true },
				select: { user_id: true, total_amount: true, created_at: true },
			});
			const buyerIds = [...new Set(lifetime.map(o => o.user_id).filter(id => id != null))];
			const excludedIds = [...new Set([...buyerIds, req.user.user_id].filter(id => id != null))];
			const nonBuyerCount = await prisma.user.count({
				where: {
					deleted_at: null,
					account_status: 'active',
					user_id: excludedIds.length ? { notIn: excludedIds } : { not: req.user.user_id },
				},
			});
			customers = computeCustomerSegments(
				lifetime.map(o => ({ customer_id: o.user_id, at: o.created_at, amount: o.total_amount })),
				{ audienceSize: buyerIds.length + nonBuyerCount },
			);
		} catch (e) { /* omit customers block on failure */ }

		res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', vertical: vertical || null, timezone: timeZone, summary, timeseries, breakdown, top, metrics, customers } });
	} catch (err) { next(err); }
});

export default router;
