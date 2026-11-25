import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import socAuthRouter from '../../routes/soc-auth-routes.js';

const app = express();
app.use(express.json());
app.use('/soc-auth', socAuthRouter);

const inMemoryRedisStore = new Map();

vi.mock('../../utils/prisma-client.js', () => {
    return {
        default: {
            user: {
                findFirst: vi.fn(),
                findUnique: vi.fn(),
            },
            user_activity_event: {
                create: vi.fn().mockResolvedValue({ event_id: 1 }),
            },
            soc_audit_log: {
                create: vi.fn().mockResolvedValue({ audit_id: 1n }),
                findFirst: vi.fn().mockResolvedValue(null),
            },
        },
    };
});

vi.mock('../../utils/redis-client.js', () => {
    return {
        isRedisReady: vi.fn().mockReturnValue(true),
        default: {
            incr: vi.fn(async (key) => {
                const current = parseInt(inMemoryRedisStore.get(key) || 0, 10);
                const nextVal = current + 1;
                inMemoryRedisStore.set(key, nextVal);
                return nextVal;
            }),
            set: vi.fn(async (key, val) => {
                inMemoryRedisStore.set(key, val);
                return 'OK';
            }),
            get: vi.fn(async (key) => inMemoryRedisStore.get(key) || null),
            del: vi.fn(async (key) => {
                inMemoryRedisStore.delete(key);
                return 1;
            }),
            expire: vi.fn().mockResolvedValue(true),
        },
    };
});

vi.mock('../../utils/mailer-event.js', () => {
    return {
        default: {
            emit: vi.fn(),
        },
    };
});

describe('SOC Authentication Engine [Unit Tests]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        inMemoryRedisStore.clear();
        process.env.SOC_CHALLENGE_SECRET = 'test_challenge_secret_key_64_bytes_long_production_spec';
        process.env.SOC_SESSION_SECRET = 'test_session_secret_key_64_bytes_long_production_spec';
    });

    it('Phase-1: Rejects unprivileged registered users with HTTP 401', async () => {
        const prisma = (await import('../../utils/prisma-client.js')).default;
        const passwordHash = await bcrypt.hash('ValidMasterPassword123!', 10);

        prisma.user.findFirst.mockResolvedValue({
            user_id: 42,
            name: 'Unprivileged Operator',
            email: 'user@strug.ca',
            password: passwordHash,
            security_admin: false,
            account_status: 'active',
        });

        const res = await request(app)
            .post('/soc-auth/login-phase1')
            .send({ email: 'user@strug.ca', password: 'ValidMasterPassword123!' });

        expect(res.status).toBe(401);
        expect(res.body.successful).toBe(false);
        expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });

    it('Phase-1: Issues challenge ticket and sends OTP for authorized security admins', async () => {
        const prisma = (await import('../../utils/prisma-client.js')).default;
        const mailer = (await import('../../utils/mailer-event.js')).default;
        const passwordHash = await bcrypt.hash('ValidMasterPassword123!', 10);

        prisma.user.findFirst.mockResolvedValue({
            user_id: 1,
            name: 'Root Operator',
            email: 'admin@strug.ca',
            password: passwordHash,
            security_admin: true,
            account_status: 'active',
        });

        const res = await request(app)
            .post('/soc-auth/login-phase1')
            .send({ email: 'admin@strug.ca', password: 'ValidMasterPassword123!' });

        expect(res.status).toBe(200);
        expect(res.body.successful).toBe(true);
        expect(res.body.challengeTicket).toBeDefined();
        expect(mailer.emit).toHaveBeenCalledWith('send_email', expect.any(Object));
    });

    it('Phase-2: Burns OTP and rejects after 3 consecutive invalid attempts', async () => {
        const redis = (await import('../../utils/redis-client.js')).default;
        const challengeSecret = process.env.SOC_CHALLENGE_SECRET;
        const challengeTicket = jwt.sign(
            { user_id: 1, purpose: 'soc_2fa_challenge', ip_hash: 'mock_ip_hash' },
            challengeSecret,
            { expiresIn: 300 }
        );

        const validOtpHex = crypto.createHash('sha256').update('123456').digest('hex');
        await redis.set('soc:otp:1', validOtpHex);
        await redis.set('soc:otp:attempts:1', 0);

        // Attempt 1: Wrong code -> 400
        const res1 = await request(app)
            .post('/soc-auth/verify-otp')
            .send({ challengeTicket, otp: '999999' });
        expect(res1.status).toBe(400);

        // Attempt 2: Wrong code -> 400
        const res2 = await request(app)
            .post('/soc-auth/verify-otp')
            .send({ challengeTicket, otp: '888888' });
        expect(res2.status).toBe(400);

        // Attempt 3: Wrong code -> 400
        const res3 = await request(app)
            .post('/soc-auth/verify-otp')
            .send({ challengeTicket, otp: '777777' });
        expect(res3.status).toBe(400);

        // Attempt 4: Exceeded threshold -> 429
        const res4 = await request(app)
            .post('/soc-auth/verify-otp')
            .send({ challengeTicket, otp: '123456' });
        expect(res4.status).toBe(429);
        expect(res4.body.error).toBe('MAX_ATTEMPTS_EXCEEDED');
    });

    it('Phase-2: Successfully mints 30-minute session JWT on exact OTP match', async () => {
        const prisma = (await import('../../utils/prisma-client.js')).default;
        const redis = (await import('../../utils/redis-client.js')).default;

        const challengeSecret = process.env.SOC_CHALLENGE_SECRET;
        const challengeTicket = jwt.sign(
            { user_id: 99, purpose: 'soc_2fa_challenge', ip_hash: 'mock_hash' },
            challengeSecret,
            { expiresIn: 300 }
        );

        const cleanOtp = '543210';
        const cleanOtpHex = crypto.createHash('sha256').update(cleanOtp).digest('hex');
        await redis.set('soc:otp:99', cleanOtpHex);
        await redis.set('soc:otp:attempts:99', 0);

        prisma.user.findUnique.mockResolvedValue({
            user_id: 99,
            name: 'Forensic Lead',
            email: 'lead@strug.ca',
            security_admin: true,
            account_status: 'active',
        });

        const res = await request(app)
            .post('/soc-auth/verify-otp')
            .send({ challengeTicket, otp: cleanOtp });

        expect(res.status).toBe(200);
        expect(res.body.successful).toBe(true);
        expect(res.body.sessionToken).toBeDefined();
        expect(res.body.sessionId).toBeDefined();
        expect(res.body.expiresIn).toBe(1800);

        const remainingOtp = await redis.get('soc:otp:99');
        expect(remainingOtp).toBeNull();
    });
});
