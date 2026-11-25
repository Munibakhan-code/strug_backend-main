import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { isAzureStorageConfigured, uploadVideoStream } from '../utils/azure-storage.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        cb(new Error('ONLY_IMAGE_UPLOADS'));
    },
});

/** Multer middleware for a single image field (default `image`). */
export const handleLiveThumbUpload = (field = 'image') => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
        if (err) {
            if (err.message === 'ONLY_IMAGE_UPLOADS') {
                return res.status(400).json({ successful: false, message: 'Only image files are allowed.' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ successful: false, message: 'Image must be 5MB or smaller.' });
            }
            return res.status(400).json({ successful: false, message: 'Upload failed.' });
        }
        next();
    });

function publicBaseUrl(req) {
    const env = (process.env.PUBLIC_API_URL || process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
    if (env) return env;
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    return host ? `${proto}://${host}` : '';
}

/**
 * Upload a live session/VOD thumbnail to Azure (or local /uploads fallback).
 * @param {import('express').Request} req
 * @param {{ prefix: string, streamerId: number, entityId: number }} opts
 * @returns {Promise<string>} public image URL
 */
export async function storeLiveThumbnail(req, { prefix, streamerId, entityId }) {
    if (!req.file) {
        const e = new Error('NO_FILE');
        e.code = 'NO_FILE';
        throw e;
    }

    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const blobName = `${prefix}/${streamerId}/${entityId}-${Date.now()}.${ext}`;
    const container = process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails';

    if (isAzureStorageConfigured()) {
        return uploadVideoStream(container, blobName, req.file.buffer, req.file.mimetype, { access: 'blob' });
    }

    // Local/dev fallback when Azure is not configured.
    const absDir = path.join(process.cwd(), 'uploads', prefix, String(streamerId));
    await fs.mkdir(absDir, { recursive: true });
    const filename = `${entityId}-${Date.now()}.${ext}`;
    await fs.writeFile(path.join(absDir, filename), req.file.buffer);
    const base = publicBaseUrl(req);
    return `${base}/uploads/${prefix}/${streamerId}/${filename}`;
}
