import { PLATFORM_FEE_PERCENTAGE } from './tax-config.js';
import { round2 } from './analytics-buckets.js';

export const FOOD_SETTLED_STATUSES = ['delivered', 'picked_up', 'completed'];
export const FOOD_IN_PROGRESS_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'dispatched'];

export function foodFeePct() {
  const feeRaw = Number(PLATFORM_FEE_PERCENTAGE);
  return Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : 0.08;
}

/** Vendor take-home ≈ item subtotal. Recover from platform_fee ÷ fee rate when present. */
export function vendorNetOf(order) {
  const pct = foodFeePct();
  if (order?.platform_fee != null && Number(order.platform_fee) > 0) {
    return round2(Number(order.platform_fee) / pct);
  }
  return round2(Math.max(
    0,
    (Number(order?.total_amount) || 0) - (Number(order?.delivery_fee) || 0) - (Number(order?.tip_amount) || 0),
  ));
}

export function isFoodSettledStatus(status) {
  return FOOD_SETTLED_STATUSES.includes(String(status || '').toLowerCase());
}
