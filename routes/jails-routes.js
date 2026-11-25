/**
 * src/routes/jails-routes.js
 * Active Quarantine & Subnet /24 Netblock Manager Controller
 * Bridges SOC Screen 5 with PostgreSQL active_quarantine & Gateway In-Memory Radix Jail
 */

import express from 'express';
import geoip from 'geoip-lite';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';

const router = express.Router();

function resolveTargetGeo(target) {
    const cleanIp = target.includes('/') ? `${target.split('.')[0]}.${target.split('.')[1]}.${target.split('.')[2]}.1` : target;
    const geo = geoip.lookup(cleanIp);
    if (geo) {
        return `${geo.city || geo.region || 'Region'}, ${geo.country || 'Global'}`;
    }
    return 'Manual Entry Location';
}

/**
 * Fetch All Active Quarantined Entities
 * Endpoint: GET /api/v1/jails
 */
router.get('/', async (_req, res) => {
    const now = new Date();

    try {
        const activeRecords = await prisma.active_quarantine.findMany({
            where: {
                is_active: true,
                OR: [
                    { is_permanent: true },
                    { expires_at: { gt: now } },
                    { expires_at: null },
                ],
            },
            orderBy: { jailed_at: 'desc' },
            take: 200,
        });

        const jails = activeRecords.map((item) => ({
            id: item.jail_id,
            target: item.target_entity,
            type: item.target_type,
            reason: item.reason,
            geo: resolveTargetGeo(item.target_entity),
            dossierId: null,
            jailedAt: item.jailed_at.getTime(),
            expiresAt: item.expires_at ? item.expires_at.getTime() : null,
            isPermanent: item.is_permanent,
        }));

        return res.status(200).json({
            successful: true,
            jails,
            data: { jails },
        });
    } catch (err) {
        console.error('[JAILS] Query Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'JAILS_FETCH_FAILURE',
            message: err.message,
        });
    }
});

/**
 * Release Quarantined Entity (Single IP or /24 Subnet)
 * Endpoint: POST /api/v1/jails/unblock
 */
router.post('/unblock', async (req, res) => {
    const target = req.body?.ip || req.body?.target;

    if (!target || typeof target !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_TARGET',
            message: 'Target IP or subnet is required for unblocking.',
        });
    }

    const cleanTarget = target.trim();

    try {
        // 1. Update Database Record
        await prisma.active_quarantine.updateMany({
            where: { target_entity: cleanTarget },
            data: {
                is_active: false,
            },
        });

        // 2. Broadcast Unblock to Gateway Cluster via Redis Pub/Sub
        if (isRedisReady()) {
            await redis.publish('system:hot-rules', JSON.stringify({
                action: 'UNJAIL_ENTITY',
                target: cleanTarget,
            })).catch(() => { });
        }

        return res.status(200).json({
            successful: true,
            message: `Entity '${cleanTarget}' successfully released from quarantine.`,
        });
    } catch (err) {
        console.error('[JAILS] Unblock Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'UNBLOCK_FAILURE',
            message: err.message,
        });
    }
});

/**
 * Register Manual Custom Block
 * Endpoint: POST /api/v1/jails/custom-block
 */
router.post('/custom-block', async (req, res) => {
    const { ip, durationMs, reason } = req.body || {};

    if (!ip || typeof ip !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_TARGET',
            message: 'Target IP or CIDR range is required.',
        });
    }

    const cleanTarget = ip.trim();
    const isSubnet = cleanTarget.includes('/');
    const targetType = isSubnet ? 'SUBNET_24' : 'SINGLE_IP';
    const opReason = String(reason || 'STAFF_MANUAL_JAIL').trim();

    const isPermanent = durationMs === 'PERMANENT' || Number(durationMs) >= 31536000000;
    const durationNumber = Number(durationMs) || (2 * 3600 * 1000); // Default 2 hours
    const expiresAt = isPermanent ? null : new Date(Date.now() + durationNumber);

    try {
        // 1. Persist in Database
        const record = await prisma.active_quarantine.create({
            data: {
                target_entity: cleanTarget,
                target_type: targetType,
                reason: opReason,
                expires_at: expiresAt,
                is_permanent: isPermanent,
                is_active: true,
            },
        });

        // 2. Broadcast to Gateway In-Memory Radix Jail via Redis
        if (isRedisReady()) {
            await redis.publish('system:hot-rules', JSON.stringify({
                action: 'JAIL_ENTITY',
                target: cleanTarget,
                durationSeconds: isPermanent ? 0 : Math.floor(durationNumber / 1000),
                reason: opReason,
                isPermanent,
            })).catch(() => { });
        }

        return res.status(200).json({
            successful: true,
            message: `Quarantine enforced for ${cleanTarget}.`,
            data: {
                id: record.jail_id,
                target: cleanTarget,
                type: targetType,
                expiresAt: expiresAt ? expiresAt.getTime() : null,
                isPermanent,
            },
        });
    } catch (err) {
        console.error('[JAILS] Custom Block Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'CUSTOM_BLOCK_FAILURE',
            message: err.message,
        });
    }
});

/**
 * Promote Temporary Jail to Permanent Blacklist
 * Endpoint: POST /api/v1/jails/make-permanent
 */
router.post('/make-permanent', async (req, res) => {
    const { target } = req.body || {};

    if (!target || typeof target !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_TARGET',
            message: 'Target entity is required.',
        });
    }

    try {
        await prisma.active_quarantine.updateMany({
            where: { target_entity: target.trim() },
            data: {
                is_permanent: true,
                expires_at: null,
            },
        });

        if (isRedisReady()) {
            await redis.publish('system:hot-rules', JSON.stringify({
                action: 'JAIL_ENTITY',
                target: target.trim(),
                isPermanent: true,
                reason: 'PROMOTED_TO_PERMANENT_BLACKLIST',
            })).catch(() => { });
        }

        return res.status(200).json({
            successful: true,
            message: `Entity '${target}' promoted to permanent blacklist.`,
        });
    } catch (err) {
        console.error('[JAILS] Make-Permanent Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'PROMOTION_FAILURE',
            message: err.message,
        });
    }
});

export default router;
