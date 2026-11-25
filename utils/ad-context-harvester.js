// utils/ad-context-harvester.js
import geoip from 'geoip-lite';
import { getRegionData } from './tax-config.js';

// N8 Severity thresholds and regional configuration fallbacks
const DEFAULT_LOCALE = 'en';
const DEFAULT_CURRENCY = 'CAD';
const DEFAULT_COUNTRY = 'default';

// Regular expressions to normalize device platform fingerprints
const USER_AGENT_PATTERNS = {
  IOS: /(iPad|iPhone|iPod)/i,
  ANDROID: /Android/i,
  MOBILE_WEB: /(Mobi|Opera Mini|IEMobile|BlackBerry|Fennec|Windows Phone)/i
};

/**
 * 1.6 Geofencing Coordinate Distance Calculator (Haversine Formula)
 * Calculates the great-circle distance between two points on a sphere.
 * High-performance math-intrinsic operations.
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
    return null;
  }

  const numLat1 = Number(lat1);
  const numLon1 = Number(lon1);
  const numLat2 = Number(lat2);
  const numLon2 = Number(lon2);

  if (Number.isNaN(numLat1) || Number.isNaN(numLon1) || Number.isNaN(numLat2) || Number.isNaN(numLon2)) {
    return null;
  }

  const R = 6371; // Earth's radius in kilometers
  const dLat = ((numLat2 - numLat1) * Math.PI) / 180;
  const dLon = ((numLon2 - numLon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((numLat1 * Math.PI) / 180) *
      Math.cos((numLat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(4)); // Bounded precision to 4 decimal places
}

/**
 * 1.2 Non-Blocking Geolocation Fallback Parser
 * Resolves country and city from IP address via geoip-lite memory-mapped lookup.
 */
export function geolocateIp(ipAddress) {
  if (!ipAddress) {
    return { country: null, city: null, currency: DEFAULT_CURRENCY };
  }

  try {
    // Strip IPv6 prefix if present (e.g. ::ffff:127.0.0.1)
    const normalizedIp = String(ipAddress).replace(/^::ffff:/, '').trim();
    const geo = geoip.lookup(normalizedIp);

    if (geo && geo.country) {
      const regionMeta = getRegionData(geo.country);
      return {
        country: geo.country,
        city: geo.city || null,
        currency: regionMeta?.currency || DEFAULT_CURRENCY
      };
    }
  } catch (err) {
    console.warn('[ad-context-harvester] Geolocation lookup bypass on failure:', err.message);
  }

  return { country: null, city: null, currency: DEFAULT_CURRENCY };
}

/**
 * 1.3 HTTP Header Locale Normalizer
 * Resolves the target language using i18n support codes.
 */
export function normalizeLanguageHeader(acceptLanguage, customLangHeader) {
  const targetCode = String(customLangHeader || acceptLanguage || DEFAULT_LOCALE).trim();
  if (!targetCode) return DEFAULT_LOCALE;

  const base = targetCode.split(',')[0].trim().split('-')[0].toLowerCase();
  
  const SUPPORTED_LANGS = new Set([
    'af', 'ar', 'az', 'bn', 'bs', 'bg', 'ca', 'cs', 'da', 'nl',
    'en', 'et', 'tl', 'fi', 'fr', 'ka', 'de', 'el', 'gu', 'ha',
    'he', 'hi', 'hu', 'is', 'ga', 'it', 'ja', 'kk', 'ko', 'lv',
    'ln', 'lt', 'lb', 'mk', 'ms', 'zh', 'ne', 'no', 'ps', 'fa',
    'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'so', 'es', 'sw',
    'sv', 'ta', 'th', 'tr', 'ur', 'vi', 'cy'
  ]);

  const aliasMap = { fil: 'tl', tl: 'tl' };
  const normalized = aliasMap[base] || base;

  return SUPPORTED_LANGS.has(normalized) ? normalized : DEFAULT_LOCALE;
}

/**
 * 1.4 Device & Platform Fingerprint Extractor
 * Strictly normalizes platform to ANDROID, IOS, MOBILE_WEB, or DESKTOP.
 */
export function parseDevicePlatform(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return 'DESKTOP';

  if (USER_AGENT_PATTERNS.IOS.test(ua)) {
    return 'IOS';
  }
  if (USER_AGENT_PATTERNS.ANDROID.test(ua)) {
    return 'ANDROID';
  }
  if (USER_AGENT_PATTERNS.MOBILE_WEB.test(ua)) {
    return 'MOBILE_WEB';
  }

  return 'DESKTOP';
}

/**
 * 1.5 User Interest Profile JSON Schema Validator
 * Validates, filters, and sanitizes user interest vector weights.
 * Protects against SQL/NoSQL Injection inside JSON payload keys.
 */
export function validateAndSanitizeInterests(interestsJson) {
  const sanitized = {};
  if (!interestsJson || typeof interestsJson !== 'object') {
    return sanitized;
  }

  try {
    for (const [key, value] of Object.entries(interestsJson)) {
      // Prevent XSS / Injection in keys (alphanumeric, underscores, and hashtags only)
      const cleanKey = String(key).replace(/[^a-zA-Z0-9_#]/g, '').trim().toLowerCase();
      if (!cleanKey) continue;

      const numVal = parseFloat(value);
      if (Number.isFinite(numVal)) {
        // Clamp weights to 0.00 - 100.00 limits
        sanitized[cleanKey] = parseFloat(Math.min(100, Math.max(0, numVal)).toFixed(4));
      }
    }
  } catch (err) {
    console.error('[ad-context-harvester] Interest vector validation error:', err.message);
  }

  return sanitized;
}

/**
 * 1.7 Safe Null-Value Context Fallback Handler
 * Returns pristine, safe state when context processing fails or falls back.
 */
export function getFallbackContext(vertical = 'social') {
  return {
    vertical: String(vertical).toLowerCase(),
    country: 'default',
    city: null,
    interests: {},
    top_tokens: [],
    platform: 'DESKTOP',
    profile_id: null,
    user_id: null,
    latitude: null,
    longitude: null,
    language: DEFAULT_LOCALE,
    currency: DEFAULT_CURRENCY,
    sandbox: false
  };
}