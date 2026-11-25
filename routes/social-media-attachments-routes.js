import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { isTrustedBlobUrl } from '../utils/azure-storage.js';
import { canViewerSeeAuthorPosts } from '../utils/social-visibility.js';

const router = express.Router();

const SOCIAL_MEDIA_CONTAINER = process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts';

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

function listPage(req, def = 50, max = 100) {
  const take = Math.min(Math.max(Number(req.query.limit) || def, 1), max);
  const skip = Math.max(Number(req.query.offset) || 0, 0);
  return { take, skip };
}

async function assertOwnsPost(req, social_post_id) {
  const post = await prisma.social_feed.findUnique({
    where: { social_post_id },
    select: { profile_id: true },
  });
  if (!post) return { ok: false, status: 404, error: 'Post not found' };
  if (post.profile_id !== req.user.profile_id && !isAdmin(req)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, post };
}

async function assertCanViewPostAttachments(req, social_post_id) {
  const post = await prisma.social_feed.findUnique({
    where: { social_post_id },
    select: { profile_id: true, status: true },
  });
  if (!post) return { ok: false, status: 404, error: 'Post not found' };
  if (isAdmin(req)) return { ok: true, post };
  if (post.status !== 'published' && post.profile_id !== req.user?.profile_id) {
    return { ok: false, status: 404, error: 'Post not found' };
  }
  const canSee = await canViewerSeeAuthorPosts(req.user?.profile_id, post.profile_id);
  if (!canSee) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, post };
}

function isAllowedMediaUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  // isTrustedBlobUrl is the whole check. There used to be a fallback here that accepted any
  // URL with a `social-posts` path segment, with no host and no protocol test — which let
  // through https://evil.example.com/social-posts/x.svg, http://127.0.0.1:8080/social-posts/x
  // and javascript:alert(1)//social-posts/x, while the caller still saw the error message
  // claiming only trusted blob URLs were accepted.
  return isTrustedBlobUrl(urlStr.trim(), SOCIAL_MEDIA_CONTAINER);
}

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL — admin only */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { take, skip } = listPage(req);
    const attachments = await prisma.social_media_attachments.findMany({
      orderBy: { attachment_id: 'desc' },
      take,
      skip,
      include: {
        platform_type: true,
        social_feed: true,
      },
    });

    res.json(attachments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch social media attachments' });
  }
});

/* GET ATTACHMENTS BY POST ID — before /:attachment_id */
router.get('/post/:social_post_id', authenticateToken, async (req, res) => {
  try {
    const social_post_id = Number(req.params.social_post_id);

    if (Number.isNaN(social_post_id)) {
      return res.status(400).json({ error: 'social_post_id must be a number' });
    }

    const gate = await assertCanViewPostAttachments(req, social_post_id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    const { take, skip } = listPage(req);
    const attachments = await prisma.social_media_attachments.findMany({
      where: { social_post_id },
      orderBy: { sequence_order: 'asc' },
      take,
      skip,
    });

    res.json(attachments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attachments for post' });
  }
});

/* GET SOCIAL MEDIA ATTACHMENT BY ID */
router.get('/:attachment_id', authenticateToken, async (req, res) => {
  try {
    const attachment_id = Number(req.params.attachment_id);

    if (Number.isNaN(attachment_id)) {
      return res.status(400).json({ error: 'attachment_id must be a number' });
    }

    const attachment = await prisma.social_media_attachments.findUnique({
      where: { attachment_id },
      include: {
        platform_type: true,
        social_feed: true,
      },
    });

    if (!attachment) {
      return res.status(404).json({ error: 'Social media attachment not found' });
    }

    if (attachment.social_post_id) {
      const gate = await assertCanViewPostAttachments(req, attachment.social_post_id);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    }

    res.json(attachment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch social media attachment' });
  }
});

/* CREATE SOCIAL MEDIA ATTACHMENT — must own the post; media_url allowlisted */
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user?.profile_id) {
      return res.status(400).json({ error: 'Social profile setup required' });
    }

    const {
      social_post_id,
      media_url,
      media_type,
      sequence_order,
      platform_type_id,
    } = req.body;

    const postId = Number(social_post_id);
    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: 'social_post_id must be a number' });
    }
    if (!isAllowedMediaUrl(media_url)) {
      return res.status(400).json({ error: 'media_url must be a trusted social-posts blob URL' });
    }

    const ownership = await assertOwnsPost(req, postId);
    if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    const attachment = await prisma.social_media_attachments.create({
      data: {
        social_post_id: postId,
        media_url: String(media_url).trim(),
        media_type,
        sequence_order,
        platform_type_id,
      },
      include: {
        platform_type: true,
        social_feed: true,
      },
    });

    res.status(201).json(attachment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create social media attachment' });
  }
});

/* UPDATE SOCIAL MEDIA ATTACHMENT */
router.put('/:attachment_id', authenticateToken, async (req, res) => {
  try {
    const attachment_id = Number(req.params.attachment_id);

    if (Number.isNaN(attachment_id)) {
      return res.status(400).json({ error: 'attachment_id must be a number' });
    }

    const existing = await prisma.social_media_attachments.findUnique({
      where: { attachment_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Social media attachment not found' });
    }

    const ownership = await assertOwnsPost(req, existing.social_post_id);
    if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    const {
      media_url,
      media_type,
      sequence_order,
      platform_type_id,
    } = req.body;

    if (media_url != null && !isAllowedMediaUrl(media_url)) {
      return res.status(400).json({ error: 'media_url must be a trusted social-posts blob URL' });
    }

    const updated = await prisma.social_media_attachments.update({
      where: { attachment_id },
      data: {
        media_url: media_url ?? existing.media_url,
        media_type: media_type ?? existing.media_type,
        sequence_order: sequence_order ?? existing.sequence_order,
        platform_type_id: platform_type_id ?? existing.platform_type_id,
      },
      include: {
        platform_type: true,
        social_feed: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update social media attachment' });
  }
});

/* DELETE SOCIAL MEDIA ATTACHMENT */
router.delete('/:attachment_id', authenticateToken, async (req, res) => {
  try {
    const attachment_id = Number(req.params.attachment_id);

    if (Number.isNaN(attachment_id)) {
      return res.status(400).json({ error: 'attachment_id must be a number' });
    }

    const existing = await prisma.social_media_attachments.findUnique({
      where: { attachment_id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Social media attachment not found' });
    }

    const ownership = await assertOwnsPost(req, existing.social_post_id);
    if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    await prisma.social_media_attachments.delete({
      where: { attachment_id },
    });

    res.json({ message: 'Social media attachment deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete social media attachment' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
