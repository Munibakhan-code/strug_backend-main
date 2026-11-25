// routes/social-system-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

/**
 * 1. SYSTEM HEALTH CHECK
 * GET /social-system/health
 */
router.get('/health', async (req, res) => {
    const startTime = Date.now();
    try {
        
        await prisma.$queryRaw`SELECT 1`; 
        
        const responseTime = Date.now() - startTime;
        
        res.json({
            status: "healthy",
            database: "connected",
            latency: `${responseTime}ms`,
            uptime: process.uptime(),
            timestamp: new Date()
        });
    } catch (err) {
        res.status(500).json({ status: "unhealthy", message: 'Internal server error' });
    }
});

/**
 * 2. GET SYSTEM STATS (Admin Only)
 */
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [users, posts, stories] = await Promise.all([
            prisma.social_profile.count(),
            prisma.social_feed.count(),
            prisma.social_story.count()
        ]);

        res.json({
            successful: true,
            counts: { users, posts, stories }
        });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;