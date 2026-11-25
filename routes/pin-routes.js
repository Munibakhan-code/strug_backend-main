// Pinboard — user-created visual pins (Pinterest-style). Mounts at /pins.
import express from "express";
import { authenticateToken, optionalAuth } from "../middleware/authentication.js";
import prisma from "../utils/prisma-client.js";
import { assertNoPlatformBlockBetweenUsers, blockedGraphForUser } from "../utils/platform-blocks.js";

const router = express.Router();

const str = (v) => (v == null ? "" : String(v)).trim();

function handlePinError(res, err, fallbackMessage) {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ successful: false, message: err.message || "This interaction is not available." });
  }
  console.error("[pins] error:", err.message);
  return res.status(500).json({ successful: false, message: fallbackMessage });
}

// image_url/target_url are rendered into <img src>/<a href> for other users, so
// only allow http(s) — reject javascript:/data:/blob:/file: (XSS). Empty is ok.
function safeUrlOrNull(v) {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") ? s : null;
  } catch { return null; }
}

// Attach author display info without a Prisma relation (one batched query).
async function withAuthors(pins) {
  const ids = [...new Set(pins.map((p) => p.user_id))];
  if (!ids.length) return pins;
  const users = await prisma.user.findMany({
    where: { user_id: { in: ids } },
    select: { user_id: true, name: true },
  });
  const byId = Object.fromEntries(users.map((u) => [u.user_id, u]));
  return pins.map((p) => ({ ...p, author_name: byId[p.user_id]?.name ?? "User" }));
}

// POST /pins — create a pin. Body: { title, description?, category?, image_url?, target_url? }.
router.post("/", authenticateToken, async (req, res) => {
  try {
    const title = str(req.body?.title);
    if (!title) return res.status(400).json({ successful: false, message: "title is required" });
    if (title.length > 200) return res.status(400).json({ successful: false, message: "title too long" });
    const pin = await prisma.pin.create({
      data: {
        user_id: req.user.user_id,
        title,
        description: str(req.body?.description) || null,
        category: str(req.body?.category) || null,
        image_url: safeUrlOrNull(req.body?.image_url),
        target_url: safeUrlOrNull(req.body?.target_url),
      },
    });
    res.status(201).json({ successful: true, data: pin });
  } catch (err) {
    console.error("[pins] create error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to create pin" });
  }
});

// GET /pins — public feed, newest first. Optional ?category=, pagination.
router.get("/", optionalAuth, async (req, res) => {
  try {
    const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { userIds: [] };
    const where = blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {};
    if (req.query.category && req.query.category !== "All") where.category = String(req.query.category);
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const offset = Number(req.query.offset) || 0;
    const pins = await prisma.pin.findMany({
      where, orderBy: { pin_id: "desc" }, take: limit, skip: offset,
    });
    res.json({ successful: true, data: await withAuthors(pins) });
  } catch (err) {
    console.error("[pins] feed error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to load pins" });
  }
});

// GET /pins/mine — the caller's pins.
router.get("/mine", authenticateToken, async (req, res) => {
  try {
    const pins = await prisma.pin.findMany({
      where: { user_id: req.user.user_id }, orderBy: { pin_id: "desc" },
    });
    res.json({ successful: true, data: await withAuthors(pins) });
  } catch (err) {
    console.error("[pins] mine error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to load your pins" });
  }
});

// GET /pins/saved — pins the caller has saved to their board, newest save first.
// Literal route — registered before the bare "/:id/..." params below.
router.get("/saved", authenticateToken, async (req, res) => {
  try {
    const blockedGraph = await blockedGraphForUser(req.user.user_id);
    const saves = await prisma.pin_save.findMany({
      where: { user_id: req.user.user_id }, orderBy: { pin_save_id: "desc" },
    });
    const pinIds = saves.map((s) => s.pin_id);
    if (!pinIds.length) return res.json({ successful: true, data: [] });
    const pins = await prisma.pin.findMany({
      where: {
        pin_id: { in: pinIds },
        ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
      },
    });
    const byId = Object.fromEntries(pins.map((p) => [p.pin_id, p]));
    const ordered = saves.map((s) => byId[s.pin_id]).filter(Boolean); // preserve save order
    res.json({ successful: true, data: await withAuthors(ordered) });
  } catch (err) {
    console.error("[pins] saved error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to load saved pins" });
  }
});

// POST /pins/:id/save — toggle the pin on the caller's board. Returns { saved }.
router.post("/:id/save", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const pin = await prisma.pin.findUnique({ where: { pin_id: id } });
    if (!pin) return res.status(404).json({ successful: false, message: "Not found" });
    const existing = await prisma.pin_save.findUnique({
      where: { pin_id_user_id: { pin_id: id, user_id: req.user.user_id } },
    });
    if (existing) {
      await prisma.pin_save.delete({ where: { pin_save_id: existing.pin_save_id } });
      return res.json({ successful: true, saved: false });
    }
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, pin.user_id);
    await prisma.pin_save.create({ data: { pin_id: id, user_id: req.user.user_id } });
    res.json({ successful: true, saved: true });
  } catch (err) {
    return handlePinError(res, err, "Failed to save pin");
  }
});

// GET /pins/:id/comments — public, newest first.
router.get("/:id/comments", optionalAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { userIds: [] };
    const comments = await prisma.pin_comment.findMany({
      where: {
        pin_id: id,
        ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
      },
      orderBy: { pin_comment_id: "desc" },
      take: limit,
    });
    res.json({ successful: true, data: await withAuthors(comments) });
  } catch (err) {
    console.error("[pins] comments error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to load comments" });
  }
});

// POST /pins/:id/comments — add a comment. Body: { body }.
router.post("/:id/comments", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const body = str(req.body?.body);
    if (!body) return res.status(400).json({ successful: false, message: "Comment is required" });
    if (body.length > 1000) return res.status(400).json({ successful: false, message: "Comment too long" });
    const pin = await prisma.pin.findUnique({ where: { pin_id: id } });
    if (!pin) return res.status(404).json({ successful: false, message: "Not found" });
    await assertNoPlatformBlockBetweenUsers(req.user.user_id, pin.user_id);
    const comment = await prisma.pin_comment.create({
      data: { pin_id: id, user_id: req.user.user_id, body },
    });
    const [withAuthor] = await withAuthors([comment]);
    res.status(201).json({ successful: true, data: withAuthor });
  } catch (err) {
    return handlePinError(res, err, "Failed to add comment");
  }
});

// DELETE /pins/comments/:commentId — comment author only.
router.delete("/comments/:commentId", authenticateToken, async (req, res) => {
  try {
    const cid = Number(req.params.commentId);
    if (!Number.isInteger(cid)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const comment = await prisma.pin_comment.findUnique({ where: { pin_comment_id: cid } });
    if (!comment || comment.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: "Not found" });
    }
    await prisma.pin_comment.delete({ where: { pin_comment_id: cid } });
    res.json({ successful: true });
  } catch (err) {
    console.error("[pins] delete comment error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to delete comment" });
  }
});

// DELETE /pins/:id — owner only.
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const pin = await prisma.pin.findUnique({ where: { pin_id: id } });
    if (!pin || pin.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: "Not found" });
    }
    await prisma.pin.delete({ where: { pin_id: id } });
    res.json({ successful: true });
  } catch (err) {
    console.error("[pins] delete error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to delete pin" });
  }
});

export default router;
