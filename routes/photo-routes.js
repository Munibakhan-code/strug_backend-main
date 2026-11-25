import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { BlobServiceClient } from '@azure/storage-blob';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Script-free raster formats only. SVG is excluded on purpose: it can carry
// inline <script>, and these blobs are served from a public origin, so an SVG
// "image" would be a stored-XSS vector. The MIME we store is derived from the
// file's magic bytes below — never trusted from the client.
const SAFE_IMAGE_TYPES = {
    'image/jpeg': [[0xff, 0xd8, 0xff]],
    'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    'image/gif': [[0x47, 0x49, 0x46, 0x38]],
    'image/webp': [[0x52, 0x49, 0x46, 0x46]], // "RIFF" (….WEBP checked below)
};

// Sniff the real image type from the buffer's magic bytes. Returns a safe MIME
// string or null if the bytes don't match an allowed raster format.
function sniffImageType(buf) {
    if (!buf || buf.length < 12) return null;
    const starts = (sig) => sig.every((b, i) => buf[i] === b);
    if (starts(SAFE_IMAGE_TYPES['image/jpeg'][0])) return 'image/jpeg';
    if (starts(SAFE_IMAGE_TYPES['image/png'][0])) return 'image/png';
    if (starts(SAFE_IMAGE_TYPES['image/gif'][0])) return 'image/gif';
    // WEBP = "RIFF"...."WEBP"
    if (starts(SAFE_IMAGE_TYPES['image/webp'][0]) &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return null;
}
const UPLOAD_DIR = path.join('uploads', 'photos');

// Durable storage: uploaded photos go to a public Azure Blob container so they
// survive container redeploys/replicas. The old behaviour wrote to the API
// container's local disk (UPLOAD_DIR), which is ephemeral — files vanished on
// every deploy, leaving listing/menu/product images as broken links. We keep the
// disk path as a fallback for local dev where Azure isn't configured.
const PHOTOS_CONTAINER = process.env.AZURE_PHOTOS_CONTAINER || 'photos';
const AZURE_ENABLED = Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);

// Local-dev fallback dir (only used when Azure is not configured).
if (!AZURE_ENABLED && !fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* =========================
   Multer Configuration
========================= */

// Buffer the file in memory so we can stream it straight to blob storage.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        // 10MB — property/menu/product photos straight off a phone routinely run
        // 3-8MB, so the old 2MB cap silently 413'd most real listing uploads (#44),
        // leaving listings imageless. Still bounded to keep blob storage sane.
        fileSize: 10 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        // Coarse first pass on the declared type (the buffer's magic bytes are the
        // real gate, checked after upload). Reject SVG and anything non-raster here.
        if (!Object.prototype.hasOwnProperty.call(SAFE_IMAGE_TYPES, file.mimetype)) {
            return cb(new Error('Only JPEG, PNG, GIF or WEBP images are allowed'));
        }
        cb(null, true);
    },
});

/* =========================
   Multer Error Wrapper
========================= */

const uploadSingleImage = (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({
                    error: 'Image size must be less than 10MB',
                });
            }

            return res.status(400).json({
                error: err.message,
            });
        }

        if (err) {
            return res.status(400).json({
                error: err.message,
            });
        }

        next();
    });
};

// Unique, collision-safe blob/file name. Date.now is fine here — these are not
// security tokens, just unique object keys.
function buildObjectName(originalname) {
    const safeName = (originalname || 'image').replace(/[^\w.\-]+/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${Date.now()}-${rand}-${safeName}`;
}

/* =========================
   Upload Photo
========================= */

router.post('/', authenticateToken, uploadSingleImage, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            error: 'No file uploaded',
        });
    }

    // Verify the actual bytes are a safe raster image and derive the content type
    // server-side — never trust the client-declared mimetype (it sets the blob's
    // Content-Type, which a forged SVG/HTML payload could abuse for stored XSS).
    const contentType = sniffImageType(req.file.buffer);
    if (!contentType) {
        return res.status(400).json({ error: 'File is not a valid JPEG, PNG, GIF or WEBP image' });
    }

    const objectName = buildObjectName(req.file.originalname);

    // Preferred path: durable public blob storage.
    if (AZURE_ENABLED) {
        try {
            const url = await uploadPublicBlob(
                PHOTOS_CONTAINER,
                objectName,
                req.file.buffer,
                contentType,
            );
            return res.status(201).json({
                url,
                message: 'Photo uploaded successfully',
            });
        } catch (error) {
            console.error('Photo blob upload error:', error);
            // Fall through to disk so an upload never hard-fails on a transient
            // storage error (the URL will still resolve via the API origin).
        }
    }

    // Fallback: local disk (dev, or Azure outage). Returns a relative /uploads
    // path; the frontend resolves it against the API origin.
    try {
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const diskPath = path.join(UPLOAD_DIR, objectName);
        fs.writeFileSync(diskPath, req.file.buffer);
        return res.status(201).json({
            url: `/uploads/photos/${objectName}`,
            message: 'Photo uploaded successfully',
        });
    } catch (error) {
        console.error('Photo disk write error:', error);
        return res.status(500).json({ error: 'Failed to store photo' });
    }
});

/* =========================
   Delete Photo
========================= */

router.delete('/:fileName', authenticateToken, async (req, res) => {
    try {
        const { fileName } = req.params;

        if (!fileName) {
            return res.status(400).json({
                error: 'File name is required',
            });
        }

        // Prevent directory traversal — only ever operate on a bare object name.
        const safeFileName = path.basename(fileName);
        let removed = false;

        // Best-effort blob deletion (durable storage).
        if (AZURE_ENABLED) {
            try {
                const blobService = BlobServiceClient.fromConnectionString(
                    process.env.AZURE_STORAGE_CONNECTION_STRING,
                );
                const containerClient = blobService.getContainerClient(PHOTOS_CONTAINER);
                const result = await containerClient
                    .getBlockBlobClient(safeFileName)
                    .deleteIfExists();
                removed = removed || result.succeeded;
            } catch (error) {
                console.error('Photo blob deletion error:', error);
            }
        }

        // Best-effort disk deletion (fallback-stored files).
        const filePath = path.join(UPLOAD_DIR, safeFileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            removed = true;
        }

        if (!removed) {
            return res.status(404).json({
                error: 'Photo not found',
            });
        }

        res.status(200).json({
            message: 'Photo deleted successfully',
        });
    } catch (error) {
        console.error('Photo deletion error:', error);
        res.status(500).json({
            error: 'Failed to delete photo',
        });
    }
});

export default router;
