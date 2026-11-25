import express from 'express';
import multer from 'multer';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
  requireAuthUserId,
  resolveDriverProfileForUser,
  assertDriverProfileOwnedByUser,
} from '../utils/ride-auth.js';
import { sniffImageType, buildObjectName, storeImageBuffer, downloadImageBuffer } from '../utils/image-upload.js';
import { uploadPublicBlob, uploadUntrustedUrlToBlob } from '../utils/azure-storage.js';
import { parseCsv } from '../utils/csv.js';

const router = express.Router();

const vehicleInclude = {
  driver_profile: true,
  vehicle_types: true,
  booking_type: true,
};

// Multer configuration for automotive vehicle uploads (images + video)
const automotiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for video
    files: 9, // Max 8 images + 1 video
  },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

const VEHICLE_IMAGES_CONTAINER = process.env.AZURE_VEHICLE_IMAGES_CONTAINER || 'vehicle-images';
const VEHICLE_VIDEOS_CONTAINER = process.env.AZURE_VEHICLE_VIDEOS_CONTAINER || 'vehicle-videos';

async function assertVehicleOwnedByUser(vehicle, userId) {
  // For automotive vehicles (no driver profile), check user_id directly
  if (!vehicle?.driver_id && vehicle?.user_id) {
    if (vehicle.user_id !== userId) {
      return { status: 403, message: 'Unauthorized action' };
    }
    return null;
  }
  
  // For rideshare vehicles (with driver profile), check via driver_id
  if (!vehicle?.driver_id) {
    return { status: 403, message: 'Unauthorized action' };
  }
  const profile = await prisma.driver_profile.findUnique({
    where: { driver_profile_id: vehicle.driver_id },
    select: { user_id: true },
  });
  if (!profile || profile.user_id !== userId) {
    return { status: 403, message: 'Unauthorized action' };
  }
  return null;
}

/* GET current driver's vehicles (rideshare) */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) {
      return res.json({ successful: true, data: [] });
    }

    const vehicles = await prisma.vehicle.findMany({
      where: { driver_id: profile.driver_profile_id },
      include: { vehicle_types: true, booking_type: true },
      orderBy: { vehicle_id: 'asc' },
    });

    return res.json({ successful: true, data: vehicles });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch your vehicles' });
  }
});

/* GET VEHICLES BY DRIVER ID — owner or public read for assigned driver id */
router.get('/driver/:driver_id', authenticateToken, async (req, res) => {
  try {
    const driver_id = Number(req.params.driver_id);
    if (Number.isNaN(driver_id)) {
      return res.status(400).json({ error: 'driver_id must be a number' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId, driver_id);
    const denied = assertDriverProfileOwnedByUser(profile, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    const vehicles = await prisma.vehicle.findMany({
      where: { driver_id },
      include: { vehicle_types: true, booking_type: true },
    });

    return res.json(vehicles);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch vehicles for driver' });
  }
});

/* GET ALL AUTOMOTIVE VEHICLES — for dealership listing (all vehicles with user_id) */
router.get('/automotive/all', async (req, res) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: {
        user_id: { not: null },
      },
      orderBy: { vehicle_id: 'desc' },
      include: vehicleInclude,
    });

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch automotive vehicles' });
  }
});

/* GET ALL VEHICLES — filtered by authenticated user */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const vehicles = await prisma.vehicle.findMany({
      where: {
        OR: [
          { user_id: userId },
          { driver_id: userId },
        ],
      },
      orderBy: { vehicle_id: 'desc' },
      include: vehicleInclude,
    });

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

/* GET VEHICLE BY ID */
router.get('/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = Number(req.params.vehicle_id);
    if (Number.isNaN(vehicle_id)) {
      return res.status(400).json({ error: 'vehicle_id must be a number' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const vehicle = await prisma.vehicle.findUnique({
      where: { vehicle_id },
      include: {
        ...vehicleInclude,
        active_trip: true,
        carpool_offer: true,
      },
    });

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    const denied = await assertVehicleOwnedByUser(vehicle, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    return res.json(vehicle);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch vehicle' });
  }
});

/* CREATE VEHICLE — linked to authenticated driver's profile */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) {
      return res.status(404).json({ successful: false, message: 'Driver profile not found' });
    }

    const {
      plate_number,
      model,
      color,
      year,
      max_passengers,
      vehicle_type_id,
      vehicle_pic_url,
      booking_type_id,
    } = req.body;

    if (!plate_number?.trim() || !model?.trim()) {
      return res.status(400).json({
        successful: false,
        message: 'plate_number and model are required',
      });
    }

    if (vehicle_type_id != null) {
      const vt = await prisma.vehicle_types.findUnique({
        where: { vehicle_type_id: Number(vehicle_type_id) },
      });
      if (!vt) {
        return res.status(400).json({ successful: false, message: 'Invalid vehicle_type_id' });
      }
    }

    const vehicle = await prisma.vehicle.create({
      data: {
        driver_id: profile.driver_profile_id,
        plate_number: String(plate_number).trim(),
        model: String(model).trim(),
        color: color?.trim() || null,
        year: year != null ? Number(year) : null,
        max_passengers: max_passengers != null ? Number(max_passengers) : null,
        vehicle_type_id: vehicle_type_id != null ? Number(vehicle_type_id) : null,
        vehicle_pic_url: vehicle_pic_url || null,
        booking_type_id: booking_type_id != null ? Number(booking_type_id) : null,
      },
      include: vehicleInclude,
    });

    return res.status(201).json({ successful: true, data: vehicle });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to create vehicle' });
  }
});

/* UPDATE VEHICLE */
router.put('/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = Number(req.params.vehicle_id);
    if (Number.isNaN(vehicle_id)) {
      return res.status(400).json({ error: 'vehicle_id must be a number' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const existing = await prisma.vehicle.findUnique({ where: { vehicle_id } });
    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Vehicle not found' });
    }

    const denied = await assertVehicleOwnedByUser(existing, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    const {
      plate_number,
      model,
      color,
      year,
      max_passengers,
      vehicle_type_id,
      vehicle_pic_url,
      booking_type_id,
    } = req.body;

    if (vehicle_type_id != null) {
      const vt = await prisma.vehicle_types.findUnique({
        where: { vehicle_type_id: Number(vehicle_type_id) },
      });
      if (!vt) {
        return res.status(400).json({ successful: false, message: 'Invalid vehicle_type_id' });
      }
    }

    const updated = await prisma.vehicle.update({
      where: { vehicle_id },
      data: {
        plate_number: plate_number != null ? String(plate_number).trim() : existing.plate_number,
        model: model != null ? String(model).trim() : existing.model,
        color: color !== undefined ? (color?.trim() || null) : existing.color,
        year: year !== undefined ? (year != null ? Number(year) : null) : existing.year,
        max_passengers:
          max_passengers !== undefined
            ? (max_passengers != null ? Number(max_passengers) : null)
            : existing.max_passengers,
        vehicle_type_id:
          vehicle_type_id !== undefined
            ? (vehicle_type_id != null ? Number(vehicle_type_id) : null)
            : existing.vehicle_type_id,
        vehicle_pic_url:
          vehicle_pic_url !== undefined ? vehicle_pic_url || null : existing.vehicle_pic_url,
        booking_type_id:
          booking_type_id !== undefined
            ? (booking_type_id != null ? Number(booking_type_id) : null)
            : existing.booking_type_id,
      },
      include: vehicleInclude,
    });

    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to update vehicle' });
  }
});

/* DELETE VEHICLE */
router.delete('/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = Number(req.params.vehicle_id);
    if (Number.isNaN(vehicle_id)) {
      return res.status(400).json({ error: 'vehicle_id must be a number' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const existing = await prisma.vehicle.findUnique({
      where: { vehicle_id },
      include: { active_trip: { where: { ended_at: null }, take: 1 } },
    });
    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Vehicle not found' });
    }

    const denied = await assertVehicleOwnedByUser(existing, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    if (existing.active_trip?.length > 0) {
      return res.status(409).json({
        successful: false,
        message: 'Cannot delete a vehicle assigned to an active trip',
      });
    }

    await prisma.vehicle.delete({ where: { vehicle_id } });

    return res.json({ successful: true, message: 'Vehicle deleted successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to delete vehicle' });
  }
});

/* CREATE AUTOMOTIVE VEHICLE — no driver profile required (for automotive providers) */
router.post('/automotive', authenticateToken, automotiveUpload.fields([
  { name: 'images', maxCount: 8 },
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const {
      vehicle_type,
      price,
      is_negotiable,
      make,
      model,
      year,
      mileage,
      fuel,
      transmission,
      engine,
      color,
      condition,
      description,
    } = req.body;

    // Validate required fields
    // For bicycles, fuel, mileage, transmission, and engine are optional
    const isBicycle = vehicle_type?.toLowerCase() === 'bicycles';
    if (!vehicle_type?.trim() || !make?.trim() || !model?.trim() || !year || !price || !color?.trim() || !condition?.trim()) {
      return res.status(400).json({
        successful: false,
        message: 'vehicle_type, make, model, year, price, color, and condition are required',
      });
    }
    if (!isBicycle && (!mileage || !fuel?.trim() || !transmission?.trim() || !engine?.trim())) {
      return res.status(400).json({
        successful: false,
        message: 'mileage, fuel, transmission, and engine are required for this vehicle type',
      });
    }

    // Upload images
    const imageUrls = [];
    if (req.files && req.files.images) {
      for (const file of req.files.images) {
        const detectedType = sniffImageType(file.buffer);
        if (!detectedType) {
          return res.status(400).json({ successful: false, message: 'Invalid image file' });
        }
        const objectName = buildObjectName(file.originalname);
        const url = await storeImageBuffer({
          container: VEHICLE_IMAGES_CONTAINER,
          dirName: 'vehicles',
          objectName,
          buffer: file.buffer,
          contentType: detectedType,
        });
        imageUrls.push(url);
      }
    }

    // Upload video
    let videoUrl = null;
    if (req.files && req.files.video && req.files.video[0]) {
      const videoFile = req.files.video[0];
      const objectName = buildObjectName(videoFile.originalname);
      try {
        videoUrl = await uploadPublicBlob(VEHICLE_VIDEOS_CONTAINER, objectName, videoFile.buffer, videoFile.mimetype);
      } catch (error) {
        console.error('Video upload failed:', error);
        return res.status(500).json({ successful: false, message: 'Failed to upload video' });
      }
    }

    // Create vehicle without driver profile (for automotive providers)
    const vehicle = await prisma.vehicle.create({
      data: {
        driver_id: null, // No driver profile required for automotive providers
        user_id: userId, // Store the user who created this vehicle
        plate_number: null,
        model: String(model).trim(),
        make: String(make).trim(),
        color: String(color).trim(),
        year: Number(year),
        max_passengers: null,
        vehicle_type_id: null,
        vehicle_pic_url: imageUrls.length > 0 ? imageUrls[0] : null,
        booking_type_id: null,
        price: price != null ? Number(price) : null,
        is_negotiable: is_negotiable === true || is_negotiable === 'true',
        mileage: mileage != null ? Number(mileage) : null,
        // fuel/transmission are optional for bicycles — must fall back to null like mileage,
        // not String(undefined).trim(), which stored the literal text "undefined".
        fuel: fuel ? String(fuel).trim() : null,
        transmission: transmission ? String(transmission).trim() : null,
        engine: engine ? String(engine).trim() : null,
        condition: String(condition).trim(),
        vehicle_type: String(vehicle_type).trim(),
        description: description ? String(description).trim() : null,
        images: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
        video_url: videoUrl,
      },
      include: vehicleInclude,
    });

    return res.status(201).json({ successful: true, data: vehicle });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to create automotive vehicle' });
  }
});

// Multer config for the bulk-import CSV itself — small, text only, not the media files, which
// are never uploaded by the client here (they're external URLs the server downloads).
const bulkCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB is generous for a few hundred rows of text
});

const BULK_REQUIRED_COLUMNS = ['vehicle_type', 'make', 'model', 'year', 'price', 'color', 'condition'];
// Runs synchronously in one request (no job queue in this backend) — capped so a single import
// can't turn into an open-ended request; sellers with more vehicles split into multiple CSVs.
const BULK_MAX_ROWS = 50;
const BULK_MAX_IMAGES_PER_VEHICLE = 8;
const BULK_MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function csvCell(header, row, name) {
  const idx = header.indexOf(name);
  return idx === -1 ? '' : String(row[idx] ?? '').trim();
}

/* BULK CREATE AUTOMOTIVE VEHICLES — CSV import. Each row is one vehicle; the `images` and
   `video` columns hold comma-separated external URLs that we download and re-host on our own
   Azure Blob Storage (never store/serve a third-party URL directly). Runs row-by-row in one
   request; progress is pushed live over the seller's `user-<id>` socket room (keyed by a
   client-generated job_id) since the HTTP response only resolves once every row is done. */
router.post('/automotive/bulk-import', authenticateToken, bulkCsvUpload.single('csv'), async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    if (!req.file) {
      return res.status(400).json({ successful: false, message: 'CSV file is required (field name "csv")' });
    }

    const jobId = req.body.job_id || null;
    const io = req.app.get('io');
    const emitProgress = (payload) => {
      if (!jobId) return;
      try { io?.to(`user-${userId}`).emit('vehicle:bulk-import:progress', { job_id: jobId, ...payload }); }
      catch (e) { console.error('[bulk-import] progress emit failed:', e.message); }
    };

    const rows = parseCsv(req.file.buffer.toString('utf-8'));
    if (rows.length < 2) {
      return res.status(400).json({ successful: false, message: 'CSV must have a header row plus at least one vehicle row' });
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const missingColumns = BULK_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    if (missingColumns.length) {
      return res.status(400).json({
        successful: false,
        message: `CSV is missing required column(s): ${missingColumns.join(', ')}`,
      });
    }

    const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell.trim() !== ''));
    if (dataRows.length === 0) {
      return res.status(400).json({ successful: false, message: 'CSV has no vehicle rows' });
    }
    if (dataRows.length > BULK_MAX_ROWS) {
      return res.status(400).json({
        successful: false,
        message: `Too many rows (${dataRows.length}) — split into batches of ${BULK_MAX_ROWS} or fewer`,
      });
    }

    const results = [];
    let created = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // +1 for the header row, +1 to make it 1-indexed like a spreadsheet
      const cell = (name) => csvCell(header, row, name);
      const label = `${cell('make')} ${cell('model')}`.trim() || `Row ${rowNum}`;
      emitProgress({ row: rowNum, total: dataRows.length, status: 'processing', label });

      try {
        const vehicle_type = cell('vehicle_type');
        const make = cell('make');
        const model = cell('model');
        const year = cell('year');
        const price = cell('price');
        const color = cell('color');
        const condition = cell('condition');
        const mileage = cell('mileage');
        const fuel = cell('fuel');
        const transmission = cell('transmission');
        const engine = cell('engine');
        const description = cell('description');
        const is_negotiable = /^(true|yes|1)$/i.test(cell('is_negotiable'));
        const isBicycle = vehicle_type.toLowerCase() === 'bicycles';

        if (!vehicle_type || !make || !model || !year || !price || !color || !condition) {
          throw new Error('Missing one of: vehicle_type, make, model, year, price, color, condition');
        }
        if (!isBicycle && (!mileage || !fuel || !transmission || !engine)) {
          throw new Error('mileage, fuel, transmission, and engine are required for this vehicle type');
        }
        if (Number.isNaN(Number(year)) || Number.isNaN(Number(price))) {
          throw new Error('year and price must be numeric');
        }

        // Re-importing the same CSV (or one that overlaps a prior import) shouldn't create
        // duplicate listings. There's no VIN/unique identifier on `vehicle`, so match on the
        // combination least likely to coincidentally collide between two genuinely different
        // cars, scoped to this seller. This also catches a duplicate row within the same file,
        // since earlier rows are already committed by the time a later row is checked.
        const duplicate = await prisma.vehicle.findFirst({
          where: {
            user_id: userId,
            driver_id: null,
            make: { equals: make, mode: 'insensitive' },
            model: { equals: model, mode: 'insensitive' },
            color: { equals: color, mode: 'insensitive' },
            year: Number(year),
            mileage: mileage ? Number(mileage) : null,
          },
          select: { vehicle_id: true },
        });
        if (duplicate) {
          const rowResult = {
            row: rowNum, status: 'skipped', vehicle_id: duplicate.vehicle_id, label,
            message: 'Duplicate of an existing listing (same make, model, year, color, and mileage) — skipped.',
          };
          results.push(rowResult);
          emitProgress({ ...rowResult, total: dataRows.length });
          continue;
        }

        // Media is best-effort: a broken image/video link doesn't fail the whole row, it's just
        // skipped and reported back so the seller can fix that one link later.
        const mediaWarnings = [];

        const allImageSources = cell('images').split(',').map((s) => s.trim()).filter(Boolean);
        const imageSources = allImageSources.slice(0, BULK_MAX_IMAGES_PER_VEHICLE);
        if (allImageSources.length > BULK_MAX_IMAGES_PER_VEHICLE) {
          mediaWarnings.push(`Only the first ${BULK_MAX_IMAGES_PER_VEHICLE} images are used; ${allImageSources.length - BULK_MAX_IMAGES_PER_VEHICLE} extra image(s) were ignored.`);
        }
        const imageUrls = [];
        for (const src of imageSources) {
          try {
            const buf = await downloadImageBuffer(src);
            const detectedType = sniffImageType(buf);
            if (!detectedType) throw new Error('not a recognised image format');
            const objectName = buildObjectName(src.split('/').pop() || 'image');
            const url = await storeImageBuffer({
              container: VEHICLE_IMAGES_CONTAINER,
              dirName: 'vehicles',
              objectName,
              buffer: buf,
              contentType: detectedType,
            });
            imageUrls.push(url);
          } catch (e) {
            mediaWarnings.push(`Image skipped (${src}): ${e.message}`);
          }
        }

        let videoUrl = null;
        const videoSrc = cell('video').split(',')[0]?.trim(); // one video per vehicle; ignore extras
        if (videoSrc) {
          try {
            const objectName = buildObjectName(videoSrc.split('/').pop() || 'video');
            videoUrl = await uploadUntrustedUrlToBlob(VEHICLE_VIDEOS_CONTAINER, objectName, videoSrc, {
              expectedTypePrefix: 'video/',
              maxBytes: BULK_MAX_VIDEO_BYTES,
            });
          } catch (e) {
            mediaWarnings.push(`Video skipped: ${e.message}`);
          }
        }

        const vehicle = await prisma.vehicle.create({
          data: {
            driver_id: null,
            user_id: userId,
            plate_number: null,
            model, make, color,
            year: Number(year),
            max_passengers: null,
            vehicle_type_id: null,
            vehicle_pic_url: imageUrls[0] || null,
            booking_type_id: null,
            price: Number(price),
            is_negotiable,
            mileage: mileage ? Number(mileage) : null,
            fuel: fuel || null,
            transmission: transmission || null,
            engine: engine || null,
            condition,
            vehicle_type,
            description: description || null,
            images: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
            video_url: videoUrl,
          },
        });

        created++;
        const rowResult = { row: rowNum, status: 'success', vehicle_id: vehicle.vehicle_id, label, warnings: mediaWarnings };
        results.push(rowResult);
        emitProgress({ ...rowResult, total: dataRows.length });
      } catch (err) {
        const rowResult = { row: rowNum, status: 'error', label, message: err.message };
        results.push(rowResult);
        emitProgress({ ...rowResult, total: dataRows.length });
      }
    }

    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'error').length;
    emitProgress({ status: 'done', total: dataRows.length, created, skipped });

    // A row is only a real failure if it errored — an all-duplicates run correctly did nothing
    // and shouldn't read as a failed import.
    const status = created > 0 ? 201 : failed > 0 ? 400 : 200;
    return res.status(status).json({
      successful: status !== 400,
      message: `${created} of ${dataRows.length} vehicle(s) created${skipped > 0 ? `, ${skipped} duplicate(s) skipped` : ''}`,
      data: { created, skipped, total: dataRows.length, results },
    });
  } catch (err) {
    console.error('Bulk vehicle import failed:', err);
    return res.status(500).json({ successful: false, message: 'Failed to bulk import vehicles' });
  }
});

/* UPDATE AUTOMOTIVE VEHICLE — with file upload support */
router.put('/automotive/:vehicle_id', authenticateToken, automotiveUpload.fields([
  { name: 'images', maxCount: 8 },
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  try {
    const vehicle_id = Number(req.params.vehicle_id);
    if (Number.isNaN(vehicle_id)) {
      return res.status(400).json({ error: 'vehicle_id must be a number' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const existing = await prisma.vehicle.findUnique({ where: { vehicle_id } });
    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Vehicle not found' });
    }

    const denied = await assertVehicleOwnedByUser(existing, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    const {
      vehicle_type,
      price,
      is_negotiable,
      make,
      model,
      year,
      mileage,
      fuel,
      transmission,
      engine,
      color,
      condition,
      description,
    } = req.body;

    // Validate required fields
    // For bicycles, fuel, mileage, transmission, and engine are optional
    const isBicycle = vehicle_type?.toLowerCase() === 'bicycles';
    if (!vehicle_type?.trim() || !make?.trim() || !model?.trim() || !year || !price || !color?.trim() || !condition?.trim()) {
      return res.status(400).json({
        successful: false,
        message: 'vehicle_type, make, model, year, price, color, and condition are required',
      });
    }
    if (!isBicycle && (!mileage || !fuel?.trim() || !transmission?.trim() || !engine?.trim())) {
      return res.status(400).json({
        successful: false,
        message: 'mileage, fuel, transmission, and engine are required for this vehicle type',
      });
    }

    // Handle image uploads
    let imageUrls = [];
    if (req.files && req.files.images && req.files.images.length > 0) {
      // New images uploaded
      for (const file of req.files.images) {
        const detectedType = sniffImageType(file.buffer);
        if (!detectedType) {
          return res.status(400).json({ successful: false, message: 'Invalid image file' });
        }
        const objectName = buildObjectName(file.originalname);
        const url = await storeImageBuffer({
          container: VEHICLE_IMAGES_CONTAINER,
          dirName: 'vehicles',
          objectName,
          buffer: file.buffer,
          contentType: detectedType,
        });
        imageUrls.push(url);
      }
    } else if (req.body.existing_images) {
      // Keep existing images from frontend
      try {
        imageUrls = JSON.parse(req.body.existing_images);
      } catch (e) {
        return res.status(400).json({ successful: false, message: 'Invalid existing_images format' });
      }
    } else if (existing.images) {
      // Keep existing images from database
      imageUrls = JSON.parse(existing.images);
    }

    // Handle video upload
    let videoUrl = existing.video_url;
    if (req.files && req.files.video && req.files.video[0]) {
      // New video uploaded
      const videoFile = req.files.video[0];
      const objectName = buildObjectName(videoFile.originalname);
      try {
        videoUrl = await uploadPublicBlob(VEHICLE_VIDEOS_CONTAINER, objectName, videoFile.buffer, videoFile.mimetype);
      } catch (error) {
        console.error('Video upload failed:', error);
        return res.status(500).json({ successful: false, message: 'Failed to upload video' });
      }
    } else if (req.body.keep_existing_video === 'true') {
      // Keep existing video
      videoUrl = existing.video_url;
    } else {
      // No new video and not keeping existing - remove it
      videoUrl = null;
    }

    // Update vehicle
    const vehicle = await prisma.vehicle.update({
      where: { vehicle_id },
      data: {
        model: String(model).trim(),
        make: String(make).trim(),
        color: String(color).trim(),
        year: Number(year),
        price: price != null ? Number(price) : null,
        is_negotiable: is_negotiable !== undefined ? (is_negotiable === true || is_negotiable === 'true') : existing.is_negotiable,
        mileage: mileage != null ? Number(mileage) : null,
        // fuel/transmission are optional for bicycles — must fall back to null like mileage,
        // not String(undefined).trim(), which stored the literal text "undefined".
        fuel: fuel ? String(fuel).trim() : null,
        transmission: transmission ? String(transmission).trim() : null,
        engine: engine !== undefined ? (engine ? String(engine).trim() : null) : existing.engine,
        condition: String(condition).trim(),
        vehicle_type: String(vehicle_type).trim(),
        description: description ? String(description).trim() : null,
        images: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
        video_url: videoUrl,
      },
      include: vehicleInclude,
    });

    return res.json({ successful: true, data: vehicle });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to update automotive vehicle' });
  }
});

export default router;
