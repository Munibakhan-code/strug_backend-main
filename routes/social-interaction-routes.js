// routes/social-interaction-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { createNotification } from '../utils/notification-service.js'; // 

const router = express.Router();

/**
 * 1. TOGGLE LIKE (Reaction) with Notification
 */
// router.post('/like/:post_id', authenticateToken, async (req, res) => {
//     try {
//         const social_post_id = parseInt(req.params.post_id);
//         const profile_id = req.user?.profile_id;
//         const io = req.app.get('io');

//         if (isNaN(social_post_id)) {
//             return res.status(400).json({ error: "Invalid post_id string or missing parameter" });
//         }

//         if (!profile_id) {
//             return res.status(400).json({ error: "Profile not found in token authentication context" });
//         }

//         // Check if interaction record already exists for this profile and post
//         const existing = await prisma.social_interactions.findFirst({
//             where: { social_post_id, profile_id, reaction_type: 'like' }
//         });

//         if (existing) {
//             // Remove like (Unlike action)
//             await prisma.social_interactions.delete({ 
//                 where: { interaction_id: existing.interaction_id } 
//             });
//             return res.json({ successful: true, action: "unliked" });
//         } else {
//             // Insert like record
//             await prisma.social_interactions.create({
//                 data: { 
//                     social_post_id, 
//                     profile_id, 
//                     reaction_type: 'like' 
//                 }
//             });

//             // Post creator tracking for notifications
//             const post = await prisma.social_feed.findUnique({ 
//                 where: { social_post_id }, 
//                 select: { profile_id: true } 
//             });

//             if (post && post.profile_id !== profile_id) {
//                 try {
//                     await createNotification(io, {
//                         receiver_id: post.profile_id,
//                         sender_id: profile_id,
//                         type: 'LIKE',
//                         target_id: social_post_id
//                     });
//                 } catch (notifErr) {
//                     console.error("⚠️ Socket Notification non-blocking failure:", notifErr.message);
//                 }
//             }

//             return res.json({ successful: true, action: "liked" });
//         }
//     } catch (err) {
//         console.error("❌ Like Toggle Engine Error:", err.message);
//         res.status(500).json({ successful: false, message: 'Internal server error' });
//     }
// });

// /**
//  * 2. TOGGLE BOOKMARK (Save Post)
//  */
// router.post('/bookmark/:post_id', authenticateToken, async (req, res) => {
//     try {
//         const social_post_id = parseInt(req.params.post_id);
//         const profile_id = req.user.profile_id;

//         const existing = await prisma.social_bookmark.findUnique({
//             where: { profile_id_social_post_id: { profile_id, social_post_id } }
//         });

//         if (existing) {
//             await prisma.social_bookmark.delete({ where: { bookmark_id: existing.bookmark_id } });
//             return res.json({ successful: true, action: "unsaved" });
//         } else {
//             await prisma.social_bookmark.create({
//                 data: { profile_id, social_post_id }
//             });
//             return res.json({ successful: true, action: "saved" });
//         }
//     } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
// });

/**
 * 3. GET MY SAVED POSTS
 */
router.get('/bookmarks/me', authenticateToken, async (req, res) => {
    try {
        const bookmarks = await prisma.social_bookmark.findMany({
            where: { profile_id: req.user.profile_id },
            include: { social_post: { include: { social_media_attachments: true, social_profile: true } } },
            orderBy: { created_at: 'desc' }
        });
        res.json({ successful: true, data: bookmarks.map(b => b.social_post) });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 4. SHARE POST — persists a share interaction
 */
router.post('/share/:post_id', authenticateToken, async (req, res) => {
    try {
        const social_post_id = parseInt(req.params.post_id);
        const profile_id = req.user.profile_id;
        if (!profile_id) return res.status(400).json({ message: "Profile not found" });

        const existing = await prisma.social_interactions.findFirst({
            where: { social_post_id, profile_id, reaction_type: 'share' }
        });

        if (!existing) {
            await prisma.social_interactions.create({
                data: { social_post_id, profile_id, reaction_type: 'share' }
            });
        }

        const count = await prisma.social_interactions.count({
            where: { social_post_id, reaction_type: 'share' }
        });

        return res.json({ successful: true, share_count: count });
    } catch (err) {
        console.error("Share Error:", err.message);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;