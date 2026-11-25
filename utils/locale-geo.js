import geoip from 'geoip-lite';

/** ISO 3166-1 alpha-2 → default UI language (matches frontend LANGUAGES codes). */
const COUNTRY_LANGUAGE = {
  US: 'en', CA: 'en', GB: 'en', AU: 'en', NZ: 'en', IE: 'en', ZA: 'en', NG: 'en', GH: 'en', PH: 'en', SG: 'en',
  FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr', SN: 'fr', CI: 'fr', CM: 'fr', CD: 'fr',
  DE: 'de', AT: 'de', LI: 'de',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', EC: 'es', GT: 'es', CU: 'es', DO: 'es',
  PK: 'ur',
  BD: 'bn',
  IN: 'hi',
  SA: 'ar', AE: 'ar', EG: 'ar', MA: 'ar', DZ: 'ar', IQ: 'ar', JO: 'ar', KW: 'ar', LB: 'ar', OM: 'ar', QA: 'ar', SY: 'ar', YE: 'ar', LY: 'ar', TN: 'ar', SD: 'ar',
  IR: 'fa', AF: 'ps',
  CN: 'zh', TW: 'zh', HK: 'zh',
  JP: 'ja',
  KR: 'ko',
  IT: 'it', SM: 'it', VA: 'it',
  PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
  NL: 'nl',
  PL: 'pl',
  RU: 'ru', BY: 'ru', KZ: 'ru',
  TR: 'tr',
  SE: 'sv', FI: 'fi', NO: 'no', DK: 'da', IS: 'is',
  GR: 'el', CY: 'el',
  TH: 'th',
  VN: 'vi',
  ID: 'id', MY: 'ms',
  RO: 'ro', MD: 'ro',
  HU: 'hu',
  CZ: 'cs', SK: 'sk',
  UA: 'uk', // fallback to en if not in LANGUAGES — frontend normalizes
  IL: 'he',
  TZ: 'sw', KE: 'sw',
};

const COUNTRY_CURRENCY = {
  US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', MX: 'MXN', BR: 'BRL',
  FR: 'EUR', DE: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', IE: 'EUR', PT: 'EUR',
  IN: 'INR', PK: 'PKR', BD: 'BDT', JP: 'JPY', CN: 'CNY', KR: 'KRW', CH: 'CHF',
  SA: 'SAR', AE: 'AED', TR: 'TRY', PL: 'PLN', SE: 'SEK', NO: 'NOK', DK: 'DKK',
};

const COUNTRY_NAMES = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', FR: 'France', DE: 'Germany',
  PK: 'Pakistan', IN: 'India', BD: 'Bangladesh', AU: 'Australia', ES: 'Spain', MX: 'Mexico',
  SA: 'Saudi Arabia', AE: 'United Arab Emirates', JP: 'Japan', CN: 'China', BR: 'Brazil',
};

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  const raw = req.socket?.remoteAddress ?? req.ip ?? '127.0.0.1';
  return String(raw).replace(/^::ffff:/, '');
}

export function detectLocaleFromIp(ip) {
  const lookup = geoip.lookup(ip);
  if (!lookup?.country) {
    return {
      country: null,
      countryName: null,
      language: 'en',
      currency: 'CAD',
      source: 'default',
    };
  }
  const cc = lookup.country;
  return {
    country: cc,
    countryName: COUNTRY_NAMES[cc] ?? cc,
    language: COUNTRY_LANGUAGE[cc] ?? 'en',
    currency: 'CAD',
    source: 'geoip',
  };
}

export function parseBrowserLanguage(acceptLanguageHeader) {
  if (!acceptLanguageHeader || typeof acceptLanguageHeader !== 'string') return null;
  const first = acceptLanguageHeader.split(',')[0]?.trim();
  if (!first) return null;
  return first.split('-')[0].toLowerCase();
}
