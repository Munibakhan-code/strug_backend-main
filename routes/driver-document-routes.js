import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAuthUserId, resolveDriverProfileForUser } from '../utils/ride-auth.js';
import { uploadVideoStream } from '../utils/azure-storage.js';
import { notify } from '../services/notify.js';

const router = express.Router();

const DOC_TYPES = ['license', 'insurance', 'registration'];
const DOC_TYPE_SET = new Set(DOC_TYPES);

// Same PDF-capable multer config as routes/user-routes.js's document-verification upload
// (already proven in production for dating identity documents) — compliance documents are
// often PDFs, not just photos.
const driverDocumentUpload = multer({
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

function publicDoc(row) {
  if (!row) return null;
  return {
    document_id: row.document_id,
    doc_type: row.doc_type,
    status: row.status,
    document_name: row.document_name,
    expiry_date: row.expiry_date,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    rejection_reason: row.rejection_reason,
    // document_url deliberately omitted from the driver-facing shape — it's an Azure blob URL,
    // not something the UI needs to render a status card. Admin review surface can select it
    // directly from the DB when it's built.
  };
}

/** GET /driver-profile/documents — one entry per doc type, synthesizing 'unsubmitted' for gaps. */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    const rows = await prisma.driver_document.findMany({
      where: { driver_profile_id: profile.driver_profile_id, deleted_at: null },
    });
    const byType = new Map(rows.map((r) => [r.doc_type, r]));
    const data = DOC_TYPES.map((doc_type) => publicDoc(byType.get(doc_type)) ?? { doc_type, status: 'unsubmitted' });
    return res.json({ successful: true, data });
  } catch (err) {
    console.error('[driver-document] GET / error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/** POST /driver-profile/documents/:doc_type */
router.post('/:doc_type', authenticateToken, driverDocumentUpload.single('document'), async (req, res) => {
  try {
    const doc_type = String(req.params.doc_type || '').trim().toLowerCase();
    if (!DOC_TYPE_SET.has(doc_type)) {
      return res.status(400).json({ successful: false, message: 'Invalid document type.' });
    }
    if (!req.file) {
      return res.status(400).json({ successful: false, message: 'Upload a document.' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    const extension = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const blobName = `driver-profiles/${profile.driver_profile_id}/${doc_type}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const documentUrl = await uploadVideoStream(
      process.env.AZURE_DRIVER_DOCS_CONTAINER || 'driver-documents',
      blobName,
      req.file.buffer,
      req.file.mimetype,
    );

    const expiryDate = req.body?.expiry_date ? new Date(req.body.expiry_date) : null;
    const payload = {
      status: 'pending',
      document_url: documentUrl,
      document_name: String(req.file.originalname || doc_type).slice(0, 255),
      expiry_date: expiryDate && !Number.isNaN(expiryDate.getTime()) ? expiryDate : null,
      submitted_at: new Date(),
      reviewed_at: null,
      reviewed_by: null,
      rejection_reason: null,
      deleted_at: null,
      driver_profile_id: profile.driver_profile_id,
    };

    // Partial unique index (active rows only) — find active or soft-deleted then revive.
    const existing = await prisma.driver_document.findFirst({
      where: {
        driver_profile_id: profile.driver_profile_id,
        doc_type,
      },
      orderBy: { document_id: 'desc' },
    });

    const row = existing
      ? await prisma.driver_document.update({
          where: { document_id: existing.document_id },
          data: payload,
        })
      : await prisma.driver_document.create({
          data: {
            driver_profile_id: profile.driver_profile_id,
            doc_type,
            ...payload,
          },
        });
    return res.status(201).json({ successful: true, data: publicDoc(row) });
  } catch (err) {
    console.error('[driver-document] POST /:doc_type error:', err);
    const message = /Unsupported document type/i.test(err?.message || '') ? err.message : 'Failed to submit document.';
    return res.status(/Unsupported document type/i.test(message) ? 400 : 500).json({ successful: false, message });
  }
});

/** PATCH /driver-profile/documents/admin/:document_id — approve/reject. */
router.patch('/admin/:document_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    if (!isAdmin(req)) return res.status(403).json({ successful: false, message: 'Admin access required' });
    const document_id = Number(req.params.document_id);
    if (!Number.isInteger(document_id)) return res.status(400).json({ successful: false, message: 'Invalid document id.' });

    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ successful: false, message: 'Status must be verified or rejected.' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 1000) || null;

    const existing = await prisma.driver_document.findFirst({
      where: { document_id, deleted_at: null },
      include: { driver_profile: { select: { user_id: true } } },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Document not found' });

    const reviewerId = requireAuthUserId(req, res);
    if (!reviewerId) return;

    const updated = await prisma.driver_document.update({
      where: { document_id },
      data: {
        status,
        reviewed_at: new Date(),
        reviewed_by: reviewerId,
        rejection_reason: status === 'rejected' ? reason : null,
      },
    });

    if (existing.driver_profile?.user_id) {
      notify(io, {
        userId: existing.driver_profile.user_id,
        vertical: 'rideshare',
        type: 'driver_doc.status_changed',
        // 'ambient', not 'actionable': the client reserves 'actionable' for *claimable* offers and
        // routes those to the accept/decline claim card. A document verdict is something to read,
        // not a job to claim — as 'actionable' it rendered as an "Accept / Decline" ride card whose
        // buttons acted on the ride_request whose id happened to match this document_id.
        urgency: 'ambient',
        title: status === 'verified' ? `Your ${existing.doc_type} was verified` : `Your ${existing.doc_type} was rejected`,
        body: status === 'rejected' ? (reason || undefined) : undefined,
        entityType: 'driver_document',
        entityId: document_id,
        actionUrl: 'sd-drive',
      }).catch(() => {});
    }

    return res.json({ successful: true, data: publicDoc(updated) });
  } catch (err) {
    console.error('[driver-document] PATCH admin error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
