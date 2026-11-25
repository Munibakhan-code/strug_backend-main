import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import redis, { isRedisReady } from '../utils/redis-client.js';
import { resolveUniqueHandle } from '../utils/profile-identity.js';
import axios from 'axios';
import { jwTokens } from '../utils/jwt-helper.js';
import {
    decrypt,
    emailSearchCiphertexts,
    encryptEmailForStorage,
    normalizeEmail,
} from "../utils/crypto.js";
import prisma from '../utils/prisma-client.js';
import { sendEmail } from '../utils/mailer.js';
import mailerEvents from '../utils/mailer-event.js';
import { emailLngFromRequest, emailLngFromUser, resolveEmailLng, resolveLoginEmailLng } from '../utils/email-lang.js';
import { authenticateToken } from '../middleware/authentication.js';
import { checkAuthRateLimit, clearRateLimit, isAuthRateLimited } from '../utils/rate-limiter.js';
import { validatePasswordStrength } from '../utils/password-policy.js';
import { sendError } from '../utils/api-i18n.js';
import { recordActivity, clientIp } from '../services/activity-log.js';
import { notify } from '../services/notify.js';
import {
    ACCOUNT_SESSION_SELECT,
    evaluateAccountSession,
    isBlockedAccountStatus,
} from '../utils/account-session.js';
import { inspectCriticalSecrets } from '../utils/startup-secrets.js';
import {
    clearUserRefreshJti,
    isCurrentUserRefreshJti,
    rememberUserRefreshJti,
} from '../utils/refresh-session.js';
import { createSessionHandoff, consumeSessionHandoff } from '../utils/session-handoff.js';

const router = express.Router();

const OTP_EXPIRY_MS = 15 * 60 * 1000;
const OTP_GUESS_MAX = 5;

const USER_AUTH_SELECT = {
    user_id: true, name: true, email: true, password: true,
    username: true, ref_code: true, language: true,
    currency: true, country: true, is_creator: true, is_seller: true,
};

function hashOtp(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** Hash-only compare (#1294). Legacy plaintext rows expire via expires_at / created_at TTL. */
function otpMatches(stored, provided) {
    if (!stored || provided == null) return false;
    return stored === hashOtp(provided);
}

function otpExpiryDate(from = new Date()) {
    return new Date(from.getTime() + OTP_EXPIRY_MS);
}

function isEmailOtpExpired(verification) {
    if (!verification) return true;
    if (verification.used_at) return true;
    if (verification.expires_at) {
        return Date.now() > new Date(verification.expires_at).getTime();
    }
    // Legacy rows without expires_at: fall back to created_at window.
    return Date.now() - new Date(verification.created_at).getTime() > OTP_EXPIRY_MS;
}

async function findUserByEmail(email, select) {
    const keys = emailSearchCiphertexts(email);
    if (!keys.length) return null;
    return prisma.user.findFirst({ where: { email: { in: keys } }, select });
}

async function readWelcomeSeen(user_id) {
    try {
        const row = await prisma.user.findUnique({ where: { user_id }, select: { has_seen_welcome: true } });
        return row?.has_seen_welcome ?? false;
    } catch {
        return true;
    }
}

/** Fail closed: if status cannot be read, block login rather than treating the account as active. */
async function readAccountStatus(user_id) {
    const row = await prisma.user.findUnique({ where: { user_id }, select: { account_status: true } });
    if (!row) return 'deleted';
    return row.account_status || 'active';
}

const REFRESH_COOKIE_MAX_AGE = 14 * 24 * 60 * 60 * 1000;

// Separate cookie names so an admin login cannot overwrite a user refresh session (and vice
// versa). Legacy `refreshToken` is still *read* and cleared for migration compatibility.
const USER_REFRESH_COOKIE = 'strug_refresh_token';
const ADMIN_REFRESH_COOKIE = 'strug_admin_refresh_token';
const LEGACY_REFRESH_COOKIE = 'refreshToken';

// The refresh cookie was scoped to the whole `.strug.ca` domain, so ONE cookie was sent to
// api.strug.ca and api.staging.strug.ca alike: a session minted against staging — or by a local
// dev build, which points at the staging API — authenticated against PRODUCTION. That is how a
// stale test@strug.ca cookie could silently sign a real user into the test account on a new tab
// (#414). Scope it to the issuing API host instead, so a session can only ever be replayed
// against the environment that minted it. COOKIE_DOMAIN is deliberately no longer honoured for
// issuing — a shared cookie domain is the bug.
const refreshCookieOptions = () => {
    // Prod / cross-site needs Secure + SameSite=None. Local HTTP can set COOKIE_SECURE=false
    // so DevLogin silent refresh works on localhost without changing production defaults.
    const secure = process.env.COOKIE_SECURE !== '0' && process.env.COOKIE_SECURE !== 'false';
    return {
        httpOnly: true,
        sameSite: secure ? 'None' : 'Lax',
        secure,
        maxAge: REFRESH_COOKIE_MAX_AGE,
        path: '/',
    };
};

// A host-only cookie and a `.strug.ca` domain cookie of the same name are two DISTINCT cookies:
// the browser sends both and the server picks one arbitrarily. So whenever we issue or revoke
// the host-scoped cookie, explicitly delete any legacy domain-scoped one — otherwise the old,
// broadly-shared session lingers for its full 14 days and can still win.
const legacyCookieDomains = () => {
    const domains = new Set(['.strug.ca']);
    if (process.env.COOKIE_DOMAIN) domains.add(process.env.COOKIE_DOMAIN);
    return [...domains];
};

function clearCookieEverywhere(res, name) {
    const secure = process.env.COOKIE_SECURE !== '0' && process.env.COOKIE_SECURE !== 'false';
    const base = { httpOnly: true, sameSite: secure ? 'None' : 'Lax', secure, path: '/' };
    res.clearCookie(name, base);
    for (const domain of legacyCookieDomains()) {
        res.clearCookie(name, { ...base, domain });
    }
}

function clearLegacyRefreshCookie(res) {
    clearCookieEverywhere(res, LEGACY_REFRESH_COOKIE);
}

function clearUserRefreshCookies(res) {
    clearCookieEverywhere(res, USER_REFRESH_COOKIE);
    clearLegacyRefreshCookie(res);
}

function clearAdminRefreshCookies(res) {
    clearCookieEverywhere(res, ADMIN_REFRESH_COOKIE);
}

function setRefreshCookie(res, refreshToken) {
    // Keep admin refresh separate — do not wipe it on user login so concurrent admin + user
    // sessions can coexist (different cookie names). Still clear legacy shared name.
    clearLegacyRefreshCookie(res);
    res.cookie(USER_REFRESH_COOKIE, refreshToken, refreshCookieOptions());
}

/** Issue user refresh cookie and remember its jti for rotation (#1273). */
async function issueUserRefreshSession(res, tokens, userId) {
    setRefreshCookie(res, tokens.refreshToken);
    if (tokens.refreshJti) {
        await rememberUserRefreshJti(userId, tokens.refreshJti);
    }
}

/**
 * Opaque one-time code for proxied strug.ca logins (Set-Cookie never reaches the browser).
 * App claims it on api.strug.ca to set the refresh cookie without minting from the access JWT.
 */
async function sessionHandoffFields(tokens, userId) {
    const session_handoff = await createSessionHandoff(tokens.refreshToken, userId);
    return session_handoff ? { session_handoff } : {};
}

function setAdminRefreshCookie(res, refreshToken, maxAge) {
    // Do not clear the user refresh cookie — admin and user cookies are intentionally separate.
    clearLegacyRefreshCookie(res);
    const secure = process.env.COOKIE_SECURE !== '0' && process.env.COOKIE_SECURE !== 'false';
    const opts = {
        httpOnly: true,
        sameSite: secure ? 'None' : 'Lax',
        secure,
        path: '/',
        ...(maxAge != null ? { maxAge } : {}),
    };
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, opts);
}

function readUserRefreshToken(req) {
    // Cookie-only: do not accept refresh JWTs from the request body (replay without cookie channel).
    return req.cookies?.[USER_REFRESH_COOKIE] || req.cookies?.[LEGACY_REFRESH_COOKIE] || null;
}

router.post('/register-request', async (req, res) => {
    try {
        const { email, username } = req.body;

        if (!email || !email.includes('@')) {
            return sendError(res, 400, req, 'auth.validEmailRequired');
        }

        const normalizedEmail = normalizeEmail(email);

        const otpSendLimited = await checkAuthRateLimit(`rl:otp-send:${normalizedEmail}`, 3, 600);
        if (otpSendLimited) {
            return sendError(res, 429, req, 'auth.tooManyOtpRequests');
        }

        const existing = await findUserByEmail(normalizedEmail, { user_id: true }).catch(() => null);
        // Username conflicts are safe to surface early (not an email-existence oracle).
        // Returning fake success here stranded users on OTP with no mail and a late 409.
        if (username) {
            const usernameTaken = !!(await prisma.user.findFirst({
                where: { username: { equals: String(username), mode: 'insensitive' } },
                select: { user_id: true },
            }).catch(() => null));
            if (usernameTaken) {
                return sendError(res, 409, req, 'auth.usernameTaken');
            }
        }
        // Anti-enumeration: same success shape when the email already has an account.
        if (existing) {
            return res.json({ successful: true, message: "Code sent to email." });
        }

        const otpCode = crypto.randomInt(100000, 1000000).toString();
        await clearRateLimit(`rl:otp-guess:${normalizedEmail}`);

        await prisma.email_verification.upsert({
            where: { email: normalizedEmail },
            update: {
                code: hashOtp(otpCode),
                created_at: new Date(),
                expires_at: otpExpiryDate(),
                used_at: null,
            },
            create: {
                email: normalizedEmail,
                code: hashOtp(otpCode),
                expires_at: otpExpiryDate(),
            },
        });

        mailerEvents.emit('send_email', {
            templateName: 'otp',
            variables: { otp_code: otpCode },
            to: normalizedEmail,
            subjectKey: 'emails.subjects.otp',
            lng: emailLngFromRequest(req),
        });

        res.json({ successful: true, message: "Code sent to email." });
    } catch (err) {
        console.error(err);
        return sendError(res, 500, req, 'auth.failedSendCode');
    }
});

router.post('/verify-otp-and-register', async (req, res) => {
    try {
        const { email, name, username, password, otp, accepted_terms: acceptedTermsBody } = req.body;
        const acceptedTerms = acceptedTermsBody === true || acceptedTermsBody === 'true' || acceptedTermsBody === 1 || acceptedTermsBody === '1';

        if (!email || !name || !password || !otp) {
            return sendError(res, 400, req, 'auth.registerFieldsRequired');
        }

        if (!acceptedTerms) {
            return sendError(res, 400, req, 'auth.termsRequired');
        }

        const normalizedEmail = normalizeEmail(email);

        const pwdErrors = validatePasswordStrength(password);
        if (pwdErrors.length > 0) {
            return sendError(res, 400, req, 'auth.passwordRequirements', { requirements: pwdErrors.join(', ') });
        }

        if (username) {
            const taken = await prisma.user.findFirst({
                where: { username: { equals: String(username), mode: 'insensitive' } },
                select: { user_id: true },
            });
            if (taken) {
                return sendError(res, 409, req, 'auth.usernameTaken');
            }
        }

        const duplicate = await findUserByEmail(normalizedEmail, { user_id: true });
        if (duplicate) {
            return sendError(res, 409, req, 'auth.accountEmailExists');
        }

        const verification = await prisma.email_verification.findUnique({ where: { email: normalizedEmail } });
        if (!verification) {
            return sendError(res, 400, req, 'auth.noVerificationCode');
        }

        if (isEmailOtpExpired(verification)) {
            await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });
            return sendError(res, 400, req, 'auth.verificationExpired');
        }

        if (!otpMatches(verification.code, otp)) {
            const guessLimited = await checkAuthRateLimit(`rl:otp-guess:${normalizedEmail}`, OTP_GUESS_MAX - 1, 900);
            if (guessLimited) {
                await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });
                return sendError(res, 400, req, 'auth.tooManyOtpAttempts');
            }
            return sendError(res, 400, req, 'auth.invalidVerificationCode');
        }

        await prisma.email_verification.update({
            where: { email: normalizedEmail },
            data: { used_at: new Date() },
        }).catch(() => { });

        const encryptedEmail = encryptEmailForStorage(normalizedEmail);
        const hashedPassword = await bcrypt.hash(password, 10);

        // ✅ නිවැරදි කළ PRODUCTION-GRADE CODE එක (Location 1):
        let newUser;
        let newProfile;
        try {
            // Atomic Provisioning: User + Wallets + Social Profile (Single Transaction)
            [newUser, newProfile] = await prisma.$transaction(async (tx) => {
                const createdUser = await tx.user.create({
                    data: {
                        email: encryptedEmail,
                        name: name,
                        username: username || null,
                        password: hashedPassword,
                        ref_code: "STRUG-" + Math.random().toString(36).substring(7).toUpperCase(),
                        language: emailLngFromRequest(req),
                        strug_wallet: {
                            create: {
                                balance: 0.00,
                                currency: "CAD",
                                status: "active"
                            }
                        },
                        ads_wallet: {
                            create: {
                                balance: 0.00,
                                currency: "CAD",
                                status: "active"
                            }
                        }
                    }
                });

                // Safe handle resolution using Phase 1 Helper
                const rawHandle = username || createdUser.name || `user${createdUser.user_id}`;
                const safeHandle = await resolveUniqueHandle(rawHandle, createdUser.user_id);

                // Auto-provision Social Profile
                const createdProfile = await tx.social_profile.create({
                    data: {
                        user_id: createdUser.user_id,
                        handle: safeHandle,
                        display_name: createdUser.name || safeHandle,
                        accepted_terms: true,
                    }
                });

                // Keep user.username strictly in sync
                if (createdUser.username !== safeHandle) {
                    await tx.user.update({
                        where: { user_id: createdUser.user_id },
                        data: { username: safeHandle },
                        select: { user_id: true, username: true }
                    });
                    createdUser.username = safeHandle;
                }

                return [createdUser, createdProfile];
            });
        } catch (dbErr) {
            if (dbErr.code === 'P2002') {
                return sendError(res, 409, req, 'auth.accountEmailExists');
            }
            throw dbErr;
        }

        await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });

        recordActivity(newUser.user_id, 'user.signup', {
            description: 'Registered with email',
            ip: clientIp(req),
            userAgent: req.headers['user-agent'],
        });

        sendEmail(
            'welcome',
            { name: name },
            normalizedEmail,
            'emails.subjects.welcome',
            emailLngFromRequest(req),
        ).catch((err) => console.error('Welcome email failed:', err?.message || err));

        const tokens = jwTokens(encryptedEmail, name, "user", newUser.user_id, null);
        await issueUserRefreshSession(res, tokens, newUser.user_id);
        const handoff = await sessionHandoffFields(tokens, newUser.user_id);

        res.status(201).json({
            successful: true,
            message: "Registered successfully!",
            accessToken: tokens.accessToken,
            ...handoff,
            user: {
                user_id: newUser.user_id,
                name: newUser.name,
                email: normalizedEmail,
                username: newUser.username ?? null,
                ref_code: newUser.ref_code,
                language: newUser.language ?? 'en',
                currency: newUser.currency ?? null,
                country: newUser.country ?? null,
                is_creator: newUser.is_creator ?? false,
                is_seller: newUser.is_seller ?? false,
                is_driver: false,
                is_courier: false,
                has_password: true,
                has_seen_welcome: false,
                profile_id: newProfile.profile_id,
                social_created_at: newProfile.created_at,
            }
        });
    } catch (err) {
        console.error("Registration Error:", err);
        return sendError(res, 500, req, 'auth.verificationFailed');
    }
});

router.post('/password-reset-request', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return sendError(res, 400, req, 'auth.validEmailRequired');
        }

        const normalizedEmail = normalizeEmail(email);
        const emailRlKey = `rl:pw-reset:${normalizedEmail}`;
        const ipKey = `rl:pw-reset:ip:${clientIp(req) || 'unknown'}`;

        // Increment-and-check (not peek-then-increment): peek allows max+1 because
        // isAuthRateLimited only trips when count > max after prior successful incrs.
        const emailLimited = await checkAuthRateLimit(emailRlKey, 3, 900);
        const ipLimited = await checkAuthRateLimit(ipKey, 30, 900);
        if (emailLimited || ipLimited) {
            return sendError(res, 429, req, 'auth.tooManyRequests');
        }

        const user = await findUserByEmail(normalizedEmail);
        const genericOk = () => res.json({
            successful: true,
            message: 'If an account with that email exists, reset instructions have been sent.',
        });

        if (!user) {
            return genericOk();
        }

        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        const encryptedEmailForReset = encryptEmailForStorage(normalizedEmail);
        await prisma.$transaction([
            prisma.password_reset_tokens.deleteMany({ where: { user_id: user.user_id, used: false } }),
            prisma.password_reset_tokens.create({
                data: { email: encryptedEmailForReset, token_hash: tokenHash, expires_at: expiresAt, user_id: user.user_id }
            }),
        ]);

        // App host only — never marketing FRONTEND_URL (strug.ca) for /reset-password (#1266).
        const resetBase = String(process.env.APP_FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
        const resetUrl = `${resetBase}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;

        // Fire-and-forget mail so send failures cannot 500-enumerate existing accounts (#1263).
        mailerEvents.emit('send_email', {
            templateName: 'password-reset',
            variables: { name: user.name, reset_url: resetUrl },
            to: normalizedEmail,
            subjectKey: 'emails.subjects.password_reset',
            user,
        });

        return genericOk();
    } catch (err) {
        console.error("Password Reset Error:", err);
        // Still generic success shape when possible — avoid oracle on unexpected errors after lookup.
        return res.json({
            successful: true,
            message: 'If an account with that email exists, reset instructions have been sent.',
        });
    }
});

router.post('/reset-password-confirm', async (req, res) => {
    try {
        const { email, newPassword, token } = req.body;
        if (!email || !newPassword || !token) {
            return sendError(res, 400, req, 'auth.resetFieldsRequired');
        }

        const pwdErrors = validatePasswordStrength(newPassword);
        if (pwdErrors.length > 0) {
            return sendError(res, 400, req, 'auth.passwordRequirements', { requirements: pwdErrors.join(', ') });
        }

        const normalizedEmail = normalizeEmail(email);
        // Include legacy (as-typed) ciphertext so outstanding reset tokens still match.
        const emailKeys = emailSearchCiphertexts(email);

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const record = await prisma.password_reset_tokens.findUnique({ where: { token_hash: tokenHash } });

        if (!record || record.used || record.expires_at < new Date() || !emailKeys.includes(record.email)) {
            return sendError(res, 400, req, 'auth.invalidResetLink');
        }

        const user = await findUserByEmail(email, { user_id: true });
        if (!user || user.user_id !== record.user_id) {
            return sendError(res, 400, req, 'auth.invalidResetLink');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Atomic one-time claim (#1264) inside the same transaction as the password
        // update: if the write fails, the token is not left permanently burned.
        try {
            await prisma.$transaction(async (tx) => {
                const claimed = await tx.password_reset_tokens.updateMany({
                    where: {
                        token_hash: tokenHash,
                        used: false,
                        expires_at: { gt: new Date() },
                        user_id: record.user_id,
                    },
                    data: { used: true },
                });
                if (claimed.count !== 1) {
                    const err = new Error('RESET_TOKEN_CLAIM_FAILED');
                    err.code = 'RESET_TOKEN_CLAIM_FAILED';
                    throw err;
                }

                await tx.user.update({
                    where: { user_id: record.user_id },
                    data: {
                        password: hashedPassword,
                        password_changed_at: new Date(),
                        sessions_invalidated_at: new Date(),
                    },
                });
                await tx.password_reset_tokens.updateMany({
                    where: { user_id: record.user_id, used: false, NOT: { token_hash: tokenHash } },
                    data: { used: true },
                });
            });
        } catch (txErr) {
            if (txErr?.code === 'RESET_TOKEN_CLAIM_FAILED') {
                return sendError(res, 400, req, 'auth.invalidResetLink');
            }
            throw txErr;
        }

        await clearUserRefreshJti(record.user_id);
        // Drop any refresh cookie on this browser so an old session cannot silently renew.
        clearUserRefreshCookies(res);

        const resetUser = await prisma.user.findUnique({ where: { user_id: record.user_id } });
        mailerEvents.emit('send_email', {
            templateName: 'password-change-success',
            variables: {},
            to: normalizedEmail,
            subjectKey: 'emails.password_changed.subject',
            user: resetUser,
        });

        notify(req.app.get('io'), {
            userId: record.user_id,
            vertical: 'system',
            type: 'security.password_changed',
            title: 'Your password was changed',
            body: "If you didn't do this, contact support immediately.",
            urgency: 'actionable',
            entityType: 'user',
            entityId: record.user_id,
            actionUrl: 'settings',
        });
        res.json({ successful: true, message: "Password changed successfully!" });
    } catch (err) {
        console.error("Reset Password Error:", err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

router.post('/login', async (req, res) => {
    try {
        const secretIssues = inspectCriticalSecrets();
        if (secretIssues.length) {
            console.error('[auth/login] blocked —', secretIssues.join('; '));
            return res.status(503).json({
                successful: false,
                message: 'Authentication is temporarily unavailable. Restore .env from .env.example (ENCRYPTION_KEY, ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, DATABASE_URL).',
            });
        }

        const { login, password, language: bodyLanguage } = req.body;

        if (typeof login !== 'string' || !login.trim() || typeof password !== 'string' || !password) {
            return sendError(res, 400, req, 'auth.loginFieldsRequired');
        }

        const loginKey = `rl:login:${normalizeEmail(login) || login.trim().toLowerCase()}`;
        const ipKey = `rl:login:ip:${clientIp(req) || 'unknown'}`;

        if (await isAuthRateLimited(loginKey, 5) || await isAuthRateLimited(ipKey, 40)) {
            return sendError(res, 429, req, 'auth.accountLocked');
        }

        let user = null;
        if (login.includes('@')) {
            user = await findUserByEmail(login, USER_AUTH_SELECT);
        }
        if (!user) {
            user = await prisma.user.findFirst({
                where: { username: { equals: login, mode: 'insensitive' } },
                select: USER_AUTH_SELECT,
            });
        }

        if (!user) {
            await checkAuthRateLimit(loginKey, 5, 900);
            await checkAuthRateLimit(ipKey, 40, 900);
            return sendError(res, 401, req, 'auth.invalidCredentials');
        }

        // Per-account bucket so email vs username (or typos) cannot bypass the 5-attempt lock.
        // Return 401 (same as unknown accounts) — not 429 — so a locked uid does not confirm
        // that the resolved identifier maps to a real user.
        const uidKey = `rl:login:uid:${user.user_id}`;
        if (await isAuthRateLimited(uidKey, 5)) {
            return sendError(res, 401, req, 'auth.invalidCredentials');
        }

        let validPassword = false;
        if (typeof user.password === 'string' && user.password.length > 0) {
            try {
                validPassword = await bcrypt.compare(password, user.password);
            } catch (cmpErr) {
                console.error('Login bcrypt.compare failed for user', user.user_id, cmpErr?.message || cmpErr);
                validPassword = false;
            }
        }
        if (!validPassword) {
            await checkAuthRateLimit(loginKey, 5, 900);
            await checkAuthRateLimit(uidKey, 5, 900);
            await checkAuthRateLimit(ipKey, 40, 900);
            recordActivity(user.user_id, 'auth.login_failed', {
                description: 'Failed login — incorrect password',
                ip: clientIp(req),
                userAgent: req.headers['user-agent'],
            });
            return sendError(res, 401, req, 'auth.invalidCredentials');
        }

        let acctStatus;
        try {
            acctStatus = await readAccountStatus(user.user_id);
        } catch (statusErr) {
            console.error('Login account-status check failed:', statusErr?.message || statusErr);
            return res.status(503).json({ successful: false, message: 'Authentication temporarily unavailable' });
        }
        if (isBlockedAccountStatus(acctStatus)) {
            recordActivity(user.user_id, 'auth.login_failed', {
                description: `Login blocked — account ${acctStatus}`,
                ip: clientIp(req),
                userAgent: req.headers['user-agent'],
            });
            return res.status(403).json({ successful: false, message: `This account has been ${acctStatus}.`, account_status: acctStatus });
        }

        await clearRateLimit(loginKey);
        await clearRateLimit(uidKey);

        // #157: the "new login detected" alert previously fired on EVERY login, which is
        // noise for someone signing in repeatedly from the same browser. Only alert for a
        // genuinely new device. A device is "known" only if the request carries a
        // server-issued httpOnly device cookie whose random id we previously recorded for
        // THIS user — a value an attacker on a different browser cannot forge or guess (so,
        // unlike trusting the user-agent header, this can't be used to suppress the alert for
        // a credential-theft login from a new device). Checked BEFORE the fire-and-forget
        // recordActivity below so it doesn't race this read; any failure falls back to alerting.
        const presentedDeviceId = req.cookies?.strug_device || null;
        let isKnownDevice = false;
        if (presentedDeviceId && /^[a-f0-9-]{16,64}$/i.test(presentedDeviceId)) {
            const priorLogin = await prisma.user_activity_event.findFirst({
                where: {
                    user_id: user.user_id,
                    type: 'auth.login',
                    metadata: { path: ['device_id'], equals: presentedDeviceId },
                },
                select: { event_id: true },
            }).catch(() => null);
            isKnownDevice = !!priorLogin;
        }
        // Issue a fresh id for any unrecognized device so the NEXT login from this browser is
        // recognized and stays quiet. Reuse the id when the device is already known.
        const deviceId = isKnownDevice ? presentedDeviceId : crypto.randomUUID();
        res.cookie('strug_device', deviceId, { ...refreshCookieOptions(), maxAge: 1000 * 60 * 60 * 24 * 365 });

        recordActivity(user.user_id, 'auth.login', {
            description: 'Logged in with email',
            ip: clientIp(req),
            userAgent: req.headers['user-agent'],
            metadata: { device_id: deviceId },
        });

        // =========================================================================
        // ZERO-MOCK: REAL PHYSICAL LOCATION ANCHOR SYNC ONLY
        // =========================================================================
        if (isRedisReady() && user.user_id) {
            // 1. Query only real physical coordinates if user is a driver
            const driverLoc = await prisma.driver_profile.findFirst({
                where: { user_id: user.user_id },
                select: { current_lat: true, current_long: true },
            }).catch(() => null);

            let realLat = driverLoc?.current_lat ?? null;
            let realLng = driverLoc?.current_long ?? null;
            let realLabel = realLat ? 'Driver Verified Pin' : null;

            // 2. If not driver, check worker profile for real physical coordinates
            if (realLat == null) {
                const workerLoc = await prisma.worker_profile.findFirst({
                    where: { user_id: user.user_id },
                    select: { current_lat: true, current_long: true },
                }).catch(() => null);

                if (workerLoc?.current_lat != null && workerLoc?.current_long != null) {
                    realLat = workerLoc.current_lat;
                    realLng = workerLoc.current_long;
                    realLabel = 'Worker Verified Pin';
                }
            }

            // 3. PERSIST ONLY IF 100% REAL COORDINATES EXIST. ZERO HARDCODED FALLBACKS.
            if (realLat != null && realLng != null && !isNaN(realLat) && !isNaN(realLng)) {
                const realAnchorPayload = JSON.stringify({
                    lat: parseFloat(realLat),
                    lng: parseFloat(realLng),
                    city: realLabel,
                    country: user.country || 'LK',
                });

                redis.set(`user:geo:${user.user_id}`, realAnchorPayload, 'EX', 7 * 86400).catch(() => { });
                if (deviceId) {
                    redis.set(`device:geo:${deviceId}`, realAnchorPayload, 'EX', 30 * 86400).catch(() => { });
                }
            }
        }
        // =========================================================================
        // END ZERO-MOCK
        // =========================================================================




        const userAgent = req.headers['user-agent'] || 'Mobile Device';
        const loginTime = new Date().toLocaleString();

        let loginEmail;
        try {
            loginEmail = decrypt(user.email);
        } catch {
            loginEmail = (login && login.includes('@')) ? login : null;
        }

        const clientLang = req.headers['x-strug-language'] || bodyLanguage;
        if (clientLang) {
            const preferred = resolveEmailLng(String(clientLang).trim());
            if (preferred && preferred !== user.language) {
                await prisma.user.update({
                    where: { user_id: user.user_id },
                    data: { language: preferred },
                }).catch(() => { });
                user.language = preferred;
            }
        }

        const loginLng = resolveLoginEmailLng(user, req);
        if (!isKnownDevice) {
            sendEmail(
                'login-alert',
                { device_name: userAgent, login_time: loginTime },
                loginEmail,
                'emails.subjects.login_alert',
                loginLng,
            ).catch((err) => console.error('Login alert email failed:', err));
            // The `system` vertical existed with zero producers — security events were email-only,
            // so a user who never reads that inbox had no way to see a strange sign-in. The socket
            // emit is a no-op here (they have no socket yet at login), but the durable row is the
            // point: it's waiting in the bell when they next open the app.
            notify(req.app.get('io'), {
                userId: user.user_id,
                vertical: 'system',
                type: 'security.new_device_login',
                title: 'New sign-in to your account',
                body: `A new device signed in${userAgent ? ` (${userAgent})` : ''}. If this wasn't you, change your password.`,
                urgency: 'actionable',
                entityType: 'user',
                entityId: user.user_id,
                actionUrl: 'settings',
            });
        }

        const tokens = jwTokens(user.email, user.name, "user", user.user_id, null);
        const socialProfile = await prisma.social_profile.findUnique({ where: { user_id: user.user_id }, select: { profile_id: true, created_at: true } }).catch(() => null);
        const hasSeenWelcome = await readWelcomeSeen(user.user_id);
        // Driver/courier are capabilities computed from the durable driver_profile /
        // driver_courier_profile relations, not user columns — echoed here so the rideshare/
        // courier frontend's Provider gate can open the right dashboard for accounts that have
        // one, without a separate lookup. is_courier was previously omitted entirely, which
        // left the courier gate stuck reading `undefined` on every login and re-showing the
        // "Apply as Courier" screen to already-provisioned couriers.
        const driverProfile = await prisma.driver_profile.findFirst({
            where: { user_id: user.user_id },
            select: { driver_profile_id: true, driver_courier_profile: { select: { driver_profile_id: true } } },
        }).catch(() => null);

        await issueUserRefreshSession(res, tokens, user.user_id);
        const handoff = await sessionHandoffFields(tokens, user.user_id);

        res.json({
            successful: true,
            message: "Login successful",
            accessToken: tokens.accessToken,
            ...handoff,
            user: {
                user_id: user.user_id,
                name: user.name,
                email: loginEmail || ((login && login.includes('@')) ? login : null),
                username: user.username ?? null,
                ref_code: user.ref_code,
                language: user.language ?? 'en',
                currency: user.currency ?? null,
                country: user.country ?? null,
                is_creator: user.is_creator ?? false,
                // Persisted provider flag — must be echoed on login so the seller dashboards
                // (ecommerce/shop/floral/etc.) don't re-show the "become a provider" gate after
                // a returning user logs back in (#187/#190). Previously only is_creator was sent.
                is_seller: user.is_seller ?? false,
                is_driver: Boolean(driverProfile),
                is_courier: Boolean(driverProfile?.driver_courier_profile),
                has_password: Boolean(user.password),
                has_seen_welcome: hasSeenWelcome,
                ...(socialProfile ? { profile_id: socialProfile.profile_id, social_created_at: socialProfile.created_at } : {})
            }
        });
    } catch (err) {
        console.error("Login Error:", err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

async function verifyGoogleCredential(credential) {
    if (!credential || typeof credential !== 'string') {
        throw { status: 400, body: { successful: false, message: 'Google credential is required.' } };
    }

    let data;
    try {
        ({ data } = await axios.get(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
        ));
    } catch {
        throw { status: 401, body: { successful: false, message: 'Invalid Google credential' } };
    }

    const validAudiences = [
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_ID_ALT,
    ].filter(Boolean);
    // Audience must be configured — skipping the check when env is empty would accept any Google ID token.
    if (validAudiences.length === 0) {
        console.error('GOOGLE_CLIENT_ID is not configured — rejecting Google login');
        throw { status: 503, body: { successful: false, message: 'Google sign-in is temporarily unavailable' } };
    }
    if (!validAudiences.includes(data.aud)) {
        throw { status: 401, body: { successful: false, message: 'Invalid Google token audience' } };
    }

    if (!data.email || (data.email_verified !== undefined && String(data.email_verified) !== 'true')) {
        throw { status: 401, body: { successful: false, message: 'Google email is not verified.' } };
    }

    return { email: data.email, name: data.name || data.email.split('@')[0] };
}

router.post('/google-login', async (req, res) => {
    try {
        let email;
        try {
            ({ email } = await verifyGoogleCredential(req.body?.credential));
        } catch (e) {
            if (e && e.status) return res.status(e.status).json(e.body);
            throw e;
        }

        const normalizedEmail = normalizeEmail(email);
        const user = await findUserByEmail(normalizedEmail, USER_AUTH_SELECT);

        if (user) {
            let acctStatus;
            try {
                acctStatus = await readAccountStatus(user.user_id);
            } catch (statusErr) {
                console.error('Google login account-status check failed:', statusErr?.message || statusErr);
                return res.status(503).json({ successful: false, message: 'Authentication temporarily unavailable' });
            }
            if (isBlockedAccountStatus(acctStatus)) {
                return res.status(403).json({
                    successful: false,
                    message: `This account has been ${acctStatus}.`,
                    account_status: acctStatus,
                });
            }
            // Password accounts may also sign in with Google once email ownership is proven
            // (Google credential + OTP). Same user row; password is retained for password login.
        }

        const otpSendLimited = await checkAuthRateLimit(`rl:otp-send:${normalizedEmail}`, 3, 600);
        if (otpSendLimited) {
            return sendError(res, 429, req, 'auth.tooManyOtpRequests');
        }

        const otpCode = crypto.randomInt(100000, 1000000).toString();
        await clearRateLimit(`rl:otp-guess:${normalizedEmail}`);
        await prisma.email_verification.upsert({
            where: { email: normalizedEmail },
            update: {
                code: hashOtp(otpCode),
                created_at: new Date(),
                expires_at: otpExpiryDate(),
                used_at: null,
            },
            create: {
                email: normalizedEmail,
                code: hashOtp(otpCode),
                expires_at: otpExpiryDate(),
            },
        });

        mailerEvents.emit('send_email', {
            templateName: 'otp',
            variables: { otp_code: otpCode },
            to: normalizedEmail,
            subjectKey: 'emails.subjects.otp',
            lng: emailLngFromRequest(req),
        });

        return res.json({
            successful: true,
            requiresOtp: true,
            email: normalizedEmail,
            message: "Verification code sent to your email.",
        });
    } catch (err) {
        console.error("Google login error:", err);
        res.status(500).json({ message: req.t('errors.internalServer') });
    }
});

router.post('/google-verify-otp', async (req, res) => {
    try {
        const { otp } = req.body || {};
        if (!otp) {
            return sendError(res, 400, req, 'auth.verificationCodeRequired');
        }

        let email, name;
        try {
            ({ email, name } = await verifyGoogleCredential(req.body?.credential));
        } catch (e) {
            if (e && e.status) return res.status(e.status).json(e.body);
            throw e;
        }

        const normalizedEmail = normalizeEmail(email);

        const verification = await prisma.email_verification.findUnique({ where: { email: normalizedEmail } });
        if (!verification) {
            return sendError(res, 400, req, 'auth.noVerificationCode');
        }

        if (isEmailOtpExpired(verification)) {
            await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });
            return sendError(res, 400, req, 'auth.verificationExpired');
        }

        if (!otpMatches(verification.code, otp)) {
            const guessLimited = await checkAuthRateLimit(`rl:otp-guess:${normalizedEmail}`, OTP_GUESS_MAX - 1, 900);
            if (guessLimited) {
                await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });
                return sendError(res, 400, req, 'auth.tooManyOtpAttempts');
            }
            return sendError(res, 400, req, 'auth.invalidVerificationCode');
        }

        await prisma.email_verification.update({
            where: { email: normalizedEmail },
            data: { used_at: new Date() },
        }).catch(() => { });

        const encryptedEmail = encryptEmailForStorage(normalizedEmail);
        let user = await findUserByEmail(normalizedEmail, USER_AUTH_SELECT);

        if (user) {
            let acctStatus;
            try {
                acctStatus = await readAccountStatus(user.user_id);
            } catch (statusErr) {
                console.error('Google verify-otp account-status check failed:', statusErr?.message || statusErr);
                return res.status(503).json({ successful: false, message: 'Authentication temporarily unavailable' });
            }
            if (isBlockedAccountStatus(acctStatus)) {
                await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });
                return res.status(403).json({
                    successful: false,
                    message: `This account has been ${acctStatus}.`,
                    account_status: acctStatus,
                });
            }
        }

        // Merge: existing password accounts log in via Google after OTP (email already verified).

        let isNewGoogleUser = false;
        // ✅ නිවැරදි කළ PRODUCTION-GRADE CODE එක (Location 2):
        if (!user) {
            isNewGoogleUser = true;
            // Atomic Provisioning: Google OAuth User + Wallets + Social Profile
            try {
                [user] = await prisma.$transaction(async (tx) => {
                    const createdUser = await tx.user.create({
                        data: {
                            email: encryptedEmail,
                            name,
                            password: null,
                            ref_code: 'STRUG-' + Math.random().toString(36).substring(7).toUpperCase(),
                            strug_wallet: {
                                create: {
                                    balance: 0.00,
                                    currency: "CAD",
                                    status: "active"
                                }
                            },
                            ads_wallet: {
                                create: {
                                    balance: 0.00,
                                    currency: "CAD",
                                    status: "active"
                                }
                            }
                        }
                    });

                    // Safe handle resolution
                    const rawHandle = createdUser.name || `user${createdUser.user_id}`;
                    const safeHandle = await resolveUniqueHandle(rawHandle, createdUser.user_id);

                    // Auto-provision Social Profile
                    await tx.social_profile.create({
                        data: {
                            user_id: createdUser.user_id,
                            handle: safeHandle,
                            display_name: createdUser.name || safeHandle,
                            accepted_terms: false,
                        }
                    });

                    if (createdUser.username !== safeHandle) {
                        await tx.user.update({
                            where: { user_id: createdUser.user_id },
                            data: { username: safeHandle },
                            select: { user_id: true, username: true }
                        });
                        createdUser.username = safeHandle;
                    }

                    return [createdUser];
                });
            } catch (dbErr) {
                // Do not leak whether the email already exists (account enumeration).
                // A P2002 here means a concurrent provisioning race on the email unique.
                if (dbErr?.code === 'P2002') {
                    return sendError(res, 500, req, 'auth.verificationFailed');
                }
                throw dbErr;
            }
        }
        recordActivity(
            user.user_id,
            isNewGoogleUser ? 'user.signup' : 'auth.login',
            {
                description: isNewGoogleUser ? 'Registered with Google' : 'Logged in with Google',
                ip: clientIp(req),
                userAgent: req.headers['user-agent'],
            },
        );

        await prisma.email_verification.delete({ where: { email: normalizedEmail } }).catch(() => { });

        const tokens = jwTokens(user.email, user.name, "user", user.user_id, null);
        const socialProfile = await prisma.social_profile.findUnique({
            where: { user_id: user.user_id },
            select: { profile_id: true, created_at: true }
        }).catch(() => null);

        const userPayload = {
            user_id: user.user_id,
            name: user.name,
            email: normalizedEmail,
            username: user.username ?? null,
            ref_code: user.ref_code,
            language: user.language ?? 'en',
            currency: user.currency ?? null,
            country: user.country ?? null,
            is_creator: user.is_creator ?? false,
            is_seller: user.is_seller ?? false,
            has_password: Boolean(user.password),
            has_seen_welcome: await readWelcomeSeen(user.user_id),
            ...(socialProfile ? { profile_id: socialProfile.profile_id, social_created_at: socialProfile.created_at } : {}),
        };

        await issueUserRefreshSession(res, tokens, user.user_id);
        const handoff = await sessionHandoffFields(tokens, user.user_id);
        return res.json({
            successful: true,
            accessToken: tokens.accessToken,
            ...handoff,
            user: userPayload,
        });
    } catch (err) {
        console.error("Google verify-otp error:", err);
        res.status(500).json({ message: req.t('errors.internalServer') });
    }
});

router.post('/admin-login', async (req, res) => {
    const { id, password } = req.body;
    if (typeof id !== 'string' || !id.trim() || typeof password !== 'string' || !password) {
        return sendError(res, 400, req, 'auth.loginFieldsRequired');
    }
    const emailKey = `rl:admin-login:${normalizeEmail(id) || id.trim().toLowerCase()}`;
    const ipKey = `rl:admin-login:ip:${clientIp(req) || 'unknown'}`;
    try {
        if (await isAuthRateLimited(emailKey, 5) || await isAuthRateLimited(ipKey, 30)) {
            return sendError(res, 429, req, 'auth.accountLocked');
        }

        const admin = await prisma.admin.findUnique({
            where: { email: id },
            omit: { password: false }
        });

        if (!admin || !admin.password) {
            await checkAuthRateLimit(emailKey, 5, 900);
            await checkAuthRateLimit(ipKey, 30, 900);
            return res.status(401).json({ successful: false, message: req.t('auth.invalidCredentials') });
        }

        const validPassword = await bcrypt.compare(password, admin.password);
        if (!validPassword) {
            await checkAuthRateLimit(emailKey, 5, 900);
            await checkAuthRateLimit(ipKey, 30, 900);
            return res.status(401).json({ successful: false, message: req.t('auth.invalidCredentials') });
        }

        const tokens = jwTokens(admin.email, admin.name, 'admin', admin.aid, null);

        // Access-only admin sessions: do not issue an unused admin refresh cookie (#1270).
        clearAdminRefreshCookies(res);

        return res.json({
            successful: true,
            message: req.t('auth.loginSuccessful'),
            accessToken: tokens.accessToken,
            user: {
                email: admin.email,
                name: admin.name,
            },
        });
    } catch (err) {
        console.error("Admin login error:", err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

router.post('/refresh', async (req, res) => {
    try {
        const refreshToken = readUserRefreshToken(req);

        if (!refreshToken) {
            return res.status(401).json({
                successful: false,
                message: req.t('auth.noRefreshToken'),
            });
        }

        let payload;
        try {
            payload = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_KEY);
        } catch {
            return res.status(403).json({
                successful: false,
                message: req.t('auth.invalidRefreshToken'),
            });
        }

        // Admin/board refresh tokens must never mint app-user access via this endpoint.
        if (payload?.permission === 'admin' || payload?.permission === 'board') {
            clearUserRefreshCookies(res);
            return res.status(403).json({
                successful: false,
                message: req.t('auth.invalidRefreshToken'),
            });
        }

        const userId = payload?.user_id;
        if (!userId) {
            return res.status(400).json({
                successful: false,
                message: req.t('auth.invalidRefreshTokenPayload'),
            });
        }

        let user;
        try {
            user = await prisma.user.findUnique({
                where: { user_id: userId },
                select: {
                    user_id: true,
                    name: true,
                    email: true,
                    username: true,
                    password: true,
                    ref_code: true,
                    language: true,
                    currency: true,
                    country: true,
                    is_creator: true,
                    is_seller: true,
                    ...ACCOUNT_SESSION_SELECT,
                },
            });
        } catch (dbErr) {
            console.error('Refresh account lookup failed:', dbErr?.message || dbErr);
            return res.status(503).json({
                successful: false,
                message: 'Authentication temporarily unavailable',
            });
        }

        const gate = evaluateAccountSession(user, payload.iat);
        if (!gate.ok) {
            clearUserRefreshCookies(res);
            await clearUserRefreshJti(userId);
            return res.status(gate.status).json(
                typeof gate.body === 'string'
                    ? { successful: false, message: gate.body }
                    : { successful: false, ...gate.body },
            );
        }

        const jtiOk = await isCurrentUserRefreshJti(userId, payload.jti);
        if (!jtiOk) {
            clearUserRefreshCookies(res);
            await clearUserRefreshJti(userId);
            return res.status(403).json({
                successful: false,
                message: req.t('auth.invalidRefreshToken'),
            });
        }

        const socialProfile = await prisma.social_profile.findUnique({
            where: { user_id: user.user_id },
            select: { profile_id: true, created_at: true },
        }).catch(() => null);
        const hasSeenWelcome = await readWelcomeSeen(user.user_id);
        const driverProfile = await prisma.driver_profile.findFirst({
            where: { user_id: user.user_id },
            select: { driver_profile_id: true, driver_courier_profile: { select: { driver_profile_id: true } } },
        }).catch(() => null);

        const tokens = jwTokens(user.email, user.name, 'user', user.user_id, null);
        await issueUserRefreshSession(res, tokens, user.user_id);

        return res.json({
            successful: true,
            message: req.t('auth.accessTokenRefreshed'),
            accessToken: tokens.accessToken,
            user: {
                user_id: user.user_id,
                name: user.name,
                email: user.email ? decrypt(user.email) : null,
                username: user.username ?? null,
                ref_code: user.ref_code,
                language: user.language ?? 'en',
                currency: user.currency ?? null,
                country: user.country ?? null,
                is_creator: user.is_creator ?? false,
                is_seller: user.is_seller ?? false,
                is_driver: Boolean(driverProfile),
                is_courier: Boolean(driverProfile?.driver_courier_profile),
                has_password: Boolean(user.password),
                has_seen_welcome: hasSeenWelcome,
                ...(socialProfile ? { profile_id: socialProfile.profile_id, social_created_at: socialProfile.created_at } : {}),
            },
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            successful: false,
            message: req.t('errors.internalServer'),
        });
    }
});

router.post('/welcome-seen', authenticateToken, async (req, res) => {
    try {
        await prisma.user.update({ where: { user_id: req.user.user_id }, data: { has_seen_welcome: true } });
    } catch (err) {
        // Previously this swallowed the error and still answered `successful: true`. The client
        // is fire-and-forget and sets its per-device localStorage flag either way, so a failed
        // write was invisible: the device it happened on looked fine and only a NEW device
        // revealed that the account was still flagged as never-onboarded (#416). Report the
        // failure so the client can retry instead of silently losing the flag.
        console.error('welcome-seen update failed:', err?.message || err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
    return res.json({ successful: true });
});

/** Removed: must not mint a 14d refresh from a short-lived access JWT (#1272). */
router.post('/session/refresh-cookie', authenticateToken, async (_req, res) => {
    return res.status(410).json({
        successful: false,
        message: 'This endpoint has been removed. Sign in again to obtain a refresh session.',
    });
});

/**
 * Claim a one-time session_handoff from a proxied login/register (strug.ca).
 * Sets the httpOnly refresh cookie on this API host so silent restore works after tab close.
 */
router.post('/session/claim-handoff', async (req, res) => {
    try {
        const ip = clientIp(req) || 'unknown';
        const limited = await checkAuthRateLimit(`rl:handoff-claim:${ip}`, 30, 900);
        if (limited) {
            return sendError(res, 429, req, 'auth.tooManyRequests');
        }

        const handoff = req.body?.handoff ?? req.body?.session_handoff;
        if (!handoff || typeof handoff !== 'string') {
            return sendError(res, 400, req, 'auth.registerFieldsRequired');
        }

        const row = await consumeSessionHandoff(handoff);
        if (!row) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid or expired session handoff. Sign in again.',
            });
        }

        setRefreshCookie(res, row.refreshToken);
        return res.json({ successful: true, message: 'Session established.' });
    } catch (err) {
        console.error('claim-handoff error:', err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

/** Invalidate every other device's refresh/access JWTs; keep this device signed in. */
router.post('/revoke-other-sessions', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user?.user_id;
        if (!user_id) return sendError(res, 401, req, 'auth.unauthorized');

        const user = await prisma.user.findUnique({
            where: { user_id },
            select: { user_id: true, email: true, name: true },
        });
        if (!user) return sendError(res, 404, req, 'user.notFound');

        await prisma.user.update({
            where: { user_id },
            data: { sessions_invalidated_at: new Date() },
        });

        const tokens = jwTokens(user.email, user.name, 'user', user.user_id, null);
        await issueUserRefreshSession(res, tokens, user.user_id);
        recordActivity(user_id, 'auth.sessions_revoked', {
            description: 'User revoked other sessions',
            ip: clientIp(req),
            userAgent: req.headers['user-agent'],
        });

        return res.json({
            successful: true,
            accessToken: tokens.accessToken,
            message: 'Other sessions have been signed out.',
        });
    } catch (err) {
        console.error('Revoke other sessions error:', err);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

router.patch('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword)
            return sendError(res, 400, req, 'auth.passwordFieldsRequired');

        const pwdErrors = validatePasswordStrength(newPassword);
        if (pwdErrors.length > 0) {
            return sendError(res, 400, req, 'auth.passwordRequirements', { requirements: pwdErrors.join(', ') });
        }

        const user = await prisma.user.findUnique({ where: { user_id: req.user.user_id }, select: USER_AUTH_SELECT });
        if (!user) return sendError(res, 404, req, 'user.notFound');

        if (!user.password) {
            return res.status(400).json({
                successful: false,
                message: 'This account uses Google sign-in and has no password to change.',
            });
        }

        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) return res.status(400).json({ successful: false, message: 'Current password is incorrect' });

        const hashed = await bcrypt.hash(newPassword, 10);
        // Invalidate every other device's tokens; re-issue for this device so the user stays signed in.
        await prisma.user.update({
            where: { user_id: req.user.user_id },
            data: {
                password: hashed,
                password_changed_at: new Date(),
                sessions_invalidated_at: new Date(),
            },
        });

        const tokens = jwTokens(user.email, user.name, 'user', user.user_id, null);
        await issueUserRefreshSession(res, tokens, user.user_id);

        notify(req.app.get('io'), {
            userId: req.user.user_id,
            vertical: 'system',
            type: 'security.password_changed',
            title: 'Your password was changed',
            body: "If you didn't do this, contact support immediately.",
            urgency: 'actionable',
            entityType: 'user',
            entityId: req.user.user_id,
            actionUrl: 'settings',
        });

        mailerEvents.emit('send_email', {
            templateName: 'password-change-success',
            variables: {},
            to: decrypt(user.email),
            subjectKey: 'emails.password_changed.subject',
            user,
        });

        return res.json({
            successful: true,
            message: 'Password changed successfully',
            accessToken: tokens.accessToken,
        });
    } catch (err) {
        console.error('Change password error:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.post('/create-test-user', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ message: 'Not found' });
    }
    const testSecret = process.env.TEST_USER_SECRET;
    if (!testSecret || req.headers['x-test-user-secret'] !== testSecret) {
        return res.status(404).json({ message: 'Not found' });
    }
    try {
        const { email, name, password, is_driver = false, is_courier = false, is_seller = false } = req.body;
        if (!email || !name || !password) return res.status(400).json({ successful: false, message: 'email, name, password required' });

        const encryptedEmail = encryptEmailForStorage(email);
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = await prisma.user.upsert({
            where: { email: encryptedEmail },
            update: { is_seller },
            create: {
                email: encryptedEmail,
                name,
                password: hashedPassword,
                is_seller,
                ref_code: 'TEST-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
            },
        });

        const tokens = jwTokens(encryptedEmail, name, 'user', newUser.user_id, null);
        return res.json({
            successful: true,
            token: tokens.accessToken,
            user: { user_id: newUser.user_id, name, email: normalizeEmail(email), is_seller, is_driver, is_courier },
        });
    } catch (err) {
        console.error('create-test-user error:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.delete('/delete_token', (req, res) => {
    try {
        // Clear BOTH scopes and both cookie names. A cookie is only deleted by a matching
        // domain attribute, so clearing host-only alone would leave any legacy `.strug.ca`
        // cookie alive — logging the user back in on their next tab despite having logged out (#414).
        clearUserRefreshCookies(res);
        clearAdminRefreshCookies(res);
        return res.status(200).json({ message: req.t('auth.refreshTokenDeleted') });
    } catch (error) {
        console.error("Logout error:", error);
        return sendError(res, 500, req, 'errors.internalServer');
    }
});

export default router;
