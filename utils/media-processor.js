// utils/media-processor.js
import sharp from 'sharp';

/**
 * Optimizes an incoming image buffer: resizes to max 1280px width
 * (without upscaling smaller images) and converts to WebP with 80% quality.
 * Falls back to original buffer on failure (fail-open strategy).
 * @param {Buffer} buffer 
 * @returns {Promise<Buffer>} Optimized WebP image buffer or original buffer on error
 */
export const optimizeImage = async (buffer) => {
    try {
        const image = sharp(buffer);
        const metadata = await image.metadata();

        let pipeline = image;

        // Production Upgrade: Resize only if wider than 1280px to save storage & bandwidth
        if (metadata.width && metadata.width > 1280) {
            pipeline = pipeline.resize({ 
                width: 1280, 
                withoutEnlargement: true // Prevent upscaling smaller images
            });
        }

        return await pipeline
            .webp({ quality: 80 }) 
            .toBuffer();
    } catch (err) {
        console.error("✨ [Media Pipeline] Image Optimization Failed, falling back to raw buffer:", err);
        return buffer; // Fail-open: return original raw buffer if processing fails
    }
};