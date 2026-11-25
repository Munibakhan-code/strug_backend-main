import express from "express";
import { authenticateToken } from "../middleware/authentication.js";
import prisma from "../utils/prisma-client.js";
import { getModContext, isBanned } from "../utils/community-mod.js";
import { createNotification } from "../utils/notification-service.js";
import { assertNoPlatformBlockBetweenUsers, blockedGraphForUser } from "../utils/platform-blocks.js";

const router = express.Router();

function handleCommunityError(res, err, fallbackMessage) {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ message: err.message || "This interaction is not available." });
  }
  console.error(err);
  return res.status(500).json({ message: fallbackMessage });
}

// GET /community-post?community_id=X
router.get("/", authenticateToken, async (req, res) => {
  const { community_id } = req.query;
  if (!community_id)
    return res.status(400).json({ message: "community_id is required." });
  try {
    // Removed posts are hidden from everyone except mods (and the author, who sees a "removed" state).
    const ctx = await getModContext(community_id, req.user.user_id);
    const blockedGraph = await blockedGraphForUser(req.user.user_id);
    const posts = await prisma.community_posts.findMany({
      where: {
        community_id,
        ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
        ...(ctx.isMod ? {} : { OR: [{ is_removed: false }, { user_id: req.user.user_id }] }),
      },
      include: {
        author: {
          select: {
            user_id: true,
            username: true,
            social_profiles: {
              select: {
                profile_id: true,
                handle: true,
                display_name: true,
                profile_pic_url: true,
              },
            },
          },
        },
        _count: { select: { comments: true } },
        flair: true,
        votes: {
          where: { user_id: req.user.user_id },
          select: { vote_type: true },
        },
        saves: {
          where: { user_id: req.user.user_id },
          select: { user_id: true },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const { byPost } = await awardSummary({ postIds: posts.map((p) => p.community_post_id) });
    const shaped = posts.map((p) => ({
      ...p,
      user_vote: p.votes[0]?.vote_type ?? 0,
      is_saved: p.saves.length > 0,
      awards: byPost[p.community_post_id] || [],
      votes: undefined,
      saves: undefined,
    }));

    res.json({ successful: true, data: shaped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch posts." });
  }
});

// GET /community-post/feed?scope=home|popular|all&sort=hot|new|top&limit=&offset=
// Cross-community aggregated feed (#265).
//   home    → posts from communities the user has joined
//   popular → public communities, site-wide
//   all     → every community
router.get("/feed", authenticateToken, async (req, res) => {
  try {
    const scope = ["home", "popular", "all"].includes(req.query.scope) ? req.query.scope : "home";
    const sort  = ["hot", "new", "top"].includes(req.query.sort) ? req.query.sort : "hot";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Resolve which communities are in scope.
    let communityFilter = {};
    if (scope === "home") {
      const memberships = await prisma.community_member.findMany({ where: { user_id: req.user.user_id }, select: { community_id: true } });
      const ids = memberships.map(m => m.community_id);
      if (!ids.length) return res.json({ successful: true, data: [], has_more: false });
      communityFilter = { community_id: { in: ids } };
    } else if (scope === "popular") {
      communityFilter = { community: { is: { type: "public" } } };
    } // all → no filter

    const blockedGraph = await blockedGraphForUser(req.user.user_id);
    const where = {
      is_removed: false,
      ...communityFilter,
      ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
    };

    const include = {
      community: { select: { community_id: true, name: true, handle: true, color: true, icon: true, icon_url: true } },
      author: { select: { user_id: true, username: true, social_profiles: { select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true } } } },
      flair: true,
      _count: { select: { comments: true } },
      votes: { where: { user_id: req.user.user_id }, select: { vote_type: true } },
      saves: { where: { user_id: req.user.user_id }, select: { user_id: true } },
    };

    let posts;
    if (sort === "hot") {
      // Fetch a recent candidate pool, then rank by a time-decayed score in JS.
      const pool = await prisma.community_posts.findMany({ where, include, orderBy: { created_at: "desc" }, take: 300 });
      const now = Date.now();
      const score = (p) => {
        const ageHours = Math.max((now - new Date(p.created_at).getTime()) / 3.6e6, 0);
        return (p.upvotes || 0) / Math.pow(ageHours + 2, 1.5);
      };
      posts = pool.sort((a, b) => score(b) - score(a)).slice(offset, offset + limit + 1);
    } else {
      const orderBy = sort === "top" ? [{ upvotes: "desc" }, { created_at: "desc" }] : [{ created_at: "desc" }];
      posts = await prisma.community_posts.findMany({ where, include, orderBy, skip: offset, take: limit + 1 });
    }

    const hasMore = posts.length > limit;
    const page = posts.slice(0, limit);
    const { byPost } = await awardSummary({ postIds: page.map((p) => p.community_post_id) });
    const shaped = page.map((p) => ({
      ...p,
      user_vote: p.votes?.[0]?.vote_type ?? 0,
      is_saved: (p.saves?.length ?? 0) > 0,
      awards: byPost[p.community_post_id] || [],
      votes: undefined,
      saves: undefined,
    }));
    res.json({ successful: true, data: shaped, has_more: hasMore });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch feed." });
  }
});

// POST /community-post
router.post("/", authenticateToken, async (req, res) => {
  const { caption_text, community_id, title, post_type, flair_id, is_spoiler, is_nsfw } = req.body;
  if (!caption_text?.trim())
    return res.status(400).json({ message: "Content is required." });
  if (!community_id)
    return res.status(400).json({ message: "community_id is required." });
  try {
    // Banned users can't post.
    if (await isBanned(community_id, req.user.user_id))
      return res.status(403).json({ message: "You are banned from this community." });

    // Load the community's post settings to enforce type restrictions + require-flair.
    const community = await prisma.community.findUnique({
      where: { community_id },
      select: { allowed_post_types: true, require_flair: true },
    });
    if (!community) return res.status(404).json({ message: "Community not found." });

    const allowed = community.allowed_post_types?.length ? community.allowed_post_types : ["text"];
    const type = post_type && allowed.includes(post_type) ? post_type : "text";
    if (post_type && !allowed.includes(post_type))
      return res.status(400).json({ message: `Post type "${post_type}" is not allowed in this community.` });

    // Validate flair belongs to this community; enforce require_flair.
    let flairId = null;
    if (flair_id != null && flair_id !== "") {
      const flair = await prisma.community_flair.findFirst({
        where: { flair_id: parseInt(flair_id, 10), community_id },
        select: { flair_id: true },
      });
      if (!flair) return res.status(400).json({ message: "Invalid flair for this community." });
      flairId = flair.flair_id;
    }
    if (community.require_flair && !flairId)
      return res.status(400).json({ message: "This community requires a flair on every post." });

    const post = await prisma.community_posts.create({
      data: {
        community_id,
        user_id: req.user.user_id,
        title: title?.trim() || null,
        content: caption_text.trim(),
        post_type: type,
        flair_id: flairId,
        is_spoiler: !!is_spoiler,
        is_nsfw: !!is_nsfw,
      },
      include: {
        flair: true,
        author: {
          select: {
            user_id: true,
            username: true,
            social_profiles: {
              select: {
                profile_id: true,
                handle: true,
                display_name: true,
                profile_pic_url: true,
              },
            },
          },
        },
      },
    });
    res.status(201).json({ successful: true, data: { ...post, user_vote: 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create post." });
  }
});

// PUT /community-post/:id  (update post)
router.put("/:id", authenticateToken, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const post = await prisma.community_posts.findUnique({
      where: { community_post_id: postId },
    });
    if (!post) return res.status(404).json({ message: "Post not found." });
    if (post.user_id !== req.user.user_id)
      return res.status(403).json({ message: "Unauthorized." });

    const updated = await prisma.community_posts.update({
      where: { community_post_id: postId },
      data: {
        title: req.body.title?.trim() || null,
        content: req.body.content?.trim() || post.content,
      },
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error("Update Post Error:", err);
    res.status(500).json({ message: "Failed to update post." });
  }
});

// DELETE /community-post/:id
router.delete("/:id", authenticateToken, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const post = await prisma.community_posts.findUnique({
      where: { community_post_id: postId },
    });
    if (!post) return res.status(404).json({ message: "Post not found." });
    if (post.user_id !== req.user.user_id)
      return res.status(403).json({ message: "Not authorized." });
    await prisma.community_posts.delete({
      where: { community_post_id: postId },
    });
    res.json({ successful: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete post." });
  }
});

// POST /community-post/:id/vote
router.post("/:id/vote", authenticateToken, async (req, res) => {
  const postId = parseInt(req.params.id);
  const { vote_type } = req.body;
  if (![1, -1].includes(vote_type))
    return res.status(400).json({ message: "vote_type must be 1 or -1." });

  try {
    const post = await prisma.community_posts.findUnique({
      where: { community_post_id: postId },
      select: { user_id: true },
    });
    if (!post) return res.status(404).json({ message: "Post not found." });
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, post.user_id);

    const existing = await prisma.community_post_vote.findUnique({
      where: {
        user_id_post_id: { user_id: req.user.user_id, post_id: postId },
      },
    });

    if (existing?.vote_type === vote_type) {
      await prisma.community_post_vote.delete({
        where: {
          user_id_post_id: { user_id: req.user.user_id, post_id: postId },
        },
      });
      await prisma.community_posts.update({
        where: { community_post_id: postId },
        data: { upvotes: { increment: -vote_type } },
      });
      return res.json({ successful: true, user_vote: 0 });
    }

    const delta = existing ? vote_type - existing.vote_type : vote_type;
    await prisma.community_post_vote.upsert({
      where: {
        user_id_post_id: { user_id: req.user.user_id, post_id: postId },
      },
      create: { user_id: req.user.user_id, post_id: postId, vote_type },
      update: { vote_type },
    });
    await prisma.community_posts.update({
      where: { community_post_id: postId },
      data: { upvotes: { increment: delta } },
    });

    res.json({ successful: true, user_vote: vote_type });
  } catch (err) {
    return handleCommunityError(res, err, "Failed to record vote.");
  }
});

// GET /community-post/:id/comments
router.get("/:id/comments", authenticateToken, async (req, res) => {
  try {
    const blockedGraph = await blockedGraphForUser(req.user.user_id);
    const comments = await prisma.community_post_comment.findMany({
      where: {
        post_id: parseInt(req.params.id),
        ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
      },
      include: {
        author: {
          select: {
            user_id: true, username: true,
            social_profiles: { select: { handle: true, display_name: true, profile_pic_url: true } },
          },
        },
        votes: {
          where: { user_id: req.user.user_id }, 
        },
      },
      orderBy: { created_at: "asc" },
    });

    const { byComment } = await awardSummary({ commentIds: comments.map(c => c.comment_id) });
    const mapped = comments.map(c => ({
      ...c,
      user_vote: c.votes[0]?.vote_type ?? 0,
      awards: byComment[c.comment_id] || [],
      votes: undefined,
    }));

    res.json({ successful: true, data: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch comments." });
  }
});

// POST /community-post/:id/comments
router.post("/:id/comments", authenticateToken, async (req, res) => {
  const { content, parent_id } = req.body;
  if (!content?.trim())
    return res.status(400).json({ message: "Content is required." });
  const postId = parseInt(req.params.id);
  try {
    // Locked posts accept no new comments (except from mods).
    const lockCheck = await prisma.community_posts.findUnique({
      where: { community_post_id: postId },
      select: { community_id: true, is_locked: true, user_id: true },
    });
    if (!lockCheck) return res.status(404).json({ message: "Post not found." });
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, lockCheck.user_id);
    if (lockCheck.is_locked) {
      const ctx = await getModContext(lockCheck.community_id, req.user.user_id);
      if (!ctx.isMod) return res.status(403).json({ message: "This post is locked." });
    }
    if (await isBanned(lockCheck.community_id, req.user.user_id))
      return res.status(403).json({ message: "You are banned from this community." });

    // If this is a reply, ensure the parent comment exists and belongs to this post.
    let parentId = null;
    if (parent_id != null) {
      parentId = parseInt(parent_id);
      const parent = await prisma.community_post_comment.findUnique({
        where: { comment_id: parentId },
        select: { post_id: true, user_id: true },
      });
      if (!parent || parent.post_id !== postId)
        return res.status(400).json({ message: "Invalid parent comment." });
      await assertNoPlatformBlockBetweenUsers(req.user.user_id, parent.user_id);
    }
    const comment = await prisma.community_post_comment.create({
      data: {
        post_id:   postId,
        user_id:   req.user.user_id,
        content:   content.trim(),
        parent_id: parentId,
      },
      include: {
        author: {
          select: {
            user_id: true, username: true,
            social_profiles: { select: { handle: true, display_name: true, profile_pic_url: true } },
          },
        },
      },
    });

    // Notify the post author (or, on a reply, the parent comment author). Best-effort — never
    // let a notification failure break commenting. Reuses the social_notification pipeline (#266).
    try {
      let targetUserId;
      if (parentId) {
        const parent = await prisma.community_post_comment.findUnique({ where: { comment_id: parentId }, select: { user_id: true } });
        targetUserId = parent?.user_id;
      } else {
        const post = await prisma.community_posts.findUnique({ where: { community_post_id: postId }, select: { user_id: true } });
        targetUserId = post?.user_id;
      }
      if (targetUserId && targetUserId !== req.user.user_id && req.user.profile_id) {
        const targetProfile = await prisma.social_profile.findUnique({ where: { user_id: targetUserId }, select: { profile_id: true } });
        if (targetProfile) {
          await createNotification(req.app.get("io"), {
            receiver_id: targetProfile.profile_id,
            sender_id: req.user.profile_id,
            type: parentId ? "community_reply" : "community_comment",
            target_id: postId,
          });
        }
      }
    } catch (notifyErr) { console.error("community notify failed:", notifyErr?.message); }

    res.status(201).json({ successful: true, data: comment });
  } catch (err) {
    return handleCommunityError(res, err, "Failed to add comment.");
  }
});
// PUT /community-post/:postId/comments/:commentId
router.put(
  "/:postId/comments/:commentId",
  authenticateToken,
  async (req, res) => {
    const postId = parseInt(req.params.postId);
    const commentId = parseInt(req.params.commentId);
    const { content } = req.body;

    if (!content?.trim())
      return res.status(400).json({ message: "Content is required." });

    try {
      const comment = await prisma.community_post_comment.findUnique({
        where: { comment_id: commentId },
      });

      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      if (comment.post_id !== postId)
        // ← post_id, NOT community_post_id
        return res
          .status(400)
          .json({ message: "Comment does not belong to this post." });
      if (comment.user_id !== req.user.user_id)
        return res.status(403).json({ message: "Unauthorized." });

      const updated = await prisma.community_post_comment.update({
        where: { comment_id: commentId },
        data: { content: content.trim() },
      });
      res.json({ successful: true, data: updated });
    } catch (err) {
      console.error("Update Comment Error:", err);
      res.status(500).json({ message: "Failed to update comment." });
    }
  },
);

router.post("/:id/save", authenticateToken, async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const post = await prisma.community_posts.findUnique({
      where: { community_post_id: postId },
      select: { user_id: true },
    });
    if (!post) return res.status(404).json({ message: "Post not found." });
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, post.user_id);

    const existing = await prisma.community_post_save.findUnique({
      where: {
        user_id_post_id: { user_id: req.user.user_id, post_id: postId },
      },
    });

    if (existing) {
      await prisma.community_post_save.delete({
        where: {
          user_id_post_id: { user_id: req.user.user_id, post_id: postId },
        },
      });
      return res.json({ successful: true, saved: false });
    }

    await prisma.community_post_save.create({
      data: { user_id: req.user.user_id, post_id: postId },
    });
    res.json({ successful: true, saved: true });
  } catch (err) {
    return handleCommunityError(res, err, "Failed to toggle save.");
  }
});

// GET /community-post/saved
router.get('/saved', authenticateToken, async (req, res) => {
    try {
        const blockedGraph = await blockedGraphForUser(req.user.user_id);
        const saves = await prisma.community_post_save.findMany({
            where: { user_id: req.user.user_id },
            include: {
                post: {
                    include: {
                        author: {
                            select: {
                                user_id: true, username: true,
                                social_profiles: { select: { handle: true, display_name: true } },
                            },
                        },
                        community: {
                            select: { community_id: true, name: true, color: true, icon: true },
                        },
                        _count: { select: { comments: true } },
                    },
                },
            },
            orderBy: { saved_at: 'desc' },
        });

        res.json({
            successful: true,
            data: saves
                .map(s => s.post)
                .filter(post => post && !blockedGraph.userIds.includes(Number(post.user_id)))
                .map(post => ({ ...post, is_saved: true })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch saved posts.' });
    }
});

// POST /community-post/comment/:commentId/vote
router.post("/comment/:commentId/vote", authenticateToken, async (req, res) => {
  const commentId = parseInt(req.params.commentId);
  const { vote_type } = req.body; // 1 for up, -1 for down
  if (![1, -1].includes(vote_type))
    return res.status(400).json({ message: "vote_type must be 1 or -1." });

  try {
    const comment = await prisma.community_post_comment.findUnique({
      where: { comment_id: commentId },
      select: { user_id: true },
    });
    if (!comment) return res.status(404).json({ message: "Comment not found." });
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, comment.user_id);

    const existing = await prisma.community_comment_vote.findUnique({
      where: {
        user_id_comment_id: { user_id: req.user.user_id, comment_id: commentId },
      },
    });

    if (existing?.vote_type === vote_type) {
      await prisma.community_comment_vote.delete({ where: { user_id_comment_id: { user_id: req.user.user_id, comment_id: commentId } } });
      await prisma.community_post_comment.update({ where: { comment_id: commentId }, data: { upvotes: { increment: -vote_type } } });
      return res.json({ successful: true, user_vote: 0 });
    }

    const delta = existing ? vote_type - existing.vote_type : vote_type;
    await prisma.community_comment_vote.upsert({
      where: { user_id_comment_id: { user_id: req.user.user_id, comment_id: commentId } },
      create: { user_id: req.user.user_id, comment_id: commentId, vote_type },
      update: { vote_type },
    });
    await prisma.community_post_comment.update({ where: { comment_id: commentId }, data: { upvotes: { increment: delta } } });

    res.json({ successful: true, user_vote: vote_type });
  } catch (err) {
    return handleCommunityError(res, err, "Vote failed");
  }
});

// PATCH /community-post/:id/moderate — mod actions on a post. Owner/manage_posts.
// Body: { action: "remove" | "restore" | "lock" | "unlock" | "pin" | "unpin" }
router.patch("/:id/moderate", authenticateToken, async (req, res) => {
  const postId = parseInt(req.params.id);
  const { action } = req.body;
  try {
    const post = await prisma.community_posts.findUnique({ where: { community_post_id: postId }, select: { community_id: true } });
    if (!post) return res.status(404).json({ message: "Post not found." });

    const ctx = await getModContext(post.community_id, req.user.user_id);
    if (!ctx.isMod || !ctx.can("manage_posts")) return res.status(403).json({ message: "Moderator permission required." });

    if (action === "remove")      await prisma.community_posts.update({ where: { community_post_id: postId }, data: { is_removed: true, removed_by: req.user.user_id } });
    else if (action === "restore") await prisma.community_posts.update({ where: { community_post_id: postId }, data: { is_removed: false, removed_by: null } });
    else if (action === "lock")    await prisma.community_posts.update({ where: { community_post_id: postId }, data: { is_locked: true } });
    else if (action === "unlock")  await prisma.community_posts.update({ where: { community_post_id: postId }, data: { is_locked: false } });
    else if (action === "pin" || action === "unpin") {
      const community = await prisma.community.findUnique({ where: { community_id: post.community_id }, select: { pinned_post_ids: true } });
      let pinned = community?.pinned_post_ids || [];
      if (action === "pin") pinned = [postId, ...pinned.filter(id => id !== postId)].slice(0, 2);
      else pinned = pinned.filter(id => id !== postId);
      await prisma.community.update({ where: { community_id: post.community_id }, data: { pinned_post_ids: pinned } });
    } else {
      return res.status(400).json({ message: "Invalid action." });
    }
    res.json({ successful: true, action });
  } catch (err) { console.error(err); res.status(500).json({ message: "Failed to moderate post." }); }
});

// ── Awards (#267) ────────────────────────────────────────────────────────────

// Group award_grant rows → [{ award_id, name, icon, color, count }] keyed by post/comment id.
async function awardSummary({ postIds = [], commentIds = [] }) {
    if (!postIds.length && !commentIds.length) return { byPost: {}, byComment: {} };
    const grants = await prisma.award_grant.findMany({
        where: { OR: [postIds.length ? { post_id: { in: postIds } } : undefined, commentIds.length ? { comment_id: { in: commentIds } } : undefined].filter(Boolean) },
        include: { award: { select: { award_id: true, name: true, icon: true, color: true } } },
    });
    const byPost = {}, byComment = {};
    for (const g of grants) {
        const bucket = g.target_type === 'comment' ? byComment : byPost;
        const key = g.target_type === 'comment' ? g.comment_id : g.post_id;
        if (key == null) continue;
        bucket[key] = bucket[key] || {};
        const a = bucket[key][g.award_id] || { award_id: g.award.award_id, name: g.award.name, icon: g.award.icon, color: g.award.color, count: 0 };
        a.count += 1;
        bucket[key][g.award_id] = a;
    }
    const flatten = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.values(v)]));
    return { byPost: flatten(byPost), byComment: flatten(byComment) };
}

// Validate an award can be given in a community (platform-wide or that community's custom).
async function resolveAward(awardId, communityId) {
    const award = await prisma.community_award.findUnique({ where: { award_id: parseInt(awardId, 10) } });
    if (!award) return null;
    if (award.community_id && award.community_id !== communityId) return null;
    return award;
}

// POST /community-post/:id/award  { award_id }
router.post('/:id/award', authenticateToken, async (req, res) => {
    try {
        const postId = parseInt(req.params.id, 10);
        const post = await prisma.community_posts.findUnique({ where: { community_post_id: postId }, select: { community_id: true } });
        if (!post) return res.status(404).json({ message: 'Post not found.' });
        const award = await resolveAward(req.body.award_id, post.community_id);
        if (!award) return res.status(400).json({ message: 'Invalid award for this community.' });
        await prisma.award_grant.create({ data: { award_id: award.award_id, giver_id: req.user.user_id, target_type: 'post', post_id: postId } });
        const { byPost } = await awardSummary({ postIds: [postId] });
        res.status(201).json({ successful: true, data: byPost[postId] || [] });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to give award.' }); }
});

// POST /community-post/comment/:commentId/award  { award_id }
router.post('/comment/:commentId/award', authenticateToken, async (req, res) => {
    try {
        const commentId = parseInt(req.params.commentId, 10);
        const comment = await prisma.community_post_comment.findUnique({ where: { comment_id: commentId }, select: { post_id: true, posts: { select: { community_id: true } } } });
        if (!comment) return res.status(404).json({ message: 'Comment not found.' });
        const award = await resolveAward(req.body.award_id, comment.posts?.community_id);
        if (!award) return res.status(400).json({ message: 'Invalid award for this community.' });
        await prisma.award_grant.create({ data: { award_id: award.award_id, giver_id: req.user.user_id, target_type: 'comment', comment_id: commentId } });
        const { byComment } = await awardSummary({ commentIds: [commentId] });
        res.status(201).json({ successful: true, data: byComment[commentId] || [] });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to give award.' }); }
});

export { awardSummary };
export default router;
