import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { decrypt, encryptSearch, encryptEmailForStorage, normalizeEmail } from '../utils/crypto.js';
import { checkRateLimit } from '../utils/rate-limiter.js';
import { sendError } from '../utils/api-i18n.js';
import { uploadVideoStream } from '../utils/azure-storage.js';
import { ensureStoreProfile } from '../utils/shop-store-profile.js';
import bcrypt from 'bcrypt';
import { validatePasswordStrength } from '../utils/password-policy.js';

const router = express.Router();

// In-memory upload for store storefront branding (logo / cover) → blob.
const storeBrandingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const DOCUMENT_VERIFICATION_STATUSES = new Set(['unsubmitted', 'pending', 'verified', 'rejected']);
const DOCUMENT_TYPES = new Set(['passport', 'drivers_license', 'national_id', 'residence_card']);
const documentVerificationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) return cb(new Error('Unsupported document type. Use PDF, JPEG, PNG or WebP.'));
    return cb(null, true);
  },
});

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

function documentVerificationSelect(includePrivate = false) {
  return {
    user_id: true,
    document_verification_status: true,
    document_verification_type: true,
    document_verification_submitted_at: true,
    document_verified_at: true,
    document_verification_rejected_at: true,
    document_verification_reviewed_by: true,
    document_verification_rejection_reason: true,
    document_verification_document_name: true,
    ...(includePrivate ? { document_verification_document_url: true } : {}),
  };
}

function publicDocumentVerification(user) {
  const status = DOCUMENT_VERIFICATION_STATUSES.has(user?.document_verification_status)
    ? user.document_verification_status
    : 'unsubmitted';
  return {
    status,
    verified: status === 'verified',
    type: user?.document_verification_type || null,
    submitted_at: user?.document_verification_submitted_at || null,
    verified_at: user?.document_verified_at || null,
    rejected_at: user?.document_verification_rejected_at || null,
    rejection_reason: user?.document_verification_rejection_reason || null,
    document_name: user?.document_verification_document_name || null,
  };
}

function userDocumentVerificationFields() {
  return {
    document_verification_status: true,
    document_verification_type: true,
    document_verification_submitted_at: true,
    document_verified_at: true,
    document_verification_rejected_at: true,
    document_verification_rejection_reason: true,
  };
}

async function syncDefaultToUser(user_id, addr) {
  if (!addr) return;
  const fullStr = [addr.street, addr.city, addr.country].filter(Boolean).join(', ');
  await prisma.user.update({
    where: { user_id },
    data: { saved_address: fullStr, saved_lat: addr.lat ?? undefined, saved_long: addr.lng ?? undefined },
  }).catch(() => {});
}

router.get('/addresses', authenticateToken, async (req, res) => {
  try {
    const addresses = await prisma.user_address.findMany({
      where: { user_id: req.user.user_id },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
    return res.json({ successful: true, data: addresses });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.post('/addresses', authenticateToken, async (req, res) => {
  try {
    const { label, street, city, country, lat, lng } = req.body ?? {};
    if (!label?.toString().trim() || !street?.toString().trim()) {
      return sendError(res, 400, req, 'user.labelStreetRequired');
    }
    const user_id = req.user.user_id;
    const existingCount = await prisma.user_address.count({ where: { user_id } });
    const makeDefault = req.body?.is_default === true || existingCount === 0;
    if (makeDefault) {
      await prisma.user_address.updateMany({ where: { user_id }, data: { is_default: false } });
    }
    const created = await prisma.user_address.create({
      data: {
        user_id,
        label: label.toString().trim().slice(0, 60),
        street: street.toString().trim().slice(0, 255),
        city: city?.toString().trim().slice(0, 120) || null,
        country: country?.toString().trim().slice(0, 120) || null,
        lat: lat != null ? Number(lat) : null,
        lng: lng != null ? Number(lng) : null,
        is_default: makeDefault,
      },
    });
    if (makeDefault) await syncDefaultToUser(user_id, created);
    return res.status(201).json({ successful: true, data: created });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.patch('/addresses/:address_id/default', authenticateToken, async (req, res) => {
  try {
    const address_id = Number(req.params.address_id);
    const user_id = req.user.user_id;
    const addr = await prisma.user_address.findFirst({ where: { address_id, user_id } });
    if (!addr) return sendError(res, 404, req, 'user.addressNotFound');
    await prisma.user_address.updateMany({ where: { user_id }, data: { is_default: false } });
    const updated = await prisma.user_address.update({ where: { address_id }, data: { is_default: true } });
    await syncDefaultToUser(user_id, updated);
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.delete('/addresses/:address_id', authenticateToken, async (req, res) => {
  try {
    const address_id = Number(req.params.address_id);
    const user_id = req.user.user_id;
    const addr = await prisma.user_address.findFirst({ where: { address_id, user_id } });
    if (!addr) return sendError(res, 404, req, 'user.addressNotFound');
    await prisma.user_address.delete({ where: { address_id } });
    if (addr.is_default) {
      const next = await prisma.user_address.findFirst({ where: { user_id }, orderBy: { created_at: 'desc' } });
      if (next) {
        await prisma.user_address.update({ where: { address_id: next.address_id }, data: { is_default: true } });
        await syncDefaultToUser(user_id, next);
      }
    }
    return res.json({ successful: true });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (!admin) return sendError(res, 403, req, 'errors.adminRequired');

    const users = await prisma.user.findMany({
      orderBy: { user_id: 'desc' },
      select: {
        user_id: true,
        name: true,
        email: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
        ...userDocumentVerificationFields(),
      },
    });

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: req.t('errors.fetchFailed', { resource: 'users' }) });
  }
});

router.get('/email/:email', authenticateToken, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const requesterId = req.user?.user_id ?? req.user?.id ?? 'anonymous';
    const ip = req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown';
    const limited = await checkRateLimit(`user-email-lookup:${requesterId}:${ip}`, 20, 60);
    if (limited) {
      return res.status(429).json({ error: 'Too many lookup attempts. Please try again later.' });
    }

    const encryptedEmail = encryptSearch(email);
    const user = await prisma.user.findUnique({
      where: { email: encryptedEmail },
      select: {
        user_id: true,
        name: true,
        username: true,
        social_profiles: {
          select: { profile_id: true, is_private: true },
        },
      },
    });

    if (!user?.social_profiles || user.social_profiles.is_private) {
      return res.status(404).json({ error: 'No matching discoverable user found' });
    }

    const { social_profiles, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user by email' });
  }
});

router.get('/me/document-verification', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: documentVerificationSelect(false),
    });
    if (!user) return sendError(res, 404, req, 'user.notFound');
    return res.json({ successful: true, data: publicDocumentVerification(user) });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.post('/me/document-verification', authenticateToken, documentVerificationUpload.single('document'), async (req, res) => {
  try {
    const type = String(req.body?.document_type || '').trim().toLowerCase();
    if (!DOCUMENT_TYPES.has(type)) {
      return res.status(400).json({ successful: false, message: 'Select a valid document type.' });
    }
    if (!req.file) {
      return res.status(400).json({ successful: false, message: 'Upload a government ID document.' });
    }

    const current = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: documentVerificationSelect(false),
    });
    if (!current) return sendError(res, 404, req, 'user.notFound');

    const extension = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const blobName = `users/${req.user.user_id}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const documentUrl = await uploadVideoStream(
      process.env.AZURE_IDENTITY_DOCUMENT_CONTAINER || 'identity-documents',
      blobName,
      req.file.buffer,
      req.file.mimetype,
    );

    const updated = await prisma.user.update({
      where: { user_id: req.user.user_id },
      data: {
        document_verification_status: 'pending',
        document_verification_type: type,
        document_verification_submitted_at: new Date(),
        document_verified_at: null,
        document_verification_rejected_at: null,
        document_verification_reviewed_by: null,
        document_verification_rejection_reason: null,
        document_verification_document_url: documentUrl,
        document_verification_document_name: String(req.file.originalname || 'identity-document').slice(0, 255),
      },
      select: documentVerificationSelect(false),
    });
    return res.status(201).json({ successful: true, data: publicDocumentVerification(updated) });
  } catch (err) {
    console.error(err);
    const message = /Unsupported document type/i.test(err?.message || '')
      ? err.message
      : 'Failed to submit document verification.';
    return res.status(/Unsupported document type/i.test(message) ? 400 : 500).json({ successful: false, message });
  }
});

// Compute age (whole years) from a Date, UTC, accounting for month/day.
// Mirrors ageFromBirthdate in dating-routes.js so the age gate is consistent.
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

router.patch('/:user_id/document-verification', authenticateToken, async (req, res) => {
  try {
    if (!isAdmin(req)) return sendError(res, 403, req, 'errors.adminRequired');
    const user_id = Number(req.params.user_id);
    if (Number.isNaN(user_id)) return sendError(res, 400, req, 'errors.invalidId', { field: 'user_id' });
    let status = String(req.body?.status || '').trim().toLowerCase();
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ successful: false, message: 'Status must be verified or rejected.' });
    }
    let reason = String(req.body?.reason || '').trim().slice(0, 1000) || null;

    // DOB read off the government ID by the reviewer (authoritative, machine-enforced).
    let idDob = null;
    if (status === 'verified') {
      const rawDob = req.body?.id_dob;
      idDob = rawDob ? new Date(rawDob) : null;
      if (!idDob || Number.isNaN(idDob.getTime())) {
        return res.status(400).json({ successful: false, message: 'The date of birth from the ID is required to verify.' });
      }
      const age = ageFromDob(idDob);
      if (age == null || age < 18) {
        // Machine-enforced age gate: an admin cannot verify a minor. Auto-reject overrides verify.
        status = 'rejected';
        idDob = null;
        reason = 'Government ID indicates the applicant is under 18; cannot verify for age-restricted features.';
      }
    }

    if (status === 'rejected' && !reason) {
      return res.status(400).json({ successful: false, message: 'Rejection reason is required.' });
    }

    const updated = await prisma.user.update({
      where: { user_id },
      data: status === 'verified'
        ? {
            document_verification_status: 'verified',
            document_verified_at: new Date(),
            document_verification_rejected_at: null,
            document_verification_rejection_reason: null,
            document_verification_reviewed_by: req.user.user_id,
            document_verification_dob: idDob,
          }
        : {
            document_verification_status: 'rejected',
            document_verified_at: null,
            document_verification_rejected_at: new Date(),
            document_verification_rejection_reason: reason,
            document_verification_reviewed_by: req.user.user_id,
          },
      select: documentVerificationSelect(isAdmin(req)),
    });

    let dobMismatch = false;
    if (status === 'verified') {
      await prisma.social_profile.updateMany({
        where: { user_id },
        data: { is_verified: true, verification_type: 'INDIVIDUAL' },
      }).catch(() => {});

      // Sync the dating gate to the VERIFIED DOB (authoritative), and flag mismatch vs self-report.
      const datingProfile = await prisma.dating_profile.findFirst({ where: { user_id } }).catch(() => null);
      if (datingProfile) {
        const prior = datingProfile.birthdate ? new Date(datingProfile.birthdate) : null;
        if (prior && !Number.isNaN(prior.getTime())) {
          const diffMs = Math.abs(prior.getTime() - idDob.getTime());
          if (diffMs > 24 * 60 * 60 * 1000) {
            dobMismatch = true;
            console.warn('[age-verify] DOB mismatch for user', user_id);
          }
        }
        await prisma.dating_profile.updateMany({
          where: { user_id },
          data: { birthdate: idDob, age_verified_at: new Date() },
        }).catch(() => {});
      }
    }

    const response = { successful: true, data: publicDocumentVerification(updated) };
    if (dobMismatch) response.dob_mismatch = true;
    return res.json(response);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.get('/:user_id', authenticateToken, async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);

    if (Number.isNaN(user_id)) {
      return sendError(res, 400, req, 'errors.invalidId', { field: 'user_id' });
    }

    const user = await prisma.user.findUnique({
      where: { user_id },
      select: {
        user_id: true,
        name: true,
        email: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
        saved_address: true,
        saved_lat: true,
        saved_long: true,
        is_seller: true,
        is_creator: true,
        ...userDocumentVerificationFields(),
      },
    });

    if (!user) {
      return sendError(res, 404, req, 'user.notFound');
    }

    const isOwn = req.user.user_id === user_id;
    const response = { ...user };
    response.document_verified = user.document_verification_status === 'verified';
    if (isOwn) {
      response.email = decrypt(user.email);
    } else {
      delete response.email;
      delete response.ref_code;
      delete response.saved_address;
      delete response.saved_lat;
      delete response.saved_long;
      delete response.document_verification_rejection_reason;
    }

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: req.t('errors.fetchFailed', { resource: 'user' }) });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (!admin) return sendError(res, 403, req, 'errors.adminRequired');

    const { name, email, password, currency, country, city, ref_code } = req.body;
    if (!email || !password) {
      return sendError(res, 400, req, 'auth.loginFieldsRequired');
    }

    const pwdErrors = validatePasswordStrength(password);
    if (pwdErrors.length > 0) {
      return sendError(res, 400, req, 'auth.passwordRequirements', { requirements: pwdErrors.join(', ') });
    }

    const normalizedEmail = normalizeEmail(email);
    const encryptedEmail = encryptEmailForStorage(normalizedEmail);
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email: encryptedEmail,
        password: hashedPassword,
        currency,
        country,
        city,
        ref_code,
      },
      select: {
        user_id: true,
        name: true,
        email: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
      },
    });

    res.status(201).json({
      ...user,
      email: normalizedEmail,
    });
  } catch (err) {
    console.error(err);
    if (err.code === 'P2002') {
      return sendError(res, 400, req, 'user.emailExists');
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/:user_id', authenticateToken, async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);

    if (Number.isNaN(user_id)) {
      return sendError(res, 400, req, 'errors.invalidId', { field: 'user_id' });
    }

    if (req.user.user_id !== user_id) {
      const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
      if (!admin) return sendError(res, 403, req, 'user.cannotModifyOther');
    }

    // Select only the profile fields this PUT writes. A full-row read pulls every
    // user column (including later KYC fields) and 500s if local/staging is behind.
    const existing = await prisma.user.findUnique({
      where: { user_id },
      select: {
        name: true,
        email: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
      },
    });
    if (!existing) return sendError(res, 404, req, 'user.notFound');

    const { name, currency, country, city, ref_code, language, is_seller, is_creator } = req.body;
    // Password changes go through /auth/change-password (bcrypt). Never write a
    // client-supplied password here — it would be stored in plaintext.
    // Email changes are not accepted here (#1267): must stay encrypted + verified via auth flows.

    const isAdmin = !!(await Promise.resolve(req.user.permission === 'admin' ? true : null));
    const isSelf = req.user.user_id === user_id;
    const privilegeUpdates = {};
    if (isAdmin) {
      if (is_seller !== undefined) privilegeUpdates.is_seller = is_seller;
      if (is_creator !== undefined) privilegeUpdates.is_creator = is_creator;
    } else if (isSelf) {
      if (is_seller !== undefined) privilegeUpdates.is_seller = is_seller;
      if (is_creator !== undefined) privilegeUpdates.is_creator = is_creator;
    }

    const updated = await prisma.user.update({
      where: { user_id },
      data: {
        name: name ?? existing.name,
        email: existing.email,
        currency: currency ?? existing.currency,
        country: country ?? existing.country,
        city: city ?? existing.city,
        ref_code: ref_code ?? existing.ref_code,
        language: language ?? existing.language,
        ...privilegeUpdates,
      },
      select: {
        user_id: true,
        name: true,
        email: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
        is_seller: true,
        is_creator: true,
        ...userDocumentVerificationFields(),
      },
    });

    res.json({
      ...updated,
      email: updated.email ? decrypt(updated.email) : null,
      document_verified: updated.document_verification_status === 'verified',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/:user_id', authenticateToken, async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    if (req.user.user_id !== user_id) return res.status(403).json({ error: 'Unauthorized' });
    // Soft-delete, NOT prisma.user.delete: a user is the parent of 120+ related rows
    // (orders, videos, chats, wallet…) with no ON DELETE CASCADE, so a hard delete throws a
    // foreign-key violation for any real account. Instead we mark the account deleted — the
    // login flow rejects this status (auth-routes/user-auth-route.js) so the account is
    // immediately unusable, and it stays reversible for account-recovery / GDPR purge later,
    // consistent with the platform's account_status enforcement model (#395).
    await prisma.user.update({
      where: { user_id },
      data: {
        account_status: 'deleted',
        deleted_at: new Date(),
        status_reason: 'Self-service account deletion',
        status_changed_at: new Date(),
        status_changed_by: user_id,
        // Revoke all outstanding access + refresh JWTs immediately (middleware + /auth/refresh
        // both honour sessions_invalidated_at). Without this, soft-deleted accounts stayed
        // usable until tokens expired.
        sessions_invalidated_at: new Date(),
      },
    });
    // Best-effort: drop refresh cookies on this browser so a deleted account cannot silently renew.
    try {
      res.clearCookie('strug_refresh_token', { httpOnly: true, sameSite: 'None', secure: true, path: '/' });
      res.clearCookie('refreshToken', { httpOnly: true, sameSite: 'None', secure: true, path: '/' });
    } catch { /* non-fatal */ }
    res.json({ successful: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.patch('/:user_id/activate-seller', authenticateToken, async (req, res) => {
  try {
    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (!admin) return sendError(res, 403, req, 'errors.adminRequired');

    const user_id = Number(req.params.user_id);
    const user = await prisma.user.update({
      where: { user_id },
      data: { is_seller: true },
      select: { user_id: true, name: true },
    });
    // Phase 5: seller access without a store_profile leaves Shop browse/geo empty — ensure one.
    await ensureStoreProfile(prisma, user_id, { store_name: user.name || 'My Store' });
    return res.json({ successful: true, message: 'Seller access granted' });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.patch('/address', authenticateToken, async (req, res) => {
  try {
    const { saved_address, saved_lat, saved_long } = req.body;
    if (!saved_address) return sendError(res, 400, req, 'user.savedAddressRequired');

    const updated = await prisma.user.update({
      where: { user_id: req.user.user_id },
      data: {
        saved_address,
        saved_lat: saved_lat ?? undefined,
        saved_long: saved_long ?? undefined,
      },
      select: { user_id: true, saved_address: true, saved_lat: true, saved_long: true },
    });

    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, req, 'errors.internalServer');
  }
});

router.put('/:user_id/store_profile', authenticateToken, async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    if (req.user.user_id !== user_id) return res.status(403).json({ error: 'Unauthorized' });

    const { store_name, address, bio, lat, lng, prep_time, profile_pic_url, cover_url, banner_url, is_active, is_open } = req.body;

    const errors = [];
    const data = {};
    // #348: storefront visibility toggle. A seller can hide/deactivate their whole store from the
    // public shop without deleting listings (is_active=false). They still see it in their own
    // dashboard to re-enable.
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') errors.push('is_active must be a boolean');
      else data.is_active = is_active;
    }
    if (is_open !== undefined) {
      if (typeof is_open !== 'boolean') errors.push('is_open must be a boolean');
      else data.is_open = is_open;
    }
    if (store_name !== undefined) {
      if (store_name !== null && (typeof store_name !== 'string' || store_name.length > 255)) errors.push('store_name must be a string up to 255 chars');
      else data.store_name = store_name;
    }
    if (address !== undefined) {
      if (address !== null && (typeof address !== 'string' || address.length > 1000)) errors.push('address must be a string up to 1000 chars');
      else data.address = address;
    }
    if (bio !== undefined) {
      if (bio !== null && (typeof bio !== 'string' || bio.length > 2000)) errors.push('bio must be a string up to 2000 chars');
      else data.bio = bio;
    }
    if (lat !== undefined && lat !== null) {
      const n = Number(lat);
      if (Number.isNaN(n) || n < -90 || n > 90) errors.push('lat must be a number between -90 and 90');
      else data.lat = n;
    }
    if (lng !== undefined && lng !== null) {
      const n = Number(lng);
      if (Number.isNaN(n) || n < -180 || n > 180) errors.push('lng must be a number between -180 and 180');
      else data.lng = n;
    }
    if (prep_time !== undefined) {
      if (prep_time !== null && (typeof prep_time !== 'string' || prep_time.length > 255)) errors.push('prep_time must be a string up to 255 chars');
      else data.prep_time = prep_time;
    }
    if (profile_pic_url !== undefined) {
      if (profile_pic_url === null || profile_pic_url === '') {
        data.profile_pic_url = null;
      } else if (typeof profile_pic_url !== 'string' || profile_pic_url.length > 1000 || !/^https?:\/\//i.test(profile_pic_url)) {
        errors.push('profile_pic_url must be an http(s) URL up to 1000 chars');
      } else {
        data.profile_pic_url = profile_pic_url;
      }
    }
    if (cover_url !== undefined) {
      if (cover_url === null || cover_url === '') {
        data.cover_url = null;
      } else if (typeof cover_url !== 'string' || cover_url.length > 1000 || !/^https?:\/\//i.test(cover_url)) {
        errors.push('cover_url must be an http(s) URL up to 1000 chars');
      } else {
        data.cover_url = cover_url;
      }
    }
    // Banner upload writes via POST .../branding; Remove must clear via this PUT.
    if (banner_url !== undefined) {
      if (banner_url === null || banner_url === '') {
        data.banner_url = null;
      } else if (typeof banner_url !== 'string' || banner_url.length > 1000 || !/^https?:\/\//i.test(banner_url)) {
        errors.push('banner_url must be an http(s) URL up to 1000 chars');
      } else {
        data.banner_url = banner_url;
      }
    }
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const upserted = await prisma.store_profile.upsert({
      where: { user_id },
      update: data,
      create: { user_id, ...data },
    });
    
    await prisma.user.update({ where: { user_id }, data: { is_seller: true } });

    res.json(upserted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update store profile' });
  }
});

router.get('/:user_id/store_profile', async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    const profile = await prisma.store_profile.findUnique({ where: { user_id } });
    res.json(profile || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch store profile' });
  }
});

/* UPLOAD STORE STOREFRONT BRANDING (logo | cover)
 * POST /user/:user_id/store_profile/branding  (multipart: image + type)
 * logo → profile_pic_url, cover → cover_url. Owner-only. Upserts so a brand-new store
 * can set an image before saving other fields. */
router.post('/:user_id/store_profile/branding', authenticateToken, storeBrandingUpload.single('image'), async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    if (req.user.user_id !== user_id) return res.status(403).json({ successful: false, message: 'Unauthorized' });

    const type = String(req.body.type || '').toLowerCase();
    if (!req.file || !['logo', 'cover', 'banner'].includes(type)) {
      return res.status(400).json({ successful: false, message: 'A valid image file and type ("logo" | "cover" | "banner") are required.' });
    }
    // Raster images only — SVG excluded (stored-XSS vector on the public blob container).
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(req.file.mimetype)) {
      return res.status(400).json({ successful: false, message: 'Unsupported image type. Use JPEG, PNG, WebP or GIF.' });
    }

    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const blobName = `storefront/store-${type}-${user_id}-${Date.now()}.${ext}`;
    const imageUrl = await uploadVideoStream(
      process.env.AZURE_THUMBNAIL_CONTAINER,
      blobName,
      req.file.buffer,
      req.file.mimetype,
      { access: 'blob' },
    );

    const data = type === 'logo' ? { profile_pic_url: imageUrl } : type === 'banner' ? { banner_url: imageUrl } : { cover_url: imageUrl };
    const upserted = await prisma.store_profile.upsert({
      where: { user_id },
      update: data,
      create: { user_id, ...data },
    });
    await prisma.user.update({ where: { user_id }, data: { is_seller: true } });
    res.json({ successful: true, message: `Store ${type} updated.`, url: imageUrl, data: upserted });
  } catch (err) {
    console.error('store branding upload error:', err);
    res.status(500).json({ successful: false, message: 'Failed to upload store image' });
  }
});

export default router;
