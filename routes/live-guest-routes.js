import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { generateUserToken } from '../utils/azure-acs.js';
import { assertNoPlatformBlockBetweenUsers } from '../utils/platform-blocks.js';

const router = express.Router();

router.post('/:session_id/invite', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        const { target_user_id } = req.body;

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });

        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized_Action" });
        }
        await assertNoPlatformBlockBetweenUsers(req.user.user_id, Number(target_user_id));

        const guest = await prisma.live_stream_guest.upsert({
            where: { session_id_user_id: { session_id, user_id: Number(target_user_id) } },
            update: { status: 'INVITED' },
            create: { session_id, user_id: Number(target_user_id), status: 'INVITED' }
        });

        const io = req.app.get('io');
        io.to(`user-${target_user_id}`).emit(`notification_user_${target_user_id}`, {
            type: 'STREAM_INVITE',
            session_id,
            streamer_name: session.streamer.display_name
        });

        return res.status(201).json({ successful: true, data: guest });
    } catch (err) {
        next(err);
    }
});

router.get('/:session_id/join', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        const user_id = req.user.user_id;

        const guestEntry = await prisma.live_stream_guest.findUnique({
            where: { session_id_user_id: { session_id, user_id } }
        });

        if (!guestEntry || guestEntry.status === 'KICKED') {
            return res.status(403).json({ successful: false, message: "No_Valid_Invite" });
        }

        const acsAccess = await generateUserToken(["voip", "chat"]);

        await prisma.live_stream_guest.update({
            where: { guest_id: guestEntry.guest_id },
            data: { status: 'JOINED', joined_at: new Date() }
        });

        const io = req.app.get('io');
        io.to(`stream_${session_id}`).emit('guest-joined', { user_id, acs_user_id: acsAccess.user_id });

        return res.json({
            successful: true,
            acs_access: acsAccess,
            session_id
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/:session_id/kick/:target_user_id', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        const target_user_id = Number(req.params.target_user_id);

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });

        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ message: "Unauthorized" });
        }

        await prisma.live_stream_guest.update({
            where: { session_id_user_id: { session_id, user_id: target_user_id } },
            data: { status: 'KICKED', left_at: new Date() }
        });

        const io = req.app.get('io');
        io.to(`stream_${session_id}`).emit('guest-kicked', { target_user_id });

        return res.json({ successful: true, message: "Guest_Kicked" });
    } catch (err) {
        next(err);
    }
});

router.get('/:session_id/list', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (!Number.isInteger(session_id)) return res.status(400).json({ message: "Invalid session id." });

        // LNEW-4: only the broadcaster may see their session's guest roster (was an open IDOR).
        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized_Action" });
        }

        const guests = await prisma.live_stream_guest.findMany({
            where: { session_id, status: 'JOINED' },
            // LNEW-4: do not expose guest email addresses.
            include: { user: { select: { name: true } } }
        });
        return res.json({ successful: true, data: guests });
    } catch (err) {
        next(err);
    }
});

export default router;
