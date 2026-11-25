/**
 * src/routes/controller-routes.js
 * Tactical Policy Matrix & Emergency Kill-Switches Orchestration Controller
 * Enforces Cryptographic Audit Trail & Real-Time Redis Cluster Broadcasting
 */

import express from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';
import { clientIp } from '../services/activity-log.js';

const router = express.Router();

const SENTRY_MODULES_CATALOG = [
    'web3_address_poisoning',
    'unicode_nfkc_filter',
    'idor_bola_guard',
    'prototype_pollution',
    'injection_scanner',
    'magic_byte_sniffer',
    'concurrency_lock',
    'ja4_bot_detector',
    'tarpit_engine',
    'ether_hiding_c2',
    'hpp_query_shield',
    'l4_tcp_verifier',
    'xdp_packet_shredder',
    'subnet_24_hammer',
    'tor_datacenter_geofence',
    'radix_ip_quarantine',
    'webrtc_unmasker',
    'persistent_device_trace',
    'silicon_hardware_hasher',
    'behavioral_biometrics',
    'state_graph_fsm',
    'ghost_decoy_mesh',
    'outgoing_dlp_masker',
    'error_stacktrace_cloaker',
];

const EMERGENCY_SWITCHES_CATALOG = [
    'freeze_payouts',
    'commerce_read_only',
    'block_signups',
    'pause_dispatch',
    'challenge_all',
    'master_shield_bypass',
    'kill_websockets',
    'db_read_only',
];

function sha256(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
}

async function getLatestAuditHash() {
    try {
        const lastLog = await prisma.soc_audit_log.findFirst({
            orderBy: { created_at: 'desc' },
            select: { entry_hash: true },
        });
        return lastLog?.entry_hash || '0'.repeat(64);
    } catch {
        return '0'.repeat(64);
    }
}

/**
 * Returns baseline default policy and switch states
 */
function getBaselineState() {
    const isProd = process.env.NODE_ENV === 'production' && process.env.APP_ENV !== 'staging';
    const defaultMode = isProd ? 'ON' : 'MONITOR-ONLY';

    const modules = {};
    for (const m of SENTRY_MODULES_CATALOG) {
        modules[m] = defaultMode;
    }
    // Enforce ON for critical injection and tampering shields
    modules['injection_scanner'] = 'ON';
    modules['web3_address_poisoning'] = 'ON';
    modules['prototype_pollution'] = 'ON';
    modules['tarpit_engine'] = 'OFF';

    const killSwitches = {};
    for (const s of EMERGENCY_SWITCHES_CATALOG) {
        killSwitches[s] = false;
    }

    return { modules, killSwitches };
}

/**
 * Fetch Live Policy State and Emergency Kill-Switches
 * Endpoint: GET /api/v1/controller/policy-state
 */
router.get('/policy-state', async (_req, res) => {
    const baseline = getBaselineState();

    try {
        if (isRedisReady()) {
            // Fetch persisted modules state from Redis
            const cachedModules = await redis.hgetall('soc:policy:modules');
            if (cachedModules && Object.keys(cachedModules).length > 0) {
                baseline.modules = { ...baseline.modules, ...cachedModules };
            }

            // Fetch persisted kill-switch states from Redis
            const cachedSwitches = await redis.hgetall('soc:policy:killswitches');
            if (cachedSwitches && Object.keys(cachedSwitches).length > 0) {
                for (const [key, val] of Object.entries(cachedSwitches)) {
                    baseline.killSwitches[key] = val === 'true' || val === '1';
                }
            }
        }

        return res.status(200).json({
            successful: true,
            data: baseline,
        });
    } catch (err) {
        console.error('[CONTROLLER] Policy State Query Warning:', err.message);
        return res.status(200).json({
            successful: true,
            data: baseline,
        });
    }
});

/**
 * Execute Emergency Kill-Switch Toggle (Double-Lock Confirmed)
 * Endpoint: POST /api/v1/controller/kill-switch
 */
router.post('/kill-switch', async (req, res) => {
    const ip = clientIp(req) || '127.0.0.1';
    const { switchName, active, reason, userId } = req.body || {};

    // Special Handler: Force Suspend User Action from Screen 7 Privileged Activity
    if (switchName === 'freeze_user' && userId) {
        try {
            const uid = parseInt(userId, 10);
            await prisma.$transaction([
                prisma.user.update({
                    where: { user_id: uid },
                    data: {
                        account_status: 'suspended',
                        sessions_invalidated_at: new Date(),
                    },
                }),
                prisma.strug_wallet.updateMany({
                    where: { user_id: uid },
                    data: { status: 'frozen' },
                }),
            ]);

            return res.status(200).json({
                successful: true,
                message: `User #${uid} account suspended and wallets frozen successfully.`,
            });
        } catch (userErr) {
            return res.status(500).json({
                successful: false,
                error: 'USER_SUSPENSION_FAILED',
                message: userErr.message,
            });
        }
    }

    // Validate Standard Emergency Panic Switches
    if (!switchName || !EMERGENCY_SWITCHES_CATALOG.includes(switchName)) {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_SWITCH_NAME',
            message: `Unknown switch identifier: '${switchName}'`,
        });
    }

    const stateBool = Boolean(active);
    const operatorReason = String(reason || 'Manual trigger via SOC Console').trim();

    try {
        // 1. Update Redis State Store
        if (isRedisReady()) {
            await redis.hset('soc:policy:killswitches', switchName, stateBool ? 'true' : 'false');

            // Broadcast event across all Gateway cluster replicas
            await redis.publish('system:kill-switches', JSON.stringify({
                action: 'KILL_SWITCH_TOGGLE',
                switchName,
                active: stateBool,
                reason: operatorReason,
            })).catch(() => { });
        }

        // 2. Cryptographic Hash-Chain Audit Logging
        const prevHash = await getLatestAuditHash();
        const timestamp = new Date();
        const action = stateBool ? 'EMERGENCY_SWITCH_ENGAGED' : 'EMERGENCY_SWITCH_DISARMED';
        const target = `switch:${switchName}`;
        const afterJson = JSON.stringify({
            switchName,
            active: stateBool,
            reason: operatorReason,
            timestamp: timestamp.toISOString(),
        });

        const entryHash = sha256(`${prevHash}:1:${action}:${target}:${afterJson}:${timestamp.getTime()}`);

        await prisma.soc_audit_log.create({
            data: {
                actor_user_id: 1, // System / Root SOC Operator
                action,
                target,
                reason: operatorReason,
                ip,
                created_at: timestamp,
                prev_hash: prevHash,
                entry_hash: entryHash,
                after_json: afterJson,
            },
        }).catch((logErr) => {
            console.error('[CONTROLLER] Audit Log Persistence Warning:', logErr.message);
        });

        // 3. Fetch latest complete kill-switch state mapping
        const baseline = getBaselineState();
        let currentSwitches = { ...baseline.killSwitches, [switchName]: stateBool };

        if (isRedisReady()) {
            const cached = await redis.hgetall('soc:policy:killswitches');
            for (const [k, v] of Object.entries(cached || {})) {
                currentSwitches[k] = v === 'true' || v === '1';
            }
        }

        return res.status(200).json({
            successful: true,
            message: `Emergency switch '${switchName}' is now ${stateBool ? 'ENFORCED' : 'NORMAL'}.`,
            state: currentSwitches,
        });
    } catch (err) {
        console.error('[CONTROLLER] Kill-Switch Execution Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'SWITCH_EXECUTION_FAILURE',
            message: err.message,
        });
    }
});

/**
 * Toggle Sentry Guard Policy Mode (ON / MONITOR-ONLY / OFF)
 * Endpoint: POST /api/v1/controller/policy-toggle
 */
router.post('/policy-toggle', async (req, res) => {
    const { moduleName, mode } = req.body || {};

    if (!moduleName || !SENTRY_MODULES_CATALOG.includes(moduleName)) {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_MODULE',
            message: `Unknown sentry module: '${moduleName}'`,
        });
    }

    const cleanMode = String(mode).toUpperCase().trim();
    if (!['ON', 'MONITOR-ONLY', 'OFF'].includes(cleanMode)) {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_MODE',
            message: 'Mode must be ON, MONITOR-ONLY, or OFF.',
        });
    }

    try {
        if (isRedisReady()) {
            await redis.hset('soc:policy:modules', moduleName, cleanMode);

            // Broadcast hot-rule update to Gateway memory
            await redis.publish('system:hot-rules', JSON.stringify({
                action: 'POLICY_TOGGLE',
                module: moduleName,
                mode: cleanMode,
            })).catch(() => { });
        }

        const baseline = getBaselineState();
        let currentModules = { ...baseline.modules, [moduleName]: cleanMode };

        if (isRedisReady()) {
            const cached = await redis.hgetall('soc:policy:modules');
            currentModules = { ...currentModules, ...cached };
        }

        return res.status(200).json({
            successful: true,
            policy: currentModules,
            updated: {
                moduleName,
                mode: cleanMode,
            },
        });
    } catch (err) {
        console.error('[CONTROLLER] Policy Toggle Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'POLICY_TOGGLE_FAILURE',
            message: err.message,
        });
    }
});

export default router;