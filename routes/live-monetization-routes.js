import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { notify } from '../services/notify.js';

const router = express.Router();

// Real streamed airtime (hours) for a streamer: the summed duration of their finished live
// sessions. Replaces the old "sum of live_vod.duration_sec" metric, which measured recorded
// CONTENT length, not engagement — so a streamer could pass the bar by archiving long VODs nobody
// watched (and it read 0 whenever recording was off). Airtime is the real, non-gameable signal of
// time spent live. (True viewer watch-hours would need per-viewer live-minute tracking, which the
// platform doesn't record yet — airtime is the honest available proxy.)
async function streamedHoursFor(streamerId) {
    const sessions = await prisma.live_session.findMany({
        where: { streamer_id: streamerId, started_at: { not: null }, ended_at: { not: null } },
        select: { started_at: true, ended_at: true },
    });
    const totalSec = sessions.reduce((acc, s) => {
        const ms = new Date(s.ended_at).getTime() - new Date(s.started_at).getTime();
        return acc + (ms > 0 ? ms / 1000 : 0);
    }, 0);
    return totalSec / 3600;
}

router.get('/eligibility', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            include: {
                _count: {
                    select: { 
                        social_links: true 
                    }
                }
            }
        });

        if (!profile) {
            return res.status(404).json({ message: "Streamer_Profile_Not_Found" });
        }

        const subscriberCount = await prisma.live_subscription.count({
            where: {
                streamer_id: profile.streamer_id,
                status: 'active',
                OR: [
                    { current_period_end: null },
                    { current_period_end: { gt: new Date() } },
                ],
            },
        });

        const totalWatchHours = await streamedHoursFor(profile.streamer_id);
        const requiredSubs = 1000;
        const requiredHours = 4000;

        const isEligible = subscriberCount >= requiredSubs && totalWatchHours >= requiredHours;

        return res.json({
            successful: true,
            stats: {
                current_subscribers: subscriberCount,
                required_subscribers: requiredSubs,
                current_watch_hours: Math.floor(totalWatchHours),
                required_watch_hours: requiredHours,
                is_eligible: isEligible
            },
            current_status: profile.monetization_status
        });
    } catch (err) {
        next(err);
    }
});

router.post('/apply', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id }
        });

        if (!profile) return res.status(404).json({ message: "No_Profile" });

        if (profile.monetization_status !== 'NONE' && profile.monetization_status !== 'REJECTED') {
            return res.status(400).json({ message: "Request_Already_In_Progress_Or_Approved" });
        }

        const subscriberCount = await prisma.live_subscription.count({
            where: {
                streamer_id: profile.streamer_id,
                status: 'active',
                OR: [
                    { current_period_end: null },
                    { current_period_end: { gt: new Date() } },
                ],
            },
        });

        const totalWatchHours = await streamedHoursFor(profile.streamer_id);

        if (subscriberCount < 1000 || totalWatchHours < 4000) {
            return res.status(403).json({ message: "Requirements_Not_Met" });
        }

        const result = await prisma.$transaction([
            prisma.live_monetization_request.create({
                data: { streamer_id: profile.streamer_id }
            }),
            prisma.live_streamer_profile.update({
                where: { streamer_id: profile.streamer_id },
                data: { monetization_status: 'PENDING' }
            })
        ]);

        return res.json({ successful: true, message: "Application_Submitted", data: result[0] });
    } catch (err) {
        next(err);
    }
});

// Admin queue: list monetization requests (default the actionable PENDING set)
// so an admin can review + resolve them from the dashboard.
router.get('/admin/requests', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { status } = req.query;
        const where = status ? { status } : { status: 'PENDING' };
        const requests = await prisma.live_monetization_request.findMany({
            where,
            orderBy: { applied_at: 'asc' },
            include: {
                streamer: {
                    select: {
                        streamer_id: true,
                        handle: true,
                        display_name: true,
                        monetization_status: true,
                        user_id: true,
                    },
                },
            },
        });
        return res.json({ successful: true, data: requests });
    } catch (err) {
        next(err);
    }
});

router.patch('/admin/resolve/:request_id', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const request_id = Number(req.params.request_id);
        if (!Number.isInteger(request_id)) return res.status(400).json({ message: "Invalid request id." });
        const { action, note } = req.body;
        if (!['APPROVE', 'REJECT'].includes(action)) {
            return res.status(400).json({ message: "action must be APPROVE or REJECT." });
        }

        const request = await prisma.live_monetization_request.findUnique({
            where: { request_id },
            include: { streamer: true }
        });

        if (!request) return res.status(404).json({ message: "Request_Not_Found" });

        const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

        await prisma.$transaction([
            prisma.live_monetization_request.update({
                where: { request_id },
                data: { 
                    status: newStatus, 
                    admin_note: note,
                    resolved_at: new Date()
                }
            }),
            prisma.live_streamer_profile.update({
                where: { streamer_id: request.streamer_id },
                data: { 
                    monetization_status: newStatus,
                    is_verified: action === 'APPROVE' ? true : request.streamer.is_verified
                }
            })
        ]);

        // The applicant was never told the outcome of their own application — they had to keep
        // checking the page to find out whether they'd been approved.
        if (request.streamer?.user_id) {
            const approved = action === 'APPROVE';
            notify(req.app.get('io'), {
                userId: request.streamer.user_id,
                vertical: 'system',
                type: approved ? 'application.approved' : 'application.rejected',
                title: approved ? 'Your monetization application was approved' : 'Your monetization application was rejected',
                body: note || (approved ? 'You can now monetize your streams.' : null),
                urgency: 'ambient',
                entityType: 'live_monetization_request',
                entityId: request_id,
                actionUrl: 'wallet',
            });
        }

        return res.json({ successful: true, message: `Application_${newStatus}` });
    } catch (err) {
        next(err);
    }
});

export default router;