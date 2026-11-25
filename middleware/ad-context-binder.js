// middleware/ad-context-binder.js
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import {
  geolocateIp,
  normalizeLanguageHeader,
  parseDevicePlatform,
  validateAndSanitizeInterests,
  getFallbackContext
} from '../utils/ad-context-harvester.js';

/**
 * 1.10 Thread-Safe Execution Context Wrapper & Fail-Open Guard
 * Handles sandbox environment flags (1.9), database/Redis handshakes (1.2),
 * and maps all pre-flight attributes safely to req.adContext (1.8).
 */
export async function harvestAdContext(req, res, next) {
  // Extract and normalize vertical target from request paths/queries
  const pathParts = req.baseUrl.split('/');
  const vertical = pathParts[1] || String(req.query.vertical || 'social').trim().toLowerCase();

  try {
    const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || '';
    const acceptLang = req.headers['accept-language'] || '';
    const customLang = req.headers['x-strug-language'] || req.body?.language || '';

    // 1.9 Sandbox Environment Context Flag Validation (Custom Headers override)
    const isSandbox = req.headers['x-strug-sandbox'] === 'true' || process.env.NODE_ENV !== 'production';
    let sandboxLat = null;
    let sandboxLng = null;
    let sandboxCountry = null;
    let sandboxCity = null;

    if (isSandbox) {
      if (req.headers['x-strug-sandbox-lat']) {
        sandboxLat = parseFloat(req.headers['x-strug-sandbox-lat']);
      }
      if (req.headers['x-strug-sandbox-lng']) {
        sandboxLng = parseFloat(req.headers['x-strug-sandbox-lng']);
      }
      if (req.headers['x-strug-sandbox-country']) {
        sandboxCountry = String(req.headers['x-strug-sandbox-country']).trim();
      }
      if (req.headers['x-strug-sandbox-city']) {
        sandboxCity = String(req.headers['x-strug-sandbox-city']).trim();
      }
    }

    // Default Geo resolving
    const geo = geolocateIp(rawIp);
    const resolvedCountry = sandboxCountry || geo.country || 'default';
    const resolvedCity = sandboxCity || geo.city || null;
    const resolvedCurrency = geo.currency || 'USD';

    const platform = parseDevicePlatform(userAgent);
    const language = normalizeLanguageHeader(acceptLang, customLang);

    // Context Skeleton
    const context = {
      vertical,
      country: resolvedCountry,
      city: resolvedCity,
      interests: {},
      top_tokens: [],
      platform,
      profile_id: null,
      user_id: null,
      latitude: sandboxLat,
      longitude: sandboxLng,
      language,
      currency: resolvedCurrency,
      sandbox: isSandbox
    };

    // Authenticated path context resolution (1.1, 1.5)
    // Supports multi-table Prisma contextual metadata
    const activeUserId = req.user?.user_id || req.user?.id;
    if (activeUserId) {
      context.user_id = Number(activeUserId);

      // 1.2 Redis fast-path handshake for real-time interest profiles
      const cacheKey = `ads:user:${activeUserId}:profile`;
      let cachedProfile = null;

      try {
        const cachedRaw = await redis.get(cacheKey);
        if (cachedRaw) {
          cachedProfile = JSON.parse(cachedRaw);
        }
      } catch (redisErr) {
        console.warn('[ad-context-binder] Redis fetch bypassed during context harvest:', redisErr.message);
      }

      if (cachedProfile) {
        context.profile_id = Number(cachedProfile.profile_id || null);
        context.interests = validateAndSanitizeInterests(cachedProfile.interests);
        context.top_tokens = Array.isArray(cachedProfile.top_tokens) ? cachedProfile.top_tokens : [];
        if (cachedProfile.latitude && !isSandbox) context.latitude = parseFloat(cachedProfile.latitude);
        if (cachedProfile.longitude && !isSandbox) context.longitude = parseFloat(cachedProfile.longitude);
      } else {
        // Fallback to PostgreSQL on cache miss or connection failure (Non-blocking)
        const dbProfile = await prisma.social_profile.findFirst({
          where: { user_id: context.user_id },
          include: {
            user: {
              select: {
                saved_address: true,
                saved_lat: true,
                saved_long: true,
                user_interest_profile: true
              }
            }
          }
        }).catch(() => null);

        if (dbProfile) {
          context.profile_id = Number(dbProfile.profile_id);
          
          if (dbProfile.user?.saved_lat && !isSandbox) {
            context.latitude = parseFloat(dbProfile.user.saved_lat);
          }
          if (dbProfile.user?.saved_long && !isSandbox) {
            context.longitude = parseFloat(dbProfile.user.saved_long);
          }

          const interestRecord = dbProfile.user?.user_interest_profile;
          if (interestRecord) {
            context.interests = validateAndSanitizeInterests(interestRecord.interests);
            context.top_tokens = Array.isArray(interestRecord.top_tokens) ? interestRecord.top_tokens : [];

            // Seed fast-path memory cache for subsequent requests
            try {
              await redis.set(cacheKey, JSON.stringify({
                profile_id: context.profile_id,
                interests: context.interests,
                top_tokens: context.top_tokens,
                latitude: context.latitude,
                longitude: context.longitude
              }), 'EX', 1800); // 30 minutes TTL
            } catch (redisErr) {
              // Non-blocking fail-open for Redis writes
            }
          }
        }
      }
    }

    // 1.8 Session Request Metadata Binder
    req.adContext = context;
    return next();

  } catch (err) {
    // 1.10 Thread-Safe Execution Context Wrapper (Fail-Open Safety Net)
    console.error('❌ [AD CONTEXT CRITICAL FAIL-OPEN ACTIVATED]:', err.message);
    req.adContext = getFallbackContext(vertical);
    return next();
  }
}