import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { countSocialFollowersForUserId } from '../utils/social-follow-counts.js';

const router = express.Router();

const scheduleSchema = z.object({
    title: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    scheduled_at: z.string().datetime()
});

const communityPostSchema = z.object({
    content: z.string().optional(),
    image_url: z.string().url().optional(),
    poll_options: z.array(z.string()).min(2).max(5).optional()
});

router.post('/schedule', authenticateToken, async (req, res, next) => {
    try {
        const validated = scheduleSchema.safeParse(req.body);
        if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id }
        });

        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const schedule = await prisma.live_stream_schedule.create({
            data: {
                streamer_id: profile.streamer_id,
                title: validated.data.title,
                description: validated.data.description,
                scheduled_at: new Date(validated.data.scheduled_at)
            }
        });

        return res.status(201).json({ successful: true, data: schedule });
    } catch (err) {
        next(err);
    }
});

// Opt in to a reminder when this scheduled stream goes live (Redis-backed).
router.post('/schedule/:schedule_id/notify-me', authenticateToken, async (req, res, next) => {
    try {
        const schedule_id = Number(req.params.schedule_id);
        if (!Number.isInteger(schedule_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid schedule id' });
        }
        const row = await prisma.live_stream_schedule.findUnique({
            where: { schedule_id },
            select: { schedule_id: true, is_cancelled: true, scheduled_at: true },
        });
        if (!row || row.is_cancelled) {
            return res.status(404).json({ successful: false, message: 'Schedule_Not_Found' });
        }
        // Durable opt-in. This was a Redis SADD, which on a Redis-less prod was a silent
        // no-op that still answered `reminded: true` — the endpoint claimed success and
        // stored nothing, so no reminder was ever delivered.
        await prisma.live_schedule_reminder.upsert({
            where: { schedule_id_user_id: { schedule_id, user_id: req.user.user_id } },
            create: { schedule_id, user_id: req.user.user_id },
            update: {},
            select: { id: true },
        });
        return res.json({ successful: true, reminded: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/schedule/:schedule_id/notify-me', authenticateToken, async (req, res, next) => {
    try {
        const schedule_id = Number(req.params.schedule_id);
        if (!Number.isInteger(schedule_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid schedule id' });
        }
        await prisma.live_schedule_reminder.deleteMany({
            where: { schedule_id, user_id: req.user.user_id },
        });
        return res.json({ successful: true, reminded: false });
    } catch (err) {
        next(err);
    }
});

router.post('/post', authenticateToken, async (req, res, next) => {
    try {
        const validated = communityPostSchema.safeParse(req.body);
        if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id }
        });

        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const { content, image_url, poll_options } = validated.data;

        const post = await prisma.$transaction(async (tx) => {
            const newPost = await tx.community_post.create({
                data: {
                    streamer_id: profile.streamer_id,
                    content,
                    image_url,
                    is_poll: !!poll_options
                }
            });

            if (poll_options) {
                await tx.community_poll_option.createMany({
                    data: poll_options.map(opt => ({
                        post_id: newPost.post_id,
                        option_text: opt
                    }))
                });
            }

            return newPost;
        });

        return res.status(201).json({ successful: true, data: post });
    } catch (err) {
        next(err);
    }
});

router.post('/poll/vote', authenticateToken, async (req, res, next) => {
    try {
        const optionId = Number(req.body.option_id);
        if (!optionId || Number.isNaN(optionId)) {
            return res.status(400).json({ message: "option_id required" });
        }

        // Validate the option exists and find which poll (post) it belongs to.
        const option = await prisma.community_poll_option.findUnique({
            where: { option_id: optionId },
            select: { post_id: true },
        });
        if (!option) return res.status(404).json({ message: "Option_Not_Found" });

        // One vote per user per POLL. The DB unique is only (user_id, option_id), so without this
        // a user could vote for every option of the same poll (ballot-stuffing). Reject if they've
        // already voted for any option belonging to this post.
        const existingVote = await prisma.community_poll_vote.findFirst({
            where: { user_id: req.user.user_id, option: { post_id: option.post_id } },
            select: { vote_id: true },
        });
        if (existingVote) return res.status(409).json({ message: "Already_Voted" });

        await prisma.$transaction([
            prisma.community_poll_vote.create({
                data: {
                    user_id: req.user.user_id,
                    option_id: optionId
                }
            }),
            prisma.community_poll_option.update({
                where: { option_id: optionId },
                data: { vote_count: { increment: 1 } }
            })
        ]);

        return res.json({ successful: true, message: "Vote_Recorded" });
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ message: "Already_Voted" });
        next(err);
    }
});

router.post('/post/:post_id/like', authenticateToken, async (req, res, next) => {
    try {
        const post_id = Number(req.params.post_id);
        const user_id = req.user.user_id;

        const existing = await prisma.community_post_like.findUnique({
            where: { user_id_post_id: { user_id, post_id } }
        });

        if (existing) {
            await prisma.community_post_like.delete({ where: { like_id: existing.like_id } });
            return res.json({ action: "unliked" });
        }

        await prisma.community_post_like.create({ data: { user_id, post_id } });
        return res.json({ action: "liked" });
    } catch (err) {
        next(err);
    }
});

router.get('/channel/:handle', async (req, res, next) => {
    try {
        const { handle } = req.params;

        // LNEW-5: a deactivated channel must 404 here too, matching every other public
        // live endpoint (live-session/public, live-vod/streamer). findFirst lets us add
        // the is_active filter alongside the unique handle.
        const data = await prisma.live_streamer_profile.findFirst({
            where: { handle: handle.toLowerCase(), is_active: true },
            include: {
                scheduled_streams: {
                    where: { scheduled_at: { gte: new Date() }, is_cancelled: false },
                    orderBy: { scheduled_at: 'asc' }
                },
                community_posts: {
                    include: {
                        poll_options: true,
                        _count: { select: { likes: true } }
                    },
                    orderBy: { created_at: 'desc' },
                    // Bound the result — a channel can accumulate thousands of posts; returning the
                    // whole history (each with poll_options + like counts) on a public endpoint is
                    // an unbounded query. Most recent 50 is plenty for the channel community feed.
                    take: 50
                }
            }
        });

        if (!data) return res.status(404).json({ message: "Channel_Not_Found" });
        const follower_count = await countSocialFollowersForUserId(data.user_id);
        return res.json({ successful: true, data: { ...data, follower_count } });
    } catch (err) {
        next(err);
    }
});

/** Owner: list own upcoming schedules + recent community posts for dashboard management. */
router.get('/me', authenticateToken, async (req, res, next) => {
    try {
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true, handle: true },
        });
        if (!profile) return res.json({ successful: true, data: { schedule: [], posts: [] } });

        const [schedule, posts] = await Promise.all([
            prisma.live_stream_schedule.findMany({
                where: {
                    streamer_id: profile.streamer_id,
                    is_cancelled: false,
                    scheduled_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
                },
                orderBy: { scheduled_at: 'asc' },
                take: 50,
            }),
            prisma.community_post.findMany({
                where: { streamer_id: profile.streamer_id },
                include: {
                    poll_options: true,
                    _count: { select: { likes: true } },
                },
                orderBy: { created_at: 'desc' },
                take: 50,
            }),
        ]);
        return res.json({ successful: true, data: { handle: profile.handle, schedule, posts } });
    } catch (err) {
        next(err);
    }
});

/** Owner: cancel a scheduled stream. */
router.delete('/schedule/:schedule_id', authenticateToken, async (req, res, next) => {
    try {
        const schedule_id = Number(req.params.schedule_id);
        if (!Number.isInteger(schedule_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid schedule id' });
        }
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true },
        });
        if (!profile) return res.status(404).json({ message: 'Profile_Not_Found' });

        const result = await prisma.live_stream_schedule.updateMany({
            where: { schedule_id, streamer_id: profile.streamer_id, is_cancelled: false },
            data: { is_cancelled: true },
        });
        if (result.count === 0) {
            return res.status(404).json({ successful: false, message: 'Schedule_Not_Found' });
        }
        return res.json({ successful: true, cancelled: true });
    } catch (err) {
        next(err);
    }
});

/** Owner: delete a community post. */
router.delete('/post/:post_id', authenticateToken, async (req, res, next) => {
    try {
        const post_id = Number(req.params.post_id);
        if (!Number.isInteger(post_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid post id' });
        }
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true },
        });
        if (!profile) return res.status(404).json({ message: 'Profile_Not_Found' });

        const existing = await prisma.community_post.findFirst({
            where: { post_id, streamer_id: profile.streamer_id },
            select: { post_id: true },
        });
        if (!existing) return res.status(404).json({ successful: false, message: 'Post_Not_Found' });

        await prisma.$transaction([
            prisma.community_poll_vote.deleteMany({ where: { option: { post_id } } }),
            prisma.community_poll_option.deleteMany({ where: { post_id } }),
            prisma.community_post_like.deleteMany({ where: { post_id } }),
            prisma.community_post.delete({ where: { post_id } }),
        ]);
        return res.json({ successful: true, deleted: true });
    } catch (err) {
        next(err);
    }
});

export default router;