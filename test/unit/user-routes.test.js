import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import router from '../../routes/user-routes.js';
import prisma from '../../utils/prisma-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    user_address: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn()
    }
  }
}));

vi.mock('../../utils/crypto.js', () => ({
  decrypt: (val) => val === 'encrypted_email@example.com' ? 'decrypted_email@example.com' : val,
  encryptSearch: (val) => `encrypted_${val}`,
  encryptEmailForStorage: (val) => `enc:${val}`,
  normalizeEmail: (val) => String(val || '').trim().toLowerCase(),
}));

vi.mock('../../utils/password-policy.js', async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = req._testUser || { user_id: 1, name: 'Owner User' };
    next();
  }
}));

const app = express();
app.use(express.json());
app.use('/user', router);

describe('User Profile & Address Sync API Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should scrub PII and sensitive location data when requested by a non-owner (IDOR Guard)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      user_id: 99,
      name: 'Other User',
      email: 'encrypted_email@example.com',
      ref_code: 'OTHER-REF',
      saved_address: '123 Location St, Colombo, LK',
      saved_lat: 6.9271,
      saved_long: 79.8612,
      currency: 'CAD',
      country: 'LK',
      city: 'Colombo',
      language: 'en'
    });

    const res = await request(app).get('/user/99');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Other User');
    expect(res.body.email).toBeUndefined();
    expect(res.body.ref_code).toBeUndefined();
    expect(res.body.saved_address).toBeUndefined();
    expect(res.body.saved_lat).toBeUndefined();
    expect(res.body.saved_long).toBeUndefined();
  });

  it('should return decrypted email and full profile to the account owner', async () => {
    prisma.user.findUnique.mockResolvedValue({
      user_id: 1,
      name: 'Owner User',
      email: 'encrypted_email@example.com',
      ref_code: 'OWNER-REF',
      saved_address: '456 Safe St, Colombo, LK',
      saved_lat: 6.9271,
      saved_long: 79.8612,
      currency: 'CAD',
      country: 'LK',
      city: 'Colombo',
      language: 'en'
    });

    const res = await request(app).get('/user/1');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Owner User');
    expect(res.body.email).toBe('decrypted_email@example.com');
    expect(res.body.ref_code).toBe('OWNER-REF');
    expect(res.body.saved_address).toBe('456 Safe St, Colombo, LK');
  });

  it('should promote most recent remaining address to default on deletion of default address', async () => {
    prisma.user_address.findFirst.mockResolvedValue({
      address_id: 101,
      user_id: 1,
      is_default: true
    });
    prisma.user_address.delete.mockResolvedValue({ address_id: 101 });
    prisma.user_address.findFirst.mockResolvedValueOnce({
      address_id: 101,
      user_id: 1,
      is_default: true
    }).mockResolvedValueOnce({
      address_id: 102,
      user_id: 1,
      street: 'New Default St',
      city: 'Colombo',
      country: 'LK',
      lat: 6.9,
      lng: 79.8,
      is_default: false
    });

    prisma.user_address.update.mockResolvedValue({ address_id: 102, is_default: true });
    prisma.user.update.mockResolvedValue({ user_id: 1 });

    const res = await request(app).delete('/user/addresses/101');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(prisma.user_address.delete).toHaveBeenCalledWith({ where: { address_id: 101 } });
    expect(prisma.user_address.update).toHaveBeenCalledWith({
      where: { address_id: 102 },
      data: { is_default: true }
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { user_id: 1 },
      data: { saved_address: 'New Default St, Colombo, LK', saved_lat: 6.9, saved_long: 79.8 }
    });
  });

  it('does not persist a client-supplied password on PUT /user/:id', async () => {
    prisma.user.findUnique.mockResolvedValue({
      name: 'Owner User',
      email: 'encrypted_email@example.com',
      currency: 'CAD',
      country: 'CA',
      city: 'Toronto',
      ref_code: 'OWNER-REF',
      language: 'en',
    });
    prisma.user.update.mockResolvedValue({
      user_id: 1,
      name: 'Owner User',
      email: 'encrypted_email@example.com',
      currency: 'CAD',
      country: 'CA',
      city: 'Toronto',
      ref_code: 'OWNER-REF',
      language: 'en',
    });

    const res = await request(app).put('/user/1').send({
      name: 'Owner User',
      password: 'plaintext-hack',
    });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalled();
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.password).toBeUndefined();
  });

  it('ignores client-supplied email on PUT /user/:id (#1267)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      name: 'Owner User',
      email: 'encrypted_email@example.com',
      currency: 'CAD',
      country: 'CA',
      city: 'Toronto',
      ref_code: 'OWNER-REF',
      language: 'en',
    });
    prisma.user.update.mockResolvedValue({
      user_id: 1,
      name: 'Owner User',
      email: 'encrypted_email@example.com',
      currency: 'CAD',
      country: 'CA',
      city: 'Toronto',
      ref_code: 'OWNER-REF',
      language: 'en',
      document_verification_status: 'unsubmitted',
    });

    const res = await request(app).put('/user/1').send({
      email: 'attacker@evil.com',
      name: 'Owner User',
    });

    expect(res.status).toBe(200);
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.email).toBe('encrypted_email@example.com');
  });

  it('admin POST /user hashes password and encrypts email (#1268)', async () => {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      req._testUser = { user_id: 1, permission: 'admin' };
      next();
    });
    expressApp.use('/user', router);

    prisma.user.create.mockImplementation(async ({ data }) => ({
      user_id: 55,
      name: data.name,
      email: data.email,
      currency: data.currency,
      country: data.country,
      city: data.city,
      ref_code: data.ref_code,
      language: 'en',
    }));

    const plainPassword = ['Secure', 'Pass', '1'].join('');
    const res = await request(expressApp).post('/user').send({
      name: 'New User',
      email: 'New.User@Example.com',
      password: plainPassword,
      currency: 'CAD',
    });

    expect(res.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalled();
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.email).toBe('enc:new.user@example.com');
    expect(data.password).not.toBe(plainPassword);
    expect(String(data.password).length).toBeGreaterThan(20);
    expect(res.body.email).toBe('new.user@example.com');
  });
});
