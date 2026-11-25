import sharp from 'sharp';

const HEIC_MIME = new Set(['image/heic', 'image/heif']);

/**
 * Whether a detected MIME should be treated as HEIC/HEIF and converted.
 * @param {string} mime
 */
export function isHeicMime(mime) {
  return HEIC_MIME.has(String(mime || '').toLowerCase());
}

/**
 * Convert HEIC/HEIF buffers to JPEG so chat clients can render them.
 * Non-HEIC inputs are returned unchanged.
 * @param {Buffer} buffer
 * @param {string} mime
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string | null, converted: boolean }>}
 */
export async function normalizeChatImageUpload(buffer, mime) {
  const normalized = String(mime || '').toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : String(mime || '').toLowerCase();

  if (!isHeicMime(normalized)) {
    return { buffer, mime: normalized, ext: null, converted: false };
  }

  try {
    const out = await sharp(buffer).rotate().jpeg({ quality: 85 }).toBuffer();
    return { buffer: out, mime: 'image/jpeg', ext: 'jpg', converted: true };
  } catch (err) {
    const error = new Error(
      'Could not process HEIC/HEIF image. Convert to JPEG or PNG and try again.',
    );
    error.statusCode = 400;
    error.cause = err;
    throw error;
  }
}

export const HEIC_ALLOWED_MIMES = Object.freeze(['image/heic', 'image/heif']);
