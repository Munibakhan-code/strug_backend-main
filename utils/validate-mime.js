import { fileTypeFromBuffer } from 'file-type';

/**
 * Validates file buffer against an allowed MIME type list using magic bytes.
 * Throws an error if the type is missing or not in the allowed list.
 */
export async function validateMime(buffer, allowed) {
    const type = await fileTypeFromBuffer(buffer);
    if (!type || !allowed.includes(type.mime)) {
        throw Object.assign(new Error(`Invalid file type: ${type?.mime ?? 'unknown'}`), { status: 400 });
    }
    return type;
}

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
export const ALLOWED_MEDIA_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];
