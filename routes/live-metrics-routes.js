import express from 'express';
import prisma from '../utils/prisma-client.js';
import { viewerCounts } from '../services/live-presence.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { LIVE_HLS_BASE, LIVE_RTMP_URL, VOD_AUTH_ENFORCE, mediaEgressEnabled } from '../services/live-playback.js';

const router = express.Router();

/**
 * GET /live-session/metrics — ops snapshot for live pipeline health.
 * Admin-only: exposes platform-wide session counts and infra config flags.
 */
router.get('/metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [liveCount, startingCount, finishedToday] = await Promise.all([
      prisma.live_session.count({ where: { status: 'LIVE' } }),
      prisma.live_session.count({ where: { status: 'STARTING' } }),
      prisma.live_session.count({
        where: {
          status: 'FINISHED',
          ended_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    // Previously gated on `typeof redis.pipeline === 'function'`, which is ALWAYS true — the
    // redis client is a Proxy that wraps every function-valued property, so redis.pipeline()
    // resolved null and pipe.scard() threw a TypeError this catch swallowed. The reported total
    // was therefore hardcoded 0 in every environment.
    let totalViewers = 0;
    try {
      const live = await prisma.live_session.findMany({
        where: { status: 'LIVE' },
        select: { session_id: true, streamer: { select: { user_id: true } } },
        take: 200,
      });
      const counts = await viewerCounts(req.app.get('io'), live.map((s) => ({
        session_id: s.session_id,
        hostUserId: s.streamer?.user_id ?? null,
      })));
      totalViewers = [...counts.values()].reduce((sum, n) => sum + (Number(n) || 0), 0);
    } catch (err) { console.debug('[live-metrics] viewer total unavailable:', err?.message); }

    res.json({
      successful: true,
      data: {
        live_sessions: liveCount,
        starting_sessions: startingCount,
        finished_last_24h: finishedToday,
        total_viewers_approx: totalViewers,
        media_egress_enabled: mediaEgressEnabled(),
        live_rtmp_configured: Boolean(LIVE_RTMP_URL),
        live_hls_configured: Boolean(LIVE_HLS_BASE),
        vod_auth_enforce: VOD_AUTH_ENFORCE,
        mediamtx_metrics_hint: 'Scrape MediaMTX :9998/metrics when exposed',
        viewer_source: 'live-presence (redis when ready, else socket rooms)',
        ts: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[live-session/metrics]', err);
    res.status(500).json({ successful: false, message: 'metrics_failed' });
  }
});

export default router;
