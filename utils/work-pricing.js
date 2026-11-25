import { PLATFORM_FEE_PERCENTAGE, getRegionData } from './tax-config.js';
import { getCountryFromCoords } from './google-maps.js';

const round2 = (n) => parseFloat(Number(n || 0).toFixed(2));

// On-Demand Work pricing — mirrors the rideshare money model.
// The HIRER sets the all-in price (flat OR hourly). The worker take-home is
// price − 8% platform fee − local tax. e.g. Toronto $10 → 8% + 13% → worker $7.90.
export function computeWorkPricing({ price_type, hirer_set_price, hourly_rate, duration_hours, taxRate, currency }) {
  const total = price_type === 'hourly'
    ? round2(Number(hourly_rate || 0) * Number(duration_hours || 0))
    : round2(hirer_set_price);
  const platform_fee = round2(total * PLATFORM_FEE_PERCENTAGE);
  const tax_amount = round2(total * (Number(taxRate) || 0));
  const worker_payout = round2(total - platform_fee - tax_amount);
  return {
    total_charged: total,                              // what the hirer pays
    platform_fee,
    platform_fee_pct: round2(PLATFORM_FEE_PERCENTAGE * 100),
    tax_amount,
    tax_rate: Number(taxRate) || 0,
    worker_payout,                                     // what the worker sees / receives
    currency: currency || 'CAD',
  };
}

// Tax jurisdiction = where the work happens (the job location coords).
// Falls back to the "default" region if coords/geocoding are unavailable.
export async function resolveWorkRegion(lat, lng) {
  try {
    if (lat == null || lng == null) return getRegionData('default');
    const country = await getCountryFromCoords(`${lat},${lng}`);
    return getRegionData(country);
  } catch {
    return getRegionData('default');
  }
}
