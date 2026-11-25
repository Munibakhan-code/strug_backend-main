import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';
import { decrypt, emailSearchCiphertexts, normalizeEmail } from '../utils/crypto.js';
import mailerEvents from '../utils/mailer-event.js';
import { recordActivity, clientIp } from '../services/activity-log.js';

const router = express.Router();

const OTP_EXPIRY_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 3;
const CHALLENGE_EXPIRY_SECONDS = 300;
const SOC_SESSION_TTL_SECONDS = parseInt(process.env.SOC_SESSION_TTL_SECONDS || '1800', 10);

const DUMMY_BCRYPT_HASH = '$2b$10$e7Vj/zF7gI3fN5oD0h87U.8M32k9LwP7V1v7f6x.WqV8rB9mS2z2q';

function getSocSecrets() {
    const challengeSecret = process.env.SOC_CHALLENGE_SECRET || process.env.ACCESS_TOKEN_KEY;
    const sessionSecret = process.env.SOC_SESSION_SECRET || process.env.ACCESS_TOKEN_KEY;
    if (!challengeSecret || !sessionSecret) {
        throw new Error('CRITICAL_CONFIG_ERROR: SOC JWT signing keys are undefined in environment.');
    }
    return { challengeSecret, sessionSecret };
}

function sha256(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'unknown';
    const [local, domain] = email.split('@');
    if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
    }
    return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

async function rateLimitCheck(key, limit, windowSeconds) {
    if (!isRedisReady()) return true;
    try {
        const current = await redis.incr(key);
        if (current === 1) {
            await redis.expire(key, windowSeconds);
        }
        return current <= limit;
    } catch {
        return true;
    }
}

/**
 * Phase-1: Primary Credentials & Ephemeral OTP Issuance
 * Routes: POST /api/v1/auth/login and POST /soc-auth/login
 */
async function handleLoginPhase1(req, res) {
    const ip = clientIp(req) || 'unknown';
    const ipRateKey = `rl:soc-login:ip:${ip}`;
    const ipAllowed = await rateLimitCheck(ipRateKey, 10, 900);

    if (!ipAllowed) {
        return res.status(429).json({
            successful: false,
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many authentication attempts. Ingress throttled for 15 minutes.',
        });
    }

    const { email, password } = req.body || {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_INPUT',
            message: 'Email and master password are required.',
        });
    }

    const normalizedEmail = normalizeEmail(email);
    const accountRateKey = `rl:soc-login:account:${normalizedEmail}`;
    const accountAllowed = await rateLimitCheck(accountRateKey, 5, 900);

    if (!accountAllowed) {
        return res.status(429).json({
            successful: false,
            error: 'ACCOUNT_LOCKED',
            message: 'Account locked due to excessive authentication failures. Retry after 15 minutes.',
        });
    }

    try {
        const searchKeys = emailSearchCiphertexts(normalizedEmail);
        const user = await prisma.user.findFirst({
            where: { email: { in: searchKeys } },
            select: {
                user_id: true,
                name: true,
                username: true,
                email: true,
                password: true,
                security_admin: true,
                account_status: true,
            },
        });

        const targetHash = user?.password || DUMMY_BCRYPT_HASH;
        let passwordValid = false;
        try {
            passwordValid = await bcrypt.compare(password, targetHash);
        } catch {
            passwordValid = false;
        }

        if (!user || !passwordValid || user.security_admin !== true) {
            recordActivity(user?.user_id || null, 'soc.login_phase1_failed', {
                description: 'Failed SOC Phase-1 authentication attempt',
                ip,
                userAgent: req.headers['user-agent'],
            });

            return res.status(401).json({
                successful: false,
                error: 'INVALID_CREDENTIALS',
                message: 'Invalid administrative credentials or insufficient privileges.',
            });
        }

        if (user.account_status !== 'active') {
            recordActivity(user.user_id, 'soc.login_blocked', {
                description: `Blocked SOC login: Account status is ${user.account_status}`,
                ip,
                userAgent: req.headers['user-agent'],
            });

            return res.status(403).json({
                successful: false,
                error: 'ACCOUNT_INACTIVE',
                message: 'Administrative account is inactive or quarantined.',
            });
        }

        if (isRedisReady()) {
            await redis.del(accountRateKey);
        }

        const otpCode = crypto.randomInt(100000, 1000000).toString();
        const otpHashed = sha256(otpCode);
        const otpKey = `soc:otp:${user.user_id}`;
        const otpAttemptsKey = `soc:otp:attempts:${user.user_id}`;

        if (isRedisReady()) {
            await redis.set(otpKey, otpHashed, 'EX', OTP_EXPIRY_SECONDS);
            await redis.set(otpAttemptsKey, '0', 'EX', OTP_EXPIRY_SECONDS);
        }

        let recipientEmail;
        try {
            recipientEmail = decrypt(user.email);
        } catch {
            recipientEmail = normalizedEmail;
        }

        mailerEvents.emit('send_email', {
            templateName: 'otp',
            variables: {
                otp_code: otpCode,
                admin_name: user.name || user.username || 'Security Operator',
                ip_address: ip,
                login_time: new Date().toISOString(),
            },
            to: recipientEmail,
            subjectKey: 'emails.subjects.soc_otp',
        });

        const { challengeSecret } = getSocSecrets();
        const challengeTicket = jwt.sign(
            {
                user_id: user.user_id,
                email: recipientEmail,
                purpose: 'soc_2fa_challenge',
                ip_hash: sha256(ip),
            },
            challengeSecret,
            { expiresIn: CHALLENGE_EXPIRY_SECONDS }
        );

        recordActivity(user.user_id, 'soc.login_phase1_success', {
            description: 'Dispatched SOC 2FA challenge OTP',
            ip,
            userAgent: req.headers['user-agent'],
        });

        return res.status(200).json({
            successful: true,
            challengeTicket,
            email: maskEmail(recipientEmail),
            expires_in: CHALLENGE_EXPIRY_SECONDS,
            member: {
                user_id: user.user_id,
                name: user.name || user.username,
                email: recipientEmail,
            },
            message: 'Two-factor challenge issued. Verification code dispatched to registered mail.',
        });
    } catch (err) {
        console.error('[SOC-AUTH] Phase-1 Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'INTERNAL_SECURITY_ERROR',
            message: 'Authentication kernel failure.',
        });
    }
}

/**
 * Phase-2: Cryptographic 2FA Verification & Session Issuance
 * Routes: POST /api/v1/auth/verify-otp and POST /soc-auth/verify-otp
 */
async function handleVerifyOtp(req, res) {
    const ip = clientIp(req) || 'unknown';
    const { challengeTicket, otp } = req.body || {};

    if (!challengeTicket || typeof challengeTicket !== 'string' || !otp || typeof otp !== 'string') {
        return res.status(400).json({
            successful: false,
            error: 'INVALID_PAYLOAD',
            message: 'Valid challenge ticket and 6-digit OTP code are required.',
        });
    }

    const cleanOtp = otp.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
        return res.status(400).json({
            successful: false,
            error: 'MALFORMED_OTP',
            message: 'Verification code must be exactly 6 numeric digits.',
        });
    }

    let decoded;
    try {
        const { challengeSecret } = getSocSecrets();
        decoded = jwt.verify(challengeTicket, challengeSecret);
    } catch {
        return res.status(401).json({
            successful: false,
            error: 'EXPIRED_OR_INVALID_CHALLENGE',
            message: 'Challenge ticket has expired or contains an invalid signature. Restart login flow.',
        });
    }

    if (decoded.purpose !== 'soc_2fa_challenge' || !decoded.user_id) {
        return res.status(401).json({
            successful: false,
            error: 'INVALID_CHALLENGE_PURPOSE',
            message: 'Ticket semantics mismatch.',
        });
    }

    const userId = decoded.user_id;
    const otpKey = `soc:otp:${userId}`;
    const otpAttemptsKey = `soc:otp:attempts:${userId}`;

    try {
        if (isRedisReady()) {
            const attempts = await redis.incr(otpAttemptsKey);
            if (attempts > OTP_MAX_ATTEMPTS) {
                await redis.del(otpKey);
                await redis.del(otpAttemptsKey);

                return res.status(429).json({
                    successful: false,
                    error: 'MAX_ATTEMPTS_EXCEEDED',
                    message: 'Maximum OTP verification attempts breached. Challenge ticket burned.',
                });
            }

            const storedOtpHex = await redis.get(otpKey);
            if (!storedOtpHex) {
                return res.status(400).json({
                    successful: false,
                    error: 'OTP_EXPIRED_OR_NOT_FOUND',
                    message: 'Verification code has expired or was already consumed.',
                });
            }

            const suppliedOtpHex = sha256(cleanOtp);
            const storedBuffer = Buffer.from(storedOtpHex, 'hex');
            const suppliedBuffer = Buffer.from(suppliedOtpHex, 'hex');

            const isValid =
                storedBuffer.length === suppliedBuffer.length &&
                crypto.timingSafeEqual(storedBuffer, suppliedBuffer);

            if (!isValid) {
                return res.status(400).json({
                    successful: false,
                    error: 'INVALID_VERIFICATION_CODE',
                    message: 'Supplied verification code does not match records.',
                    remaining_attempts: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
                });
            }

            // Atomic Burn: Delete OTP immediately upon success
            await redis.del(otpKey);
            await redis.del(otpAttemptsKey);
        }

        const user = await prisma.user.findUnique({
            where: { user_id: userId },
            select: {
                user_id: true,
                name: true,
                username: true,
                email: true,
                security_admin: true,
                account_status: true,
            },
        });

        if (!user || user.security_admin !== true || user.account_status !== 'active') {
            return res.status(403).json({
                successful: false,
                error: 'PRIVILEGE_REVOCATION_INTERCEPT',
                message: 'Security administrator privileges have been modified or revoked.',
            });
        }

        const newSessionId = crypto.randomUUID();
        const activeSessionKey = `soc:active-session:${userId}`;

        if (isRedisReady()) {
            const previousSessionId = await redis.get(activeSessionKey);
            if (previousSessionId) {
                await redis.set(`soc:revoked-session:${previousSessionId}`, '1', 'EX', SOC_SESSION_TTL_SECONDS);
            }
            await redis.set(activeSessionKey, newSessionId, 'EX', SOC_SESSION_TTL_SECONDS);
        }

        let decryptedEmail;
        try {
            decryptedEmail = decrypt(user.email);
        } catch {
            decryptedEmail = decoded.email || 'operator@strug.ca';
        }

        const { sessionSecret } = getSocSecrets();
        const sessionToken = jwt.sign(
            {
                user_id: user.user_id,
                session_id: newSessionId,
                permission: 'security_admin',
                email: decryptedEmail,
                ip,
            },
            sessionSecret,
            { expiresIn: SOC_SESSION_TTL_SECONDS }
        );

        recordActivity(user.user_id, 'soc.session_authenticated', {
            description: 'SOC administrative session established',
            ip,
            userAgent: req.headers['user-agent'],
            metadata: { session_id: newSessionId },
        });

        return res.status(200).json({
            successful: true,
            sessionToken,
            token: sessionToken,
            sessionId: newSessionId,
            expiresIn: SOC_SESSION_TTL_SECONDS,
            admin: {
                user_id: user.user_id,
                name: user.name || user.username || 'Security Operator',
                email: decryptedEmail,
            },
            message: 'Zero-Trust administrative session initialized.',
        });
    } catch (err) {
        console.error('[SOC-AUTH] Phase-2 Verification Exception:', err.message);
        return res.status(500).json({
            successful: false,
            error: 'VERIFICATION_KERNEL_FAILURE',
            message: 'Fatal error processing session credentials.',
        });
    }
}

/**
 * Route Mappings
 */
router.post('/login', handleLoginPhase1);
router.post('/login-phase1', handleLoginPhase1);
router.post('/verify-otp', handleVerifyOtp);

router.post('/logout', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token && isRedisReady()) {
        try {
            const { sessionSecret } = getSocSecrets();
            const decoded = jwt.verify(token, sessionSecret);
            if (decoded?.session_id) {
                await redis.set(`soc:revoked-session:${decoded.session_id}`, '1', 'EX', SOC_SESSION_TTL_SECONDS);
                await redis.del(`soc:active-session:${decoded.user_id}`);
            }
        } catch {
            // Non-blocking exit
        }
    }

    return res.status(200).json({ successful: true, message: 'Session terminated.' });
});

export default router;
