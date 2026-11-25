import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL SUBSCRIPTIONS */
router.get('/', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const subscriptions = await prisma.user_content_subscription_mapping.findMany({
            orderBy: { user_content_subscription_mapping_id: 'desc' },
            include: {
                user: true,
                cs_type: true
            },
        });
        res.json(subscriptions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch content subscriptions' });
    }
});

/* GET SUBSCRIPTION BY ID */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const user_content_subscription_mapping_id = Number(req.params.id);
        if (Number.isNaN(user_content_subscription_mapping_id)) return res.status(400).json({ error: 'ID must be a number' });

        const subscription = await prisma.user_content_subscription_mapping.findUnique({
            where: { user_content_subscription_mapping_id },
            include: {
                user: true,
                cs_type: true
            },
        });

        if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
        res.json(subscription);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch subscription' });
    }
});

/* GET SUBSCRIPTIONS BY USER ID */
router.get('/user/:user_id', authenticateToken, async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const subscriptions = await prisma.user_content_subscription_mapping.findMany({
            where: { user_id },
            include: {
                cs_type: true
            },
        });
        res.json(subscriptions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch subscriptions for user' });
    }
});

/* CREATE SUBSCRIPTION */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { cs_type_id, expire_date } = req.body;

        const newSubscription = await prisma.user_content_subscription_mapping.create({
            data: {
                user_id: req.user.user_id,
                cs_type_id,
                is_paid: false,
                expire_date: expire_date ? new Date(expire_date) : null,
            },
            include: {
                user: true,
                cs_type: true
            },
        });

        res.status(201).json(newSubscription);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create subscription' });
    }
});

/* UPDATE SUBSCRIPTION */
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const user_content_subscription_mapping_id = Number(req.params.id);
        if (Number.isNaN(user_content_subscription_mapping_id)) return res.status(400).json({ error: 'ID must be a number' });

        const { cs_type_id, expire_date } = req.body;

        const existing = await prisma.user_content_subscription_mapping.findUnique({ where: { user_content_subscription_mapping_id } });
        if (!existing) return res.status(404).json({ error: 'Subscription not found' });
        if (existing.user_id !== req.user.user_id && req.user.role !== 'ADMIN')
            return res.status(403).json({ error: 'Forbidden' });

        const updated = await prisma.user_content_subscription_mapping.update({
            where: { user_content_subscription_mapping_id },
            data: {
                user_id: existing.user_id,
                cs_type_id: cs_type_id ?? existing.cs_type_id,
                expire_date: expire_date ? new Date(expire_date) : existing.expire_date,
            },
            include: {
                user: true,
                cs_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

/* DELETE SUBSCRIPTION */
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const user_content_subscription_mapping_id = Number(req.params.id);
        if (Number.isNaN(user_content_subscription_mapping_id)) return res.status(400).json({ error: 'ID must be a number' });

        const existing = await prisma.user_content_subscription_mapping.findUnique({ where: { user_content_subscription_mapping_id } });
        if (!existing) return res.status(404).json({ error: 'Subscription not found' });
        if (existing.user_id !== req.user.user_id && req.user.role !== 'ADMIN')
            return res.status(403).json({ error: 'Forbidden' });

        await prisma.user_content_subscription_mapping.delete({ where: { user_content_subscription_mapping_id } });
        res.json({ message: 'Subscription deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
});

export default router;
