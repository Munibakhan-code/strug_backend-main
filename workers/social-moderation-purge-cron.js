// workers/social-moderation-purge-cron.js
import prisma from '../utils/prisma-client.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { logCronError } from '../utils/cron-email.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from '../utils/cron-lock.js';

/**
 * Purges 'under_review' social posts that exceeded the 3-day (72h) admin review window.
 * Deletes Azure Blob media files, notifies the post author, and cascades DB deletion.
 */
export async function purgeExpiredModerationPosts() {
    try {
        // Calculate cutoff date: 3 Days (72 Hours) ago
        const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        // 1. Query expired pending moderation posts in safe batches
        const expiredPosts = await prisma.social_feed.findMany({
            where: {
                status: 'under_review',
                created_at: { lt: THREE_DAYS_AGO },
            },
            include: {
                social_profile: { select: { user_id: true } },
                social_media_attachments: true,
            },
            take: 100, // Batch limit to prevent memory spikes
        });

        if (expiredPosts.length === 0) return;

        console.log(`🧹 [Moderation Cron] Found ${expiredPosts.length} expired 'under_review' post(s) to purge...`);

        const container = process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts';

        for (const post of expiredPosts) {
            const postId = post.social_post_id;
            const userId = post.social_profile?.user_id;

            try {
                // A. Delete media files from Azure Blob Storage
                for (const att of post.social_media_attachments) {
                    if (att.media_url) {
                        await deleteAzureBlob(container, att.media_url).catch(() => {});
                    }
                }

                // B. Notify user about auto-purge expiration
                if (userId) {
                    await prisma.notification.create({
                        data: {
                            user_id: userId,
                            vertical: 'social',
                            type: 'social.moderation_expired',
                            urgency: 'ambient',
                            title: 'Post Removed (Moderation Timeout)',
                            body: 'Your video post was automatically removed as it exceeded the 3-day moderation review window.',
                            entity_type: 'social_post',
                            entity_id: postId,
                        },
                    }).catch(() => {});
                }

                // C. Cascade Database Transaction Delete
                await prisma.$transaction([
                    prisma.social_interactions.deleteMany({ where: { social_post_id: postId } }),
                    prisma.social_comments.deleteMany({ where: { social_post_id: postId } }),
                    prisma.social_bookmark.deleteMany({ where: { social_post_id: postId } }),
                    prisma.social_media_attachments.deleteMany({ where: { social_post_id: postId } }),
                    prisma.social_feed.delete({ where: { social_post_id: postId } }),
                ]);

                console.log(`✅ [Moderation Cron] Successfully purged expired Social Post #${postId}`);
            } catch (postErr) {
                console.error(`❌ [Moderation Cron] Failed to purge Post #${postId}:`, postErr.message);
            }
        }
    } catch (err) {
        console.error('❌ [Moderation Cron Error]:', err.message);
        throw err;
    }
}

/**
 * Initializes and schedules the cron service (Runs daily at Midnight 00:00 AM).
 */
export function startSocialModerationPurgeCron() {
    console.log('⏰ [Cron] Social Moderation Auto-Purge Cron initialized (Daily at 00:00 AM)');
    
    // Schedule: Daily at Midnight 00:00 AM ('0 0 * * *')
    scheduleCron('social-moderation-purge', '0 0 * * *', () => {
        purgeExpiredModerationPosts().catch((err) => logCronError('social-moderation-purge-cron', err));
    });
}