// workers/townhall-media-cleanup.js
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from '../utils/prisma-client.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from '../utils/cron-lock.js';

/**
 * Extracts pure filename from any URL or Path
 * Example: "https://storage.blob.core.windows.net/container/1234_abc.webp?sv=2021" -> "1234_abc.webp"
 */
function extractFilename(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const cleanUrl = url.split('?')[0]; // Remove SAS/Query params
        const parts = cleanUrl.split('/');
        const filename = parts[parts.length - 1];
        return filename && filename.includes('.') ? filename.trim().toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * PRODUCTION-GRADE SAFE MEDIA GARBAGE COLLECTOR
 */
export async function runOrphanedMediaCleanup() {
    console.log("🧹 [Media Cleanup] Starting safe orphaned media inspection...");

    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_TOWNHALL_POSTS_CONTAINER || "townhall-posts";

    if (!connectionString) {
        console.warn("⚠️ [Media Cleanup] AZURE_STORAGE_CONNECTION_STRING not set. Bypassing.");
        return;
    }

    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);

        if (!(await containerClient.exists())) {
            console.warn(`⚠️ [Media Cleanup] Container '${containerName}' does not exist.`);
            return;
        }

        // =========================================================================
        // STEP 1: Build Global Whitelist of Active Filenames from ALL Tables
        // =========================================================================
        const [
            townhallPosts,
            socialAttachments,
            socialProfiles,
            storeProfiles,
            channels,
            videos
        ] = await Promise.all([
            prisma.town_hall_post.findMany({
                where: { OR: [{ media_url: { not: null } }, { thumbnail_url: { not: null } }] },
                select: { media_url: true, thumbnail_url: true, hls_url: true }
            }).catch(() => []),

            prisma.social_media_attachments.findMany({
                where: { media_url: { not: null } },
                select: { media_url: true }
            }).catch(() => []),

            prisma.social_profile.findMany({
                where: { OR: [{ profile_pic_url: { not: null } }, { banner_url: { not: null } }] },
                select: { profile_pic_url: true, banner_url: true }
            }).catch(() => []),

            prisma.store_profile.findMany({
                where: { OR: [{ profile_pic_url: { not: null } }, { cover_url: { not: null } }, { banner_url: { not: null } }] },
                select: { profile_pic_url: true, cover_url: true, banner_url: true }
            }).catch(() => []),

            prisma.channel.findMany({
                where: { OR: [{ profile_pic_url: { not: null } }, { banner_url: { not: null } }] },
                select: { profile_pic_url: true, banner_url: true }
            }).catch(() => []),

            prisma.video.findMany({
                where: { OR: [{ raw_video_url: { not: null } }, { thumbnail_url: { not: null } }] },
                select: { raw_video_url: true, thumbnail_url: true, hls_url: true }
            }).catch(() => [])
        ]);

        const activeWhitelist = new Set();

        const addIfValid = (url) => {
            const fn = extractFilename(url);
            if (fn) activeWhitelist.add(fn);
        };

        townhallPosts.forEach(p => { addIfValid(p.media_url); addIfValid(p.thumbnail_url); addIfValid(p.hls_url); });
        socialAttachments.forEach(a => addIfValid(a.media_url));
        socialProfiles.forEach(p => { addIfValid(p.profile_pic_url); addIfValid(p.banner_url); });
        storeProfiles.forEach(s => { addIfValid(s.profile_pic_url); addIfValid(s.cover_url); addIfValid(s.banner_url); });
        channels.forEach(c => { addIfValid(c.profile_pic_url); addIfValid(c.banner_url); });
        videos.forEach(v => { addIfValid(v.raw_video_url); addIfValid(v.thumbnail_url); addIfValid(v.hls_url); });

        console.log(`   [Whitelist] Protected ${activeWhitelist.size} active files across database.`);

        // Sanity Check: If DB fetched 0 records (e.g. DB connection glitch), ABORT to prevent accidental wipe
        if (activeWhitelist.size === 0) {
            console.error("⛔ [Media Cleanup] Whitelist is EMPTY. Possible DB connection error. ABORTING.");
            return;
        }

        // =========================================================================
        // STEP 2: Fetch Azure Blobs & Identify Genuinely Orphaned Files
        // =========================================================================
        const azureBlobs = [];
        for await (const blob of containerClient.listBlobsFlat()) {
            azureBlobs.push({
                name: blob.name,
                filename: extractFilename(blob.name),
                url: `${containerClient.url}/${blob.name}`,
                createdOn: blob.properties.createdOn
            });
        }

        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const cutoffDate = new Date(Date.now() - SEVEN_DAYS_MS);

        const candidatesForDeletion = azureBlobs.filter(blob => {
            const isOrphaned = !activeWhitelist.has(blob.filename);
            const isOlderThan7Days = blob.createdOn < cutoffDate;
            return isOrphaned && isOlderThan7Days;
        });

        console.log(`   Found ${candidatesForDeletion.length} orphaned files older than 7 days.`);

        // =========================================================================
        // STEP 3: Circuit Breaker Protection (Max 30 deletions per run)
        // =========================================================================
        const MAX_DELETE_LIMIT = 30;
        if (candidatesForDeletion.length > MAX_DELETE_LIMIT) {
            console.warn(`⚠️ [Circuit Breaker] Deletion candidate count (${candidatesForDeletion.length}) exceeds safety threshold (${MAX_DELETE_LIMIT}). Capping execution.`);
        }

        const safeDeleteBatch = candidatesForDeletion.slice(0, MAX_DELETE_LIMIT);
        let successCount = 0;

        for (const file of safeDeleteBatch) {
            console.log(`🗑️ [Purging Orphaned Media] Deleting: ${file.name}`);
            try {
                await deleteAzureBlob(containerName, file.url);
                successCount++;
            } catch (err) {
                console.error(`❌ Failed to delete ${file.name}:`, err.message);
            }
        }

        console.log(`✅ [Media Cleanup Completed] Successfully purged ${successCount} orphaned files.`);

    } catch (err) {
        console.error("❌ [Media Cleanup Critical Failure]:", err.message);
    }
}

/**
 * Cron Registration: Runs ONCE daily at 3:00 AM
 */
export function startMediaCleanupCron() {
    scheduleCron('townhall-media-cleanup', '0 3 * * *', () => {
        runOrphanedMediaCleanup().catch(err => {
            console.error('[Cron Runner Error]:', err.message);
        });
    });
    console.log("⏰ [Media Cleanup Cron] Scheduled daily for 3:00 AM.");
}