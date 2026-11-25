import geoip from 'geoip-lite';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';

// Fast LRU in-memory deduplication cache to prevent writing 100 identical DB rows for a single user interaction
const recentIpCache = new Map();
const DEDUPE_WINDOW_MS = 15000; // 15 seconds window per IP

function extractUserIdentity(req) {
    // 1. Direct auth middleware injection
    if (req.user?.user_id) return req.user.user_id;

    // 2. Parse Authorization Bearer header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const decoded = jwt.decode(authHeader.slice(7));
            if (decoded?.user_id || decoded?.member_id) {
                return decoded.user_id || decoded.member_id;
            }
        } catch {
            // Non-blocking decode failure
        }
    }

    // 3. Parse Refresh Token Cookies (strug_refresh_token or legacy refreshToken)
    const refreshCookie = req.cookies?.strug_refresh_token || req.cookies?.refreshToken;
    if (refreshCookie) {
        try {
            const decoded = jwt.decode(refreshCookie);
            if (decoded?.user_id) return decoded.user_id;
        } catch {
            // Non-blocking decode failure
        }
    }

    return null;
}

export function telemetryRecorder(req, res, next) {
    // Execute strictly after response is sent to guarantee 0.00ms latency impact on user traffic
    res.on('finish', async () => {
        // Skip internal health probes and static assets
        if (req.url.startsWith('/health') || req.url.startsWith('/_gateway/') || req.url.includes('.')) {
            return;
        }

        const rawIp = req.headers['x-real-client-ip'] ||
            req.headers['x-azure-clientip'] ||
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            '127.0.0.1';

        const cleanIp = rawIp.replace(/^::ffff:/, '').split(':')[0].trim();
        if (!cleanIp || cleanIp === '127.0.0.1' || cleanIp.startsWith('10.') || cleanIp.startsWith('192.168.')) {
            return;
        }

        const deviceUuid = req.cookies?.strug_device || null;
        let userId = extractUserIdentity(req);

        // Channel 3: If no active token found, correlate historically from device UUID in user_activity_event
        if (!userId && deviceUuid) {
            try {
                const pastLogin = await prisma.user_activity_event.findFirst({
                    where: {
                        type: 'auth.login',
                        metadata: { path: ['device_id'], equals: deviceUuid },
                    },
                    select: { user_id: true },
                    orderBy: { created_at: 'desc' },
                });
                if (pastLogin?.user_id) {
                    userId = pastLogin.user_id;
                }
            } catch {
                // Non-blocking database query fallback
            }
        }

        // Resolve Geolocation metadata
        let city = req.headers['cf-ipcity'] || null;
        let country = req.headers['cf-ipcountry'] || null;

        if (!city || !country) {
            const geo = geoip.lookup(cleanIp);
            if (geo) {
                city = geo.city || geo.region || 'Identified Region';
                country = geo.country || 'Global';
            }
        }

        // Resolve User Handle from PostgreSQL and Seed Redis Identity Cache for the Gateway
        let userHandle = null;
        if (userId) {
            try {
                const userProfile = await prisma.user.findUnique({
                    where: { user_id: userId },
                    select: { user_id: true, name: true, username: true },
                });

                if (userProfile) {
                    userHandle = userProfile.username
                        ? `@${userProfile.username}`
                        : (userProfile.name || `User #${userId}`);

                    if (isRedisReady()) {
                        const identityPayload = JSON.stringify({ userId, handle: userHandle });

                        // Seed Redis cache across User, IP, and Device lookup keys
                        redis.set(`identity:user:${userId}`, identityPayload, 'EX', 86400).catch(() => { });
                        redis.set(`identity:ip:${cleanIp}`, identityPayload, 'EX', 3600).catch(() => { });
                        if (deviceUuid) {
                            redis.set(`identity:device:${deviceUuid}`, identityPayload, 'EX', 30 * 86400).catch(() => { });
                        }
                    }
                }
            } catch {
                // Non-blocking database query fallback
            }
        }

        // Memory deduplication check to prevent DB flooding
        const now = Date.now();
        const lastRecorded = recentIpCache.get(cleanIp);
        if (lastRecorded && (now - lastRecorded) < DEDUPE_WINDOW_MS) {
            return;
        }
        recentIpCache.set(cleanIp, now);

        // Periodic memory cleanup
        if (recentIpCache.size > 2000) {
            recentIpCache.clear();
        }

        // Write permanently to PostgreSQL user_ip_history
        prisma.user_ip_history.create({
            data: {
                ip_address: cleanIp,
                device_uuid: deviceUuid,
                user_id: userId,
                user_agent: req.headers['user-agent'] || null,
                country: country || 'LK',
                city: city || 'Identified City',
            },
        }).catch(() => {
            // Non-blocking database insertion fallback
        });
    });

    next();
}