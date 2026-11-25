// Universal favourites — a polymorphic "save" across every vertical.
// Mounts at /saves. The client passes an entity_type + entity_id (and a small
// `meta` display snapshot) so the Favourites page can render saved items from
// any vertical without hydrating each one from its own service.
import express from "express";
import { authenticateToken } from "../middleware/authentication.js";
import prisma from "../utils/prisma-client.js";

const router = express.Router();

// Keep entity_type to a known set so the table can't be used as a free-form KV
// store; extend as new verticals add a save button.
const ENTITY_TYPES = new Set([
  "product", "event", "venue", "vehicle", "stay", "service",
  "experience", "listing", "course", "property", "campaign", "artwork",
  "quote_provider", "restaurant", "florist",
  // Profile book recommendation / reading list (dg_content id or curated:slug).
  "book",
]);

const str = (v) => (v == null ? "" : String(v)).trim();

// POST /saves — toggle a save. Body: { entity_type, entity_id, meta? }.
// Returns { saved: true } when created, { saved: false } when removed.
router.post("/", authenticateToken, async (req, res) => {
  try {
    const entity_type = str(req.body?.entity_type);
    const entity_id = str(req.body?.entity_id);
    if (!entity_type || !entity_id) {
      return res.status(400).json({ successful: false, message: "entity_type and entity_id are required" });
    }
    if (!ENTITY_TYPES.has(entity_type)) {
      return res.status(400).json({ successful: false, message: "Unknown entity_type" });
    }
    if (entity_id.length > 128) {
      return res.status(400).json({ successful: false, message: "entity_id too long" });
    }
    const key = { user_id_entity_type_entity_id: { user_id: req.user.user_id, entity_type, entity_id } };
    const existing = await prisma.saved_item.findUnique({ where: key });
    if (existing) {
      await prisma.saved_item.delete({ where: key });
      return res.json({ successful: true, saved: false });
    }
    const meta = (req.body?.meta && typeof req.body.meta === "object") ? req.body.meta : undefined;
    const item = await prisma.saved_item.create({
      data: { user_id: req.user.user_id, entity_type, entity_id, meta },
    });
    res.json({ successful: true, saved: true, data: item });
  } catch (err) {
    console.error("[saves] toggle error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to toggle save" });
  }
});

// GET /saves — the caller's saved items, newest first. Optional ?type= filter.
router.get("/", authenticateToken, async (req, res) => {
  try {
    const where = { user_id: req.user.user_id };
    if (req.query.type) where.entity_type = String(req.query.type);
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Number(req.query.offset) || 0;
    const items = await prisma.saved_item.findMany({
      where, orderBy: { saved_at: "desc" }, take: limit, skip: offset,
    });
    res.json({ successful: true, data: items });
  } catch (err) {
    console.error("[saves] list error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to load saves" });
  }
});

// DELETE /saves/:id — remove one saved item by id (owner only).
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: "Invalid id" });
    const item = await prisma.saved_item.findUnique({ where: { id } });
    if (!item || item.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: "Not found" });
    }
    await prisma.saved_item.delete({ where: { id } });
    res.json({ successful: true });
  } catch (err) {
    console.error("[saves] delete error:", err.message);
    res.status(500).json({ successful: false, message: "Failed to remove save" });
  }
});

export default router;
