import express from 'express';
import multer from 'multer';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth, requireAdmin } from '../middleware/authentication.js';
import { sniffImageType, buildObjectName, storeImageBuffer } from '../utils/image-upload.js';
import { isBackgroundRemovalEnabled, removeImageBackground } from '../services/background-removal.js';
import { buildPublicPropertyWhere } from '../utils/property-filters.js';
import { runPropertySavedSearchAlerts } from '../utils/property-saved-search-cron.js';
import {
  AUTH_CAPABILITIES,
  sanitizeCapabilityMetadata,
  validateCapabilityApplication,
  requestCapability,
  ensureLegacyCapability,
  assertCanCreateProperty,
  assertCanPublish,
  stripOwnerTrustFields,
  trustLabelForListing,
  listingHasPublishRequirements,
} from '../utils/property-authenticity.js';

const router = express.Router();

const REPORT_REASONS = new Set([
  'fake_listing',
  'wrong_address',
  'stolen_photos',
  'scam_contact',
  'already_sold',
  'other',
]);

const FLOOR_PLANS_CONTAINER = process.env.AZURE_FLOOR_PLANS_CONTAINER || 'floor-plans';

const floorPlanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Coarse first pass on the declared type; the buffer's magic bytes are the real gate.
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, GIF or WEBP images are allowed'));
    }
    cb(null, true);
  },
});

const uploadFloorPlanImage = (req, res, next) => {
  floorPlanUpload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ successful: false, message: 'Image size must be less than 10MB' });
      }
      return res.status(400).json({ successful: false, message: err.message });
    }
    if (err) return res.status(400).json({ successful: false, message: err.message });
    next();
  });
};

const PUBLIC_OWNER_SELECT = { user_id: true, name: true, username: true };

const PROPERTY_DETAIL_INCLUDE = {
  user: { select: PUBLIC_OWNER_SELECT },
  images: { orderBy: [{ is_cover: 'desc' }, { sort_order: 'asc' }, { image_id: 'asc' }] },
  floor_plans: { where: { is_active: true }, orderBy: [{ sort_order: 'asc' }, { floor_plan_id: 'asc' }] },
  updates: { orderBy: { created_at: 'desc' }, take: 20 },
  _count: { select: { saves: true, followers: true, inquiries: true, viewings: true } },
};

const RICH_FIELDS = [
  'city', 'neighborhood', 'province', 'country', 'postal_code',
  'latitude', 'longitude', 'price_min', 'price_max',
  'beds_min', 'beds_max', 'baths_min', 'baths_max', 'sqft_min', 'sqft_max',
  'total_units', 'listing_status', 'construction_status', 'completion_date', 'sales_start',
  'deposit_info', 'maintenance_fee', 'developer_name', 'builder_website',
  'virtual_tour_url', 'video_url', 'sales_center_address', 'sales_center_phone',
  'sales_center_email', 'sales_center_hours', 'amenities', 'highlights',
  'incentives', 'move_in_homes', 'design_packages',
  // Trust flags intentionally omitted — owners cannot self-set verified/featured/published.
];

function asFloat(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asBool(v, fallback = undefined) {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

// Normalize a preferred-time string to 24h "HH:MM". Handles both 12h labels
// ("9:00 AM", "1:00 PM") and already-24h values ("13:00"). Returns null if unparseable.
function to24h(v) {
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(String(v ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || Number(min) > 59) return null;
  return `${String(h).padStart(2, '0')}:${min}`;
}

function pickRichData(body = {}) {
  const data = {};
  for (const key of RICH_FIELDS) {
    if (body[key] === undefined) continue;
    if (['latitude', 'longitude', 'price_min', 'price_max', 'baths_min', 'baths_max'].includes(key)) {
      data[key] = asFloat(body[key]);
    } else if (['beds_min', 'beds_max', 'sqft_min', 'sqft_max', 'total_units'].includes(key)) {
      data[key] = asInt(body[key]);
    } else {
      data[key] = body[key] ?? null;
    }
  }
  return stripOwnerTrustFields(data);
}

function buildPublicWhere(query = {}, viewer = null) {
  return buildPublicPropertyWhere(query, viewer);
}

async function assertPropertyOwner(property_id, user_id) {
  const existing = await prisma.property.findUnique({ where: { property_id } });
  if (!existing) return { error: 'Property not found', status: 404 };
  if (existing.user_id !== user_id) return { error: 'You do not have permission to edit this property', status: 403 };
  return { property: existing };
}

/** Attach trust_label + seller_type for buyer-facing authenticity UI. */
async function withTrustMeta(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const ownerIds = [...new Set(list.map((p) => p?.user_id).filter((id) => id != null))];
  if (!ownerIds.length) {
    return Array.isArray(rows)
      ? rows.map((p) => ({ ...p, trust_label: trustLabelForListing(p, null), seller_type: null }))
      : { ...rows, trust_label: trustLabelForListing(rows, null), seller_type: null };
  }

  const caps = await prisma.seller_capability.findMany({
    where: {
      user_id: { in: ownerIds },
      capability: { in: [...AUTH_CAPABILITIES] },
    },
  });
  const byOwner = new Map();
  for (const c of caps) {
    const key = `${c.user_id}:${c.capability}`;
    byOwner.set(key, c);
  }

  const enrich = (p) => {
    const capName = p.vertical === 'preconstruction' ? 'is_precon_developer' : 'is_realtor';
    const cap = byOwner.get(`${p.user_id}:${capName}`) || null;
    return {
      ...p,
      trust_label: trustLabelForListing(p, cap),
      seller_type: cap?.metadata?.seller_type || null,
      seller_status: cap?.status || null,
    };
  };

  return Array.isArray(rows) ? list.map(enrich) : enrich(rows);
}

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL PROPERTIES (public browse) */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const where = buildPublicWhere(req.query, req.user || null);
    const sort = String(req.query.sort || 'newest');
    let orderBy = { property_id: 'desc' };
    if (sort === 'price_asc') orderBy = [{ price_min: 'asc' }, { estimated_value: 'asc' }];
    if (sort === 'price_desc') orderBy = [{ price_min: 'desc' }, { estimated_value: 'desc' }];
    if (sort === 'featured') orderBy = [{ is_featured: 'desc' }, { property_id: 'desc' }];

    const properties = await prisma.property.findMany({
      where,
      orderBy,
      include: {
        user: { select: PUBLIC_OWNER_SELECT },
        images: { orderBy: [{ is_cover: 'desc' }, { sort_order: 'asc' }], take: 5 },
        floor_plans: { where: { is_active: true }, orderBy: { sort_order: 'asc' }, take: 8 },
        _count: { select: { saves: true, followers: true } },
      },
    });

    res.json(await withTrustMeta(properties));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

/* GET my properties */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const vertical = typeof req.query.vertical === 'string' ? req.query.vertical : undefined;
    const where = { user_id: req.user.user_id };
    if (vertical === 'realestate') where.OR = [{ vertical: 'realestate' }, { vertical: null }];
    else if (vertical) where.vertical = vertical;

    const properties = await prisma.property.findMany({
      where,
      orderBy: { property_id: 'desc' },
      include: PROPERTY_DETAIL_INCLUDE,
    });
    res.json(await withTrustMeta(properties));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your properties' });
  }
});

/* Saved searches */
router.get('/saved-searches', authenticateToken, async (req, res) => {
  try {
    const vertical = typeof req.query.vertical === 'string' ? req.query.vertical : undefined;
    const where = { user_id: req.user.user_id };
    if (vertical) where.vertical = vertical;
    const rows = await prisma.property_saved_search.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch saved searches' });
  }
});

router.post('/saved-searches', authenticateToken, async (req, res) => {
  try {
    const { name, vertical, filters, alert_enabled } = req.body || {};
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      return res.status(400).json({ successful: false, message: 'filters object required' });
    }
    const now = new Date();
    const row = await prisma.property_saved_search.create({
      data: {
        user_id: req.user.user_id,
        name: name ? String(name).slice(0, 120) : null,
        vertical: vertical ? String(vertical).slice(0, 40) : null,
        filters,
        alert_enabled: asBool(alert_enabled, true),
        // Start watermark at create time so alerts only fire for *new* listings.
        last_notified_at: now,
      },
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to save search' });
  }
});

router.patch('/saved-searches/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.property_saved_search.findUnique({ where: { saved_search_id: id } });
    if (!existing || existing.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: 'Saved search not found' });
    }
    const { name, filters, alert_enabled } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = name ? String(name).slice(0, 120) : null;
    if (filters !== undefined) {
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        return res.status(400).json({ successful: false, message: 'filters must be an object' });
      }
      data.filters = filters;
    }
    if (alert_enabled !== undefined) data.alert_enabled = asBool(alert_enabled, existing.alert_enabled);
    const row = await prisma.property_saved_search.update({
      where: { saved_search_id: id },
      data,
    });
    res.json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update saved search' });
  }
});

/** Manual alert check for the signed-in user (demo / "Check now"). */
router.post('/saved-searches/run-alerts', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const result = await runPropertySavedSearchAlerts(io, { userId: req.user.user_id });
    res.json({ successful: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to run saved-search alerts' });
  }
});

router.delete('/saved-searches/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.property_saved_search.findUnique({ where: { saved_search_id: id } });
    if (!existing || existing.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: 'Saved search not found' });
    }
    await prisma.property_saved_search.delete({ where: { saved_search_id: id } });
    res.json({ successful: true, message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to delete saved search' });
  }
});

/* Seller capabilities */
router.get('/capabilities/me', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.seller_capability.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
    });
    const active = rows.filter((r) => r.status === 'active').map((r) => r.capability);
    res.json({
      successful: true,
      // Backward-compatible: data stays the list of *active* capability names.
      data: active,
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch capabilities' });
  }
});

router.post('/capabilities', authenticateToken, async (req, res) => {
  try {
    const capability = String(req.body?.capability || '');
    const allowed = new Set(['is_realtor', 'is_precon_developer', 'is_hotel_owner', 'is_host', 'is_restaurant_owner']);
    if (!allowed.has(capability)) {
      return res.status(400).json({ successful: false, message: 'Invalid capability' });
    }

    let row;
    if (AUTH_CAPABILITIES.has(capability)) {
      const metadata = sanitizeCapabilityMetadata(capability, req.body || {});
      const validationError = validateCapabilityApplication(capability, metadata);
      if (validationError) {
        return res.status(400).json({ successful: false, message: validationError });
      }
      row = await requestCapability(prisma, req.user.user_id, capability, metadata);
    } else {
      row = await ensureLegacyCapability(prisma, req.user.user_id, capability);
    }

    if (capability === 'is_realtor' || capability === 'is_precon_developer' || capability === 'is_hotel_owner' || capability === 'is_host') {
      await prisma.user.update({ where: { user_id: req.user.user_id }, data: { is_seller: true } }).catch(() => {});
    }

    res.status(201).json({
      successful: true,
      data: row,
      message: 'Capability granted. You can publish listings right away.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to grant capability' });
  }
});

/* Admin: approve / reject seller capability applications */
router.get('/admin/capabilities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const where = { capability: { in: [...AUTH_CAPABILITIES] } };
    if (status !== 'all') where.status = status;
    const rows = await prisma.seller_capability.findMany({
      where,
      include: { user: { select: { user_id: true, name: true, username: true, email: true } } },
      orderBy: { created_at: 'asc' },
      take: 200,
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to list capability applications' });
  }
});

router.patch('/admin/capabilities/:capability_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const capability_id = Number(req.params.capability_id);
    const status = String(req.body?.status || '');
    if (!['active', 'pending', 'rejected', 'suspended'].includes(status)) {
      return res.status(400).json({ successful: false, message: 'status must be active|pending|rejected|suspended' });
    }
    const existing = await prisma.seller_capability.findUnique({ where: { capability_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Not found' });
    if (!AUTH_CAPABILITIES.has(existing.capability)) {
      return res.status(400).json({ successful: false, message: 'Not an authenticity-gated capability' });
    }
    const row = await prisma.seller_capability.update({
      where: { capability_id },
      data: { status },
    });
    res.json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update capability' });
  }
});

/* Admin: publish / verify / takedown listings */
router.patch('/admin/:property_id/trust', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid property_id' });
    }
    const existing = await prisma.property.findUnique({ where: { property_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Property not found' });

    const data = {};
    if (req.body?.is_published !== undefined) data.is_published = asBool(req.body.is_published, false);
    if (req.body?.is_verified !== undefined) data.is_verified = asBool(req.body.is_verified, false);
    if (req.body?.is_featured !== undefined) data.is_featured = asBool(req.body.is_featured, false);
    if (!Object.keys(data).length) {
      return res.status(400).json({ successful: false, message: 'Provide is_published, is_verified, and/or is_featured' });
    }

    const updated = await prisma.property.update({
      where: { property_id },
      data,
      include: PROPERTY_DETAIL_INCLUDE,
    });
    res.json({ successful: true, data: await withTrustMeta(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update listing trust flags' });
  }
});

router.get('/admin/reports', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const where = status === 'all' ? {} : { status };
    const rows = await prisma.property_report.findMany({
      where,
      include: {
        property: {
          select: {
            property_id: true, property_name: true, address: true, vertical: true,
            is_published: true, is_verified: true, user_id: true,
          },
        },
        reporter: { select: PUBLIC_OWNER_SELECT },
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to list property reports' });
  }
});

router.patch('/admin/reports/:report_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const report_id = Number(req.params.report_id);
    const status = String(req.body?.status || '');
    if (!['pending', 'reviewed', 'actioned', 'dismissed'].includes(status)) {
      return res.status(400).json({ successful: false, message: 'Invalid status' });
    }
    const report = await prisma.property_report.findUnique({ where: { report_id } });
    if (!report) return res.status(404).json({ successful: false, message: 'Report not found' });

    const takedown = asBool(req.body?.takedown, false);
    if (takedown) {
      await prisma.property.update({
        where: { property_id: report.property_id },
        data: { is_published: false, is_verified: false },
      });
    }

    const updated = await prisma.property_report.update({
      where: { report_id },
      data: { status: takedown ? 'actioned' : status },
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update report' });
  }
});

/* Owner leads inbox */
router.get('/leads/mine', authenticateToken, async (req, res) => {
  try {
    const properties = await prisma.property.findMany({
      where: { user_id: req.user.user_id },
      select: { property_id: true },
    });
    const ids = properties.map((p) => p.property_id);
    const [inquiries, viewings] = await Promise.all([
      prisma.property_inquiry.findMany({
        where: { property_id: { in: ids } },
        include: {
          property: { select: { property_id: true, property_name: true, vertical: true } },
          user: { select: PUBLIC_OWNER_SELECT },
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
      prisma.property_viewing.findMany({
        where: { property_id: { in: ids } },
        include: {
          property: { select: { property_id: true, property_name: true, vertical: true } },
          user: { select: PUBLIC_OWNER_SELECT },
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    ]);
    res.json({ successful: true, data: { inquiries, viewings } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch leads' });
  }
});

/* Builder analytics command center — Livabl-style page views / leads / followers */
router.get('/analytics/mine', authenticateToken, async (req, res) => {
  try {
    const properties = await prisma.property.findMany({
      where: { user_id: req.user.user_id },
      select: {
        property_id: true,
        property_name: true,
        vertical: true,
        view_count: true,
        listing_status: true,
        _count: { select: { saves: true, followers: true, inquiries: true, viewings: true } },
      },
      orderBy: { view_count: 'desc' },
    });

    const totals = properties.reduce(
      (acc, p) => {
        acc.views += p.view_count || 0;
        acc.saves += p._count?.saves || 0;
        acc.followers += p._count?.followers || 0;
        acc.inquiries += p._count?.inquiries || 0;
        acc.viewings += p._count?.viewings || 0;
        return acc;
      },
      { views: 0, saves: 0, followers: 0, inquiries: 0, viewings: 0 },
    );

    const leads = totals.inquiries + totals.viewings;
    const conversion_rate = totals.views > 0 ? Math.round((leads / totals.views) * 1000) / 10 : 0;

    res.json({
      successful: true,
      data: {
        totals: { ...totals, leads, conversion_rate, communities: properties.length },
        communities: properties.map((p) => ({
          property_id: p.property_id,
          property_name: p.property_name,
          vertical: p.vertical,
          listing_status: p.listing_status,
          views: p.view_count || 0,
          saves: p._count?.saves || 0,
          followers: p._count?.followers || 0,
          inquiries: p._count?.inquiries || 0,
          viewings: p._count?.viewings || 0,
          leads: (p._count?.inquiries || 0) + (p._count?.viewings || 0),
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch analytics' });
  }
});

/* Floor plan image upload — stores the original, then runs the (pluggable)
   background-removal step so plan images render consistently platform-wide.
   Not property-scoped on purpose: the create flow uploads images before the
   property row exists. Processing failures are non-fatal — the original is
   always kept and served as the fallback. */
router.post('/floor-plans/image', authenticateToken, uploadFloorPlanImage, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ successful: false, message: 'No file uploaded' });
  }

  // Derive the content type from magic bytes — never trust the client mimetype.
  const contentType = sniffImageType(req.file.buffer);
  if (!contentType) {
    return res.status(400).json({ successful: false, message: 'File is not a valid JPEG, PNG, GIF or WEBP image' });
  }

  const objectName = buildObjectName(req.file.originalname);

  let originalImageUrl;
  try {
    originalImageUrl = await storeImageBuffer({
      container: FLOOR_PLANS_CONTAINER,
      dirName: 'floor-plans',
      objectName,
      buffer: req.file.buffer,
      contentType,
    });
  } catch (err) {
    console.error('Floor plan image store failed:', err);
    return res.status(500).json({ successful: false, message: 'Failed to store floor plan image' });
  }

  let imageUrl = originalImageUrl;
  let imageProcessed = false;
  if (isBackgroundRemovalEnabled()) {
    try {
      const processed = await removeImageBackground(req.file.buffer, contentType);
      imageUrl = await storeImageBuffer({
        container: FLOOR_PLANS_CONTAINER,
        dirName: 'floor-plans',
        objectName: objectName.replace(/(\.\w+)?$/, '') + '-processed.png',
        buffer: processed.buffer,
        contentType: processed.contentType,
      });
      imageProcessed = true;
    } catch (err) {
      // Best-effort: serve the original rather than failing the upload.
      console.warn('Floor plan background removal failed, keeping original:', err?.message || err);
    }
  }

  return res.status(201).json({
    successful: true,
    data: {
      image_url: imageUrl,
      original_image_url: originalImageUrl,
      image_processed: imageProcessed,
    },
  });
});

/* Buyer: whether I've already inquired / booked a tour on this property */
router.get('/:property_id/my-engagement', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) {
      return res.status(400).json({ successful: false, message: 'property_id must be a number' });
    }
    const [inquiry, viewing, save, follow, incentiveInquiries, moveInInquiries, designInquiries] = await Promise.all([
      prisma.property_inquiry.findFirst({
        where: { property_id, user_id: req.user.user_id },
        orderBy: { created_at: 'desc' },
      }),
      prisma.property_viewing.findFirst({
        where: {
          property_id,
          user_id: req.user.user_id,
          status: { notIn: ['cancelled', 'declined'] },
        },
        orderBy: { created_at: 'desc' },
      }),
      prisma.property_save.findUnique({
        where: { property_id_user_id: { property_id, user_id: req.user.user_id } },
      }),
      prisma.property_follow.findUnique({
        where: { property_id_user_id: { property_id, user_id: req.user.user_id } },
      }),
      prisma.property_inquiry.findMany({
        where: { property_id, user_id: req.user.user_id, type: 'incentive' },
        select: { message: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
      prisma.property_inquiry.findMany({
        where: { property_id, user_id: req.user.user_id, type: 'move_in' },
        select: { message: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
      prisma.property_inquiry.findMany({
        where: { property_id, user_id: req.user.user_id, type: 'design_package' },
        select: { message: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    ]);
    res.json({
      successful: true,
      data: {
        has_interest: !!inquiry && (inquiry.type === 'interest' || inquiry.type === 'contact' || !inquiry.type),
        has_tour: !!viewing,
        is_saved: !!save,
        is_following: !!follow,
        claimed_incentives: incentiveInquiries.map((r) => r.message).filter(Boolean),
        reserved_move_ins: moveInInquiries.map((r) => r.message).filter(Boolean),
        requested_packages: designInquiries.map((r) => r.message).filter(Boolean),
        inquiry,
        viewing,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to load engagement' });
  }
});

/* GET PROPERTY BY ID (public browse) */
router.get('/:property_id', optionalAuth, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);

    if (Number.isNaN(property_id)) {
      return res.status(400).json({ error: 'property_id must be a number' });
    }

    const property = await prisma.property.findUnique({
      where: { property_id },
      include: PROPERTY_DETAIL_INCLUDE,
    });

    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }

    // Authenticity: an unpublished listing (draft / pending / rejected / taken-down) is only
    // visible to its owner or an admin. property_id is a sequential SERIAL, so without this an
    // unpublished listing stays fetchable by direct id even though every browse surface hides it
    // (buildPublicPropertyWhere defaults to is_published: true). Mirror that rule here, and 404
    // rather than 403 so the endpoint doesn't confirm the id exists.
    const viewer = req.user || null;
    const isAdmin = viewer?.role === 'ADMIN' || viewer?.permission === 'admin';
    const isOwner = viewer && viewer.user_id === property.user_id;
    if (!property.is_published && !isOwner && !isAdmin) {
      return res.status(404).json({ error: 'Property not found' });
    }

    // Best-effort view counter; never fail the read.
    prisma.property.update({
      where: { property_id },
      data: { view_count: { increment: 1 } },
    }).catch(() => {});

    res.json(await withTrustMeta(property));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

/* CREATE PROPERTY */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      estimated_value, type, address, image, property_name, description, status, vertical,
      images, floor_plans,
    } = req.body;

    const rich = pickRichData(req.body);
    const stampedVertical = vertical === 'preconstruction' || vertical === 'realestate' ? vertical : null;

    const gate = await assertCanCreateProperty(prisma, req.user.user_id, stampedVertical || 'realestate');
    if (!gate.ok) {
      return res.status(gate.status).json({ error: gate.message, successful: false, message: gate.message });
    }

    const property = await prisma.property.create({
      data: {
        user_id: req.user.user_id,
        estimated_value: estimated_value != null ? parseFloat(estimated_value) : null,
        type: type ?? null,
        address: address ?? null,
        image: image ?? null,
        property_name: property_name ?? null,
        description: description ?? null,
        status: status ?? rich.listing_status ?? null,
        vertical: stampedVertical,
        listing_status: rich.listing_status ?? status ?? null,
        ...rich,
        // Publish immediately when address + photo are present. Owners still
        // cannot self-set verified/featured.
        is_published: listingHasPublishRequirements(
          { address, image },
          { imageCount: Array.isArray(images) && images.length ? images.length : (image ? 1 : 0) },
        ),
        is_verified: false,
        is_featured: false,
        images: Array.isArray(images) && images.length
          ? {
              create: images.map((img, idx) => ({
                url: typeof img === 'string' ? img : img.url,
                caption: typeof img === 'object' ? img.caption ?? null : null,
                sort_order: typeof img === 'object' ? img.sort_order ?? idx : idx,
                is_cover: typeof img === 'object' ? !!img.is_cover : idx === 0,
              })),
            }
          : image
            ? { create: [{ url: image, is_cover: true, sort_order: 0 }] }
            : undefined,
        floor_plans: Array.isArray(floor_plans) && floor_plans.length
          ? {
              create: floor_plans.map((fp, idx) => ({
                name: fp.name || `Plan ${idx + 1}`,
                beds: asFloat(fp.beds),
                baths: asFloat(fp.baths),
                sqft_min: asInt(fp.sqft_min),
                sqft_max: asInt(fp.sqft_max),
                price_min: asFloat(fp.price_min),
                price_max: asFloat(fp.price_max),
                availability: fp.availability ?? null,
                image_url: fp.image_url ?? null,
                original_image_url: fp.original_image_url ?? null,
                image_processed: asBool(fp.image_processed, false),
                description: fp.description ?? null,
                unit_count: asInt(fp.unit_count),
                sort_order: fp.sort_order ?? idx,
              })),
            }
          : undefined,
      },
      include: PROPERTY_DETAIL_INCLUDE,
    });

    res.status(201).json({
      ...await withTrustMeta(property),
      authenticity: {
        seller_status: gate.capability?.status,
        seller_type: gate.capability?.metadata?.seller_type || null,
        publish_allowed: true,
        note: property.is_published
          ? 'Listing is live in the marketplace.'
          : 'Listing saved as draft. Add an address and photo, then publish.',
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create property' });
  }
});

/* UPDATE PROPERTY */
router.put('/:property_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);

    if (Number.isNaN(property_id)) {
      return res.status(400).json({ error: 'property_id must be a number' });
    }

    const { estimated_value, type, address, image, property_name, description, status } = req.body;
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ error: owned.error });

    const rich = pickRichData(req.body);
    const updated = await prisma.property.update({
      where: { property_id },
      data: {
        estimated_value: estimated_value != null ? parseFloat(estimated_value) : owned.property.estimated_value,
        type: type !== undefined ? type : owned.property.type,
        address: address !== undefined ? address : owned.property.address,
        image: image !== undefined ? image : owned.property.image,
        property_name: property_name !== undefined ? property_name : owned.property.property_name,
        description: description !== undefined ? description : owned.property.description,
        status: status !== undefined ? status : owned.property.status,
        ...rich,
        listing_status: rich.listing_status ?? (status !== undefined ? status : owned.property.listing_status),
      },
      include: PROPERTY_DETAIL_INCLUDE,
    });

    res.json(await withTrustMeta(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update property' });
  }
});

/* Owner: publish or unpublish (gated — never self-verify) */
router.post('/:property_id/publish', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid property_id' });
    }
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });

    const wantPublish = req.body?.publish === undefined ? true : asBool(req.body.publish, true);
    if (!wantPublish) {
      const updated = await prisma.property.update({
        where: { property_id },
        data: { is_published: false },
        include: PROPERTY_DETAIL_INCLUDE,
      });
      return res.json({ successful: true, data: await withTrustMeta(updated) });
    }

    const capName = owned.property.vertical === 'preconstruction' ? 'is_precon_developer' : 'is_realtor';
    const capability = await prisma.seller_capability.findUnique({
      where: { user_id_capability: { user_id: req.user.user_id, capability: capName } },
    });
    const gate = await assertCanPublish(prisma, req.user.user_id, owned.property, capability);
    if (!gate.ok) {
      return res.status(gate.status).json({ successful: false, message: gate.message });
    }

    const updated = await prisma.property.update({
      where: { property_id },
      data: { is_published: true },
      include: PROPERTY_DETAIL_INCLUDE,
    });
    res.json({
      successful: true,
      data: await withTrustMeta(updated),
      message: 'Listing is live.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update publish state' });
  }
});

/* Buyer: report a fake / fraudulent listing */
router.post('/:property_id/report', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid property_id' });
    }
    const property = await prisma.property.findUnique({ where: { property_id } });
    if (!property) return res.status(404).json({ successful: false, message: 'Property not found' });
    if (property.user_id === req.user.user_id) {
      return res.status(400).json({ successful: false, message: 'You cannot report your own listing' });
    }

    const reason = String(req.body?.reason || '').trim();
    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({
        successful: false,
        message: `reason must be one of: ${[...REPORT_REASONS].join(', ')}`,
      });
    }
    const details = req.body?.details != null ? String(req.body.details).trim().slice(0, 2000) : null;

    const existing = await prisma.property_report.findFirst({
      where: {
        property_id,
        reporter_id: req.user.user_id,
        status: 'pending',
      },
    });
    if (existing) {
      return res.status(409).json({ successful: false, message: 'You already have a pending report for this listing' });
    }

    const report = await prisma.property_report.create({
      data: {
        property_id,
        reporter_id: req.user.user_id,
        reason,
        details,
      },
    });
    res.status(201).json({ successful: true, message: 'Report submitted for review.', data: report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to submit report' });
  }
});

/* DELETE PROPERTY */
router.delete('/:property_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);

    if (Number.isNaN(property_id)) {
      return res.status(400).json({ error: 'property_id must be a number' });
    }

    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ error: owned.error });

    await prisma.property.delete({ where: { property_id } });
    res.json({ message: 'Property deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete property' });
  }
});

/* Images */
router.post('/:property_id/images', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });

    const urls = Array.isArray(req.body?.images) ? req.body.images : [req.body];
    const created = await prisma.$transaction(urls.filter(Boolean).map((img, idx) =>
      prisma.property_image.create({
        data: {
          property_id,
          url: typeof img === 'string' ? img : img.url,
          caption: typeof img === 'object' ? img.caption ?? null : null,
          sort_order: typeof img === 'object' ? img.sort_order ?? idx : idx,
          is_cover: typeof img === 'object' ? !!img.is_cover : false,
        },
      }),
    ));
    res.status(201).json({ successful: true, data: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to add images' });
  }
});

router.delete('/:property_id/images/:image_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const image_id = Number(req.params.image_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    await prisma.property_image.deleteMany({ where: { image_id, property_id } });
    res.json({ successful: true, message: 'Image deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to delete image' });
  }
});

/* Floor plans */
router.post('/:property_id/floor-plans', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const fp = req.body || {};
    if (!fp.name) return res.status(400).json({ successful: false, message: 'name required' });
    const row = await prisma.property_floor_plan.create({
      data: {
        property_id,
        name: fp.name,
        beds: asFloat(fp.beds),
        baths: asFloat(fp.baths),
        sqft_min: asInt(fp.sqft_min),
        sqft_max: asInt(fp.sqft_max),
        price_min: asFloat(fp.price_min),
        price_max: asFloat(fp.price_max),
        availability: fp.availability ?? null,
        image_url: fp.image_url ?? null,
        original_image_url: fp.original_image_url ?? null,
        image_processed: asBool(fp.image_processed, false),
        description: fp.description ?? null,
        unit_count: asInt(fp.unit_count),
        sort_order: asInt(fp.sort_order) ?? 0,
      },
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to create floor plan' });
  }
});

router.put('/:property_id/floor-plans/:floor_plan_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const floor_plan_id = Number(req.params.floor_plan_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const fp = req.body || {};
    const row = await prisma.property_floor_plan.updateMany({
      where: { floor_plan_id, property_id },
      data: {
        name: fp.name !== undefined ? fp.name : undefined,
        beds: fp.beds !== undefined ? asFloat(fp.beds) : undefined,
        baths: fp.baths !== undefined ? asFloat(fp.baths) : undefined,
        sqft_min: fp.sqft_min !== undefined ? asInt(fp.sqft_min) : undefined,
        sqft_max: fp.sqft_max !== undefined ? asInt(fp.sqft_max) : undefined,
        price_min: fp.price_min !== undefined ? asFloat(fp.price_min) : undefined,
        price_max: fp.price_max !== undefined ? asFloat(fp.price_max) : undefined,
        availability: fp.availability !== undefined ? fp.availability : undefined,
        image_url: fp.image_url !== undefined ? fp.image_url : undefined,
        original_image_url: fp.original_image_url !== undefined ? fp.original_image_url : undefined,
        image_processed: fp.image_processed !== undefined ? asBool(fp.image_processed, false) : undefined,
        description: fp.description !== undefined ? fp.description : undefined,
        unit_count: fp.unit_count !== undefined ? asInt(fp.unit_count) : undefined,
        sort_order: fp.sort_order !== undefined ? asInt(fp.sort_order) : undefined,
        is_active: fp.is_active !== undefined ? asBool(fp.is_active, true) : undefined,
      },
    });
    if (!row.count) return res.status(404).json({ successful: false, message: 'Floor plan not found' });
    const updated = await prisma.property_floor_plan.findUnique({ where: { floor_plan_id } });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update floor plan' });
  }
});

router.delete('/:property_id/floor-plans/:floor_plan_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const floor_plan_id = Number(req.params.floor_plan_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    await prisma.property_floor_plan.deleteMany({ where: { floor_plan_id, property_id } });
    res.json({ successful: true, message: 'Floor plan deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to delete floor plan' });
  }
});

/* Project updates (construction progress posts) */
router.get('/:property_id/updates', async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) {
      return res.status(400).json({ successful: false, message: 'property_id must be a number' });
    }
    const rows = await prisma.property_update.findMany({
      where: { property_id },
      orderBy: { created_at: 'desc' },
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch updates' });
  }
});

router.post('/:property_id/updates', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const { title, body, image_url } = req.body || {};
    if (!title) return res.status(400).json({ successful: false, message: 'title required' });
    const row = await prisma.property_update.create({
      data: { property_id, title, body: body ?? null, image_url: image_url ?? null },
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to create update' });
  }
});

router.put('/:property_id/updates/:update_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const update_id = Number(req.params.update_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const existing = await prisma.property_update.findFirst({ where: { update_id, property_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Update not found' });
    const { title, body, image_url } = req.body || {};
    const data = {};
    if (title !== undefined) data.title = String(title).slice(0, 255);
    if (body !== undefined) data.body = body == null ? null : String(body);
    if (image_url !== undefined) data.image_url = image_url == null ? null : String(image_url).slice(0, 1000);
    if (!Object.keys(data).length) {
      return res.status(400).json({ successful: false, message: 'No fields to update' });
    }
    if (data.title !== undefined && !data.title.trim()) {
      return res.status(400).json({ successful: false, message: 'title required' });
    }
    const row = await prisma.property_update.update({ where: { update_id }, data });
    res.json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update update' });
  }
});

router.delete('/:property_id/updates/:update_id', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const update_id = Number(req.params.update_id);
    const owned = await assertPropertyOwner(property_id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const existing = await prisma.property_update.findFirst({ where: { update_id, property_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Update not found' });
    await prisma.property_update.delete({ where: { update_id } });
    res.json({ successful: true, message: 'Update deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to delete update' });
  }
});

/* Save / unsave */
router.post('/:property_id/save', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const property = await prisma.property.findUnique({ where: { property_id } });
    if (!property) return res.status(404).json({ successful: false, message: 'Property not found' });
    const row = await prisma.property_save.upsert({
      where: { property_id_user_id: { property_id, user_id: req.user.user_id } },
      create: { property_id, user_id: req.user.user_id },
      update: {},
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to save property' });
  }
});

router.delete('/:property_id/save', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    await prisma.property_save.deleteMany({
      where: { property_id, user_id: req.user.user_id },
    });
    res.json({ successful: true, message: 'Unsaved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to unsave property' });
  }
});

/* Follow / unfollow (project updates) */
router.post('/:property_id/follow', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    const property = await prisma.property.findUnique({ where: { property_id } });
    if (!property) return res.status(404).json({ successful: false, message: 'Property not found' });
    const row = await prisma.property_follow.upsert({
      where: { property_id_user_id: { property_id, user_id: req.user.user_id } },
      create: { property_id, user_id: req.user.user_id },
      update: {},
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to follow property' });
  }
});

router.delete('/:property_id/follow', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    await prisma.property_follow.deleteMany({
      where: { property_id, user_id: req.user.user_id },
    });
    res.json({ successful: true, message: 'Unfollowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to unfollow property' });
  }
});

/* POST /:property_id/inquiry — persisted inquiry + realtime notify */
router.post('/:property_id/inquiry', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) return res.status(400).json({ successful: false, message: 'property_id must be a number' });

    const { message, phone, name, email, type, floor_plan_id, floor_plan } = req.body;
    const io = req.app.get('io');

    const property = await prisma.property.findUnique({ where: { property_id } });
    if (!property) return res.status(404).json({ successful: false, message: 'Property not found' });

    const inquiry = await prisma.property_inquiry.create({
      data: {
        property_id,
        user_id: req.user.user_id,
        floor_plan_id: floor_plan_id != null ? Number(floor_plan_id) : null,
        type: type ?? (floor_plan ? 'interest' : 'contact'),
        name: name ?? null,
        email: email ?? null,
        phone: phone ?? null,
        message: message ?? (floor_plan ? `Interested in ${floor_plan}` : null),
        status: 'new',
      },
    });

    io?.to(`user-${property.user_id}`).emit(`property-inquiry-${property_id}`, {
      inquiry_id: inquiry.inquiry_id,
      user_id: req.user.user_id,
      message: inquiry.message,
      phone,
      type: inquiry.type,
    });

    // Ads lead notify is best-effort — never fail the inquiry if ads schema/lookup errors.
    try {
      const activeAd = await prisma.ads_campaign.findFirst({
        where: {
          status: 'ACTIVE',
          ads_wallet: { user_id: property.user_id },
        },
        include: { ads_wallet: { select: { user_id: true } } },
      });
      if (activeAd) {
        const advertiserId = activeAd.ads_wallet.user_id;
        io?.to(`user-${advertiserId}`).emit(`ads-lead-generated-${advertiserId}`, {
          campaign_id: activeAd.campaign_id,
          lead_type: 'PROPERTY_INQUIRY',
          user_id: req.user.user_id,
          message,
          phone,
        });
      }
    } catch (adsErr) {
      console.warn('property inquiry ads lead notify skipped:', adsErr?.message || adsErr);
    }

    return res.json({ successful: true, message: 'Inquiry sent', data: inquiry });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to send inquiry' });
  }
});

router.patch('/inquiries/:inquiry_id', authenticateToken, async (req, res) => {
  try {
    const inquiry_id = Number(req.params.inquiry_id);
    const status = String(req.body?.status || '');
    const allowed = new Set(['new', 'contacted', 'qualified', 'closed', 'spam']);
    if (!allowed.has(status)) return res.status(400).json({ successful: false, message: 'Invalid status' });

    const inquiry = await prisma.property_inquiry.findUnique({
      where: { inquiry_id },
      include: { property: { select: { user_id: true } } },
    });
    if (!inquiry) return res.status(404).json({ successful: false, message: 'Inquiry not found' });
    if (inquiry.property.user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    const updated = await prisma.property_inquiry.update({
      where: { inquiry_id },
      data: { status },
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update inquiry' });
  }
});

/* POST /:property_id/viewing — property-linked tour request */
router.post('/:property_id/viewing', authenticateToken, async (req, res) => {
  try {
    const property_id = Number(req.params.property_id);
    if (Number.isNaN(property_id)) return res.status(400).json({ successful: false, message: 'property_id must be a number' });

    const { viewing_date, date, time, time_from, note, type } = req.body;
    // Clients may send preferred time as `time` or legacy `time_from`.
    const preferredTime = (typeof time === 'string' && time) || (typeof time_from === 'string' && time_from) || '';
    const timePart = to24h(preferredTime);

    let apptDate = null;
    if (viewing_date) {
      const dateOnly = String(viewing_date).slice(0, 10);
      apptDate = timePart
        ? new Date(`${dateOnly}T${timePart}:00`)
        : new Date(viewing_date);
    } else if (date) {
      // Combine YYYY-MM-DD + HH:MM so the seller sees the preferred time too.
      apptDate = new Date(`${date}T${timePart || '10:00'}:00`);
    }

    const property = await prisma.property.findUnique({ where: { property_id } });
    if (!property) return res.status(404).json({ successful: false, message: 'Property not found' });

    const timeLabel = preferredTime || timePart;
    const viewing = await prisma.property_viewing.create({
      data: {
        property_id,
        user_id: req.user.user_id,
        note: note ?? (type ? `${type}${timeLabel ? ` @ ${timeLabel}` : ''}` : (timeLabel ? `Preferred time: ${timeLabel}` : null)),
        viewing_date: apptDate && !Number.isNaN(apptDate.getTime()) ? apptDate : null,
        status: 'requested',
      },
    });

    // Keep legacy appointments row for older seller dashboards during migration.
    const appointment = await prisma.appointments.create({
      data: {
        user_id: req.user.user_id,
        note: note ?? `Property viewing #${property_id}`,
        date: apptDate && !Number.isNaN(apptDate.getTime()) ? apptDate : null,
      },
    }).catch(() => null);

    const payload = {
      ...viewing,
      appointment_id: appointment?.appointment_id ?? null,
    };

    const io = req.app.get('io');
    io?.to(`user-${property.user_id}`).emit(`property-viewing-${property_id}`, payload);

    return res.status(201).json({ successful: true, data: payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to book viewing' });
  }
});

router.patch('/viewings/:viewing_id', authenticateToken, async (req, res) => {
  try {
    const viewing_id = Number(req.params.viewing_id);
    const status = String(req.body?.status || '');
    const allowed = new Set(['requested', 'confirmed', 'declined', 'completed', 'cancelled']);
    if (!allowed.has(status)) return res.status(400).json({ successful: false, message: 'Invalid status' });

    const viewing = await prisma.property_viewing.findUnique({
      where: { viewing_id },
      include: { property: { select: { user_id: true } } },
    });
    if (!viewing) return res.status(404).json({ successful: false, message: 'Viewing not found' });
    const isOwner = viewing.property.user_id === req.user.user_id;
    const isGuest = viewing.user_id === req.user.user_id;
    if (!isOwner && !(isGuest && status === 'cancelled')) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    const updated = await prisma.property_viewing.update({
      where: { viewing_id },
      data: { status },
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update viewing' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
