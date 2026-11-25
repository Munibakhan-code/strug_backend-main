import path from 'path';
import fs from 'fs';
import { uploadPublicBlob, isAzureStorageConfigured } from './azure-storage.js';
import { safeFetchBuffer } from './ssrf-guard.js';

const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Download an image from a user-supplied URL into a buffer, ready for the same
 * sniffImageType()/storeImageBuffer() path a direct upload goes through.
 * Uses ssrf-guard (#1287): resolve public IPs, pin connection, no redirects.
 */
export async function downloadImageBuffer(url, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
    return safeFetchBuffer(url, { maxBytes, timeout: 30_000 });
}

// Script-free raster formats only (same policy as photo-routes.js): SVG can carry
// inline <script> and these blobs are served from a public origin, so it would be
// a stored-XSS vector. The stored MIME is derived from magic bytes, never trusted
// from the client.
export function sniffImageType(buf) {
    if (!buf || buf.length < 12) return null;
    const starts = (sig) => sig.every((b, i) => buf[i] === b);
    if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    // WEBP = "RIFF"...."WEBP"
    if (starts([0x52, 0x49, 0x46, 0x46]) &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return null;
}

// Unique, collision-safe object name. Date.now is fine — these are unique object
// keys, not security tokens.
export function buildObjectName(originalname) {
    const safeName = (originalname || 'image').replace(/[^\w.\-]+/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${Date.now()}-${rand}-${safeName}`;
}

/**
 * Store an image buffer durably and return its public URL.
 * Preferred path is Azure Blob Storage; local disk under uploads/<dirName> is the
 * dev / outage fallback (the returned relative /uploads path resolves against the
 * API origin, same contract as photo-routes.js).
 */
export async function storeImageBuffer({ container, dirName, objectName, buffer, contentType }) {
    if (isAzureStorageConfigured()) {
        try {
            return await uploadPublicBlob(container, objectName, buffer, contentType);
        } catch (error) {
            console.error(`Blob upload to "${container}" failed, falling back to disk:`, error);
        }
    }
    const uploadDir = path.join('uploads', dirName);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, objectName), buffer);
    return `/uploads/${dirName}/${objectName}`;
}
