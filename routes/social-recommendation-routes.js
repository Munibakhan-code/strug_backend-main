// routes/social-recommendation-routes.js
// Personalised content recommendations for the social feed.
//   GET  /social-recommendations/for-you     → ranked posts + videos ("For You")
//   POST /social-recommendations/impression  → batch dwell / impression capture
//   GET  /social-recommendations/interests   → the caller's learned interest vector
//   POST /social-recommendations/refresh     → recompute the caller's interests now
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import {
  getForYou,
  buildInterestProfile,
  refreshInterestProfile,
} from '../utils/recommendation-engine.js';

const router = express.Router();

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// ─── 1. FOR YOU FEED ─────────────────────────────────────────────────────────
// optionalAuth: logged-out visitors still get a sensible (trending) response.
router.get('/for-you', optionalAuth, async (req, res) => {
  try {
    const profileId     = req.user?.profile_id ?? null;
    const userId        = req.user?.user_id ?? null;
    const limit         = clamp(req.query.limit, 1, 30, 12);
    const offset        = clamp(req.query.offset, 0, 600, 0);
    const includeVideos = req.query.videos === 'true';

    const { items, nextCursor, cold } = await getForYou({ profileId, userId, limit, offset, includeVideos });
    res.json({ successful: true, data: items, nextCursor, cold });
  } catch (err) {
    console.error('❌ [ForYou] Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// ─── 2. IMPRESSION / DWELL CAPTURE ───────────────────────────────────────────
// Body: { items: [{ content_type, content_id, dwell_ms, completed, source }] }
// One row per (profile, content); dwell + impression counts accumulate.
router.post('/impression', authenticateToken, async (req, res) => {
  try {
    const profile_id = req.user.profile_id;
    if (!profile_id) return res.json({ successful: true, recorded: 0 }); // no social profile → nothing to learn

    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 60) : [];
    let recorded = 0;

    await Promise.allSettled(items.map(async (it) => {
      const content_type = it?.content_type === 'video' ? 'video' : 'post';
      const content_id   = parseInt(it?.content_id, 10);
      if (!Number.isFinite(content_id)) return;

      const dwell_ms   = Math.min(Math.max(parseInt(it?.dwell_ms, 10) || 0, 0), 600000);
      const completed  = !!it?.completed;
      const source     = typeof it?.source === 'string' ? it.source.slice(0, 20) : null;

      await prisma.content_impression.upsert({
        where: { profile_id_content_type_content_id: { profile_id, content_type, content_id } },
        update: {
          dwell_ms:    { increment: dwell_ms },
          impressions: { increment: 1 },
          ...(completed ? { completed: true } : {}),
          source,
          updated_at: new Date(),
        },
        create: { profile_id, content_type, content_id, dwell_ms, impressions: 1, completed, source },
      });
      recorded += 1;
    }));

    res.json({ successful: true, recorded });
  } catch (err) {
    console.error('❌ [Impression] Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// ─── 3. INTEREST VECTOR (transparency / debug) ───────────────────────────────
router.get('/interests', authenticateToken, async (req, res) => {
  try {
    const profile_id = req.user.profile_id;
    if (!profile_id) return res.json({ successful: true, data: { topTokens: [], signalCount: 0, interests: {} } });

    const stored = await prisma.user_interest_profile.findUnique({ where: { profile_id } }).catch(() => null);
    if (stored) {
      return res.json({ successful: true, data: {
        topTokens: stored.top_tokens, topCreators: stored.top_creators,
        signalCount: stored.signal_count, interests: stored.interests, computedAt: stored.computed_at,
      }});
    }
    const built = await buildInterestProfile(profile_id, req.user.user_id);
    res.json({ successful: true, data: {
      topTokens: built.topTokens, topCreators: built.topCreators,
      signalCount: built.signalCount, interests: built.interests, computedAt: null,
    }});
  } catch (err) {
    console.error('❌ [Interests] Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// ─── 4. ON-DEMAND REFRESH (caller's own profile) ─────────────────────────────
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const profile_id = req.user.profile_id;
    if (!profile_id) return res.status(400).json({ successful: false, message: 'Social profile required.' });
    const result = await refreshInterestProfile(profile_id, req.user.user_id);
    res.json({ successful: true, ...result });
  } catch (err) {
    console.error('❌ [RecoRefresh] Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
