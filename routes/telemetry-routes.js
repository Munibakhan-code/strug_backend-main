import express from 'express';
import geoip from 'geoip-lite';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';

const router = express.Router();

/**
 * High-Precision Radar Telemetry History Fetcher with Database Entity Correlation
 * Endpoint: GET /api/v1/telemetry/radar-history
 * Query Params: ?window=5m | 30m | 1h | all
 */
router.get('/radar-history', async (req, res) => {
    const windowParam = String(req.query.window || '1h').toLowerCase();
    const now = Date.now();

    let windowMs = 60 * 60 * 1000; // Default: 1 Hour
    if (windowParam === '5m') windowMs = 5 * 60 * 1000;
    else if (windowParam === '30m') windowMs = 30 * 60 * 1000;
    else if (windowParam === '1h') windowMs = 60 * 60 * 1000;
    else if (windowParam === 'all') windowMs = 7 * 24 * 60 * 60 * 1000; // 7 Days

    const sinceDate = new Date(now - windowMs);
    const cleanHitsMap = new Map();

    try {
        // 1. Fetch Active Locked Threat Beacons from Database
        const lockedRecords = await prisma.security_dossier.findMany({
            where: {
                status: 'LOCKED',
                created_at: { gte: sinceDate },
            },
            orderBy: { created_at: 'desc' },
            take: 100,
        }).catch(() => []);

        const lockedThreats = lockedRecords.map((t) => {
            let lat = t.coordinates_lat ? parseFloat(t.coordinates_lat) : null;
            let lng = t.coordinates_lng ? parseFloat(t.coordinates_lng) : null;

            if (lat == null || lng == null) {
                const targetIp = t.real_home_ip || t.client_ip;
                const cleanIp = (targetIp || '').replace(/^::ffff:/, '').split(':')[0].trim();
                const geo = geoip.lookup(cleanIp);
                if (geo && Array.isArray(geo.ll) && geo.ll.length === 2) {
                    lat = geo.ll[0];
                    lng = geo.ll[1];
                } else {
                    lat = 52.52;
                    lng = 13.405; // Standard fallback coordinates
                }
            }

            return {
                id: t.dossier_id,
                dossier_id: t.dossier_id,
                threat_score: t.threat_score,
                vector: t.threat_vector,
                ip: t.client_ip,
                real_ip: t.real_home_ip,
                lat,
                lng,
                city: t.city || 'Identified Target',
                country: t.country || 'Global',
                timestamp: t.created_at.getTime(),
            };
        });

        // 2. Fetch and Aggregate Transient Hits from Redis Cache
        if (isRedisReady()) {
            try {
                const rawHits = await redis.lrange('telemetry:clean_hits', 0, 1000);
                for (const raw of rawHits) {
                    try {
                        const h = JSON.parse(raw);
                        if (!h || h.lat == null || h.lng == null) continue;

                        const hitTime = typeof h.timestamp === 'number'
                            ? h.timestamp
                            : new Date(h.timestamp || now).getTime();

                        if ((now - hitTime) <= windowMs) {
                            const entityKey = h.user_id ? `uid_${h.user_id}` : (h.ip ? `ip_${h.ip}` : `${h.lat}_${h.lng}`);

                            if (cleanHitsMap.has(entityKey)) {
                                const existing = cleanHitsMap.get(entityKey);
                                existing.hits = (existing.hits || 1) + (h.hits || 1);
                                if (hitTime > (existing.lastSeen || 0)) {
                                    existing.lastSeen = hitTime;
                                    existing.lat = h.lat;
                                    existing.lng = h.lng;
                                    if (h.handle && !h.handle.includes('Guest') && !h.handle.includes('Anonymous')) {
                                        existing.handle = h.handle;
                                    }
                                }
                            } else {
                                cleanHitsMap.set(entityKey, {
                                    ...h,
                                    id: entityKey,
                                    entity_key: entityKey,
                                    hits: h.hits || 1,
                                    firstSeen: hitTime,
                                    lastSeen: hitTime,
                                    timestamp: hitTime,
                                });
                            }
                        }
                    } catch {
                        // Non-blocking parse error suppression
                    }
                }
            } catch {
                // Redis connection fallback
            }
        }

        // 3. Persistent Extraction from PostgreSQL user_ip_history with Deep Identity Correlation
        try {
            const dbHits = await prisma.user_ip_history.findMany({
                where: {
                    created_at: { gte: sinceDate },
                },
                include: {
                    user: {
                        select: {
                            user_id: true,
                            name: true,
                            username: true,
                            email: true,
                        },
                    },
                },
                orderBy: { created_at: 'desc' },
                take: 500,
            });

            // Build historical correlation map: IP -> Most recent registered user on that IP
            const ipToUserCorrelation = new Map();
            for (const h of dbHits) {
                if (h.user_id && h.user && !ipToUserCorrelation.has(h.ip_address)) {
                    ipToUserCorrelation.set(h.ip_address, h.user);
                }
            }

            for (const hit of dbHits) {
                const cleanIp = (hit.ip_address || '').replace(/^::ffff:/, '').split(':')[0].trim();

                // Resolve user identity: direct user relation OR historical IP correlation
                const resolvedUser = hit.user || ipToUserCorrelation.get(cleanIp) || null;
                const resolvedUserId = hit.user_id || resolvedUser?.user_id || null;

                let userHandle = null;
                if (resolvedUser) {
                    userHandle = resolvedUser.username
                        ? `@${resolvedUser.username}`
                        : (resolvedUser.name || `User #${resolvedUser.user_id}`);
                } else if (resolvedUserId) {
                    userHandle = `User #${resolvedUserId}`;
                } else {
                    userHandle = `Client [${cleanIp}]`;
                }

                const entityKey = resolvedUserId ? `uid_${resolvedUserId}` : `ip_${cleanIp}`;
                const hitTime = hit.created_at.getTime();

                if (cleanHitsMap.has(entityKey)) {
                    const existing = cleanHitsMap.get(entityKey);
                    existing.hits = (existing.hits || 1) + 1;

                    if (resolvedUser && (!existing.handle || existing.handle.includes('Client') || existing.handle.includes('Guest'))) {
                        existing.handle = userHandle;
                        existing.user_id = resolvedUserId;
                    }
                    if (hitTime > (existing.lastSeen || 0)) {
                        existing.lastSeen = hitTime;
                    }
                } else {
                    const geo = geoip.lookup(cleanIp);
                    if (geo && Array.isArray(geo.ll) && geo.ll.length === 2) {
                        cleanHitsMap.set(entityKey, {
                            id: entityKey,
                            entity_key: entityKey,
                            handle: userHandle,
                            user_id: resolvedUserId,
                            hits: 1,
                            lat: geo.ll[0],
                            lng: geo.ll[1],
                            city: hit.city || geo.city || 'Identified Region',
                            country: hit.country || geo.country || 'Global',
                            ip: cleanIp,
                            firstSeen: hitTime,
                            lastSeen: hitTime,
                            timestamp: hitTime,
                        });
                    }
                }
            }
        } catch (dbErr) {
            console.error('[TELEMETRY] Database history correlation warning:', dbErr.message);
        }

        const cleanHits = Array.from(cleanHitsMap.values());

        return res.status(200).json({
            successful: true,
            data: {
                cleanHits,
                lockedThreats,
                totalClean: cleanHits.length,
                totalThreats: lockedThreats.length,
                window: windowParam,
            },
        });
    } catch (err) {
        console.error('[TELEMETRY] History Fetch Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'TELEMETRY_FETCH_FAILURE',
            message: 'Failed to retrieve radar telemetry snapshot.',
        });
    }
});

/**
 * Resolve / Dismiss Locked Threat Beacon
 * Endpoint: POST /api/v1/telemetry/threats/resolve
 */
router.post('/threats/resolve', async (req, res) => {
    const { threatId } = req.body || {};
    if (!threatId || typeof threatId !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_INPUT',
            message: 'Valid threatId identifier is required.',
        });
    }

    try {
        await prisma.security_dossier.updateMany({
            where: { dossier_id: threatId },
            data: { status: 'RESOLVED' },
        });

        if (isRedisReady()) {
            await redis.srem('telemetry:locked_threat_ids', threatId);
        }

        return res.status(200).json({
            successful: true,
            message: `Threat ${threatId} marked as resolved. Beacon cleared from active radar.`,
        });
    } catch (err) {
        console.error('[TELEMETRY] Threat Resolve Error:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'RESOLVE_FAILURE',
            message: 'Failed to resolve threat.',
        });
    }
});

export default router;