import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

async function ensureJournalAccess(channelId, userId) {
  const participant = await prisma.chat_participants.findFirst({
    where: { channel_id: Number(channelId), user_id: Number(userId), left_at: null },
  });
  if (!participant) throw Object.assign(new Error('Forbidden'), { status: 403 });
}

// ─── Highlights ─────────────────────────────────────────────────────────────

router.get('/:channel_id/highlights', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const highlights = await prisma.journal_highlight.findMany({
      where: { channel_id: Number(req.params.channel_id) },
      include: { user: { select: { user_id: true, name: true, username: true } } },
      orderBy: { created_at: 'desc' },
    });
    res.json(highlights);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.post('/:channel_id/highlights', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { message_id, content, content_type, media_url, note } = req.body;
    const highlight = await prisma.journal_highlight.create({
      data: {
        channel_id: Number(req.params.channel_id),
        saved_by: req.user.user_id,
        message_id: message_id ? Number(message_id) : null,
        content,
        content_type,
        media_url,
        note,
      },
    });
    res.status(201).json(highlight);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.patch('/:channel_id/highlights/:id', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { note } = req.body;
    const updated = await prisma.journal_highlight.updateMany({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id), saved_by: req.user.user_id },
      data: { note },
    });
    if (updated.count === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.delete('/:channel_id/highlights/:id', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    await prisma.journal_highlight.deleteMany({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id), saved_by: req.user.user_id },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ─── Bucket List ─────────────────────────────────────────────────────────────

router.get('/:channel_id/bucket', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const items = await prisma.journal_bucket_item.findMany({
      where: { channel_id: Number(req.params.channel_id) },
      include: { user: { select: { user_id: true, name: true, username: true } } },
      orderBy: [{ is_completed: 'asc' }, { created_at: 'desc' }],
    });
    res.json(items);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.post('/:channel_id/bucket', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { title, description, emoji, category, due_date, priority } = req.body;
    const item = await prisma.journal_bucket_item.create({
      data: {
        channel_id: Number(req.params.channel_id),
        created_by: req.user.user_id,
        title,
        description,
        emoji,
        category,
        due_date: due_date ? new Date(due_date) : null,
        priority: priority ?? 'medium',
      },
    });
    res.status(201).json(item);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.patch('/:channel_id/bucket/:id', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { title, description, emoji, category, due_date, priority, is_completed, completion_note, completion_media } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (emoji !== undefined) data.emoji = emoji;
    if (category !== undefined) data.category = category;
    if (due_date !== undefined) data.due_date = due_date ? new Date(due_date) : null;
    if (priority !== undefined) data.priority = priority;
    if (is_completed !== undefined) {
      data.is_completed = is_completed;
      if (is_completed) {
        data.completed_at = new Date();
        data.completed_by = req.user.user_id;
      } else {
        data.completed_at = null;
        data.completed_by = null;
      }
    }
    if (completion_note !== undefined) data.completion_note = completion_note;
    if (completion_media !== undefined) data.completion_media = completion_media;
    const updated = await prisma.journal_bucket_item.updateMany({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id) },
      data,
    });
    if (updated.count === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.delete('/:channel_id/bucket/:id', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    await prisma.journal_bucket_item.deleteMany({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id) },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ─── Time Capsules ─────────────────────────────────────────────────────────

router.get('/:channel_id/capsules', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const capsules = await prisma.journal_time_capsule.findMany({
      where: { channel_id: Number(req.params.channel_id) },
      include: {
        creator: { select: { user_id: true, name: true, username: true } },
        partner_user: { select: { user_id: true, name: true, username: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    const now = new Date();
    const result = await Promise.all(capsules.map(async (c) => {
      if (!c.is_unlocked && c.unlock_date <= now) {
        await prisma.journal_time_capsule.update({ where: { id: c.id }, data: { is_unlocked: true } });
        c.is_unlocked = true;
      }
      const has_partner_contributed = !!c.partner_id;
      if (!c.is_unlocked) {
        c.contents = null;
        c.partner_contents = null;
      }
      return { ...c, has_partner_contributed };
    }));
    res.json(result);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.post('/:channel_id/capsules', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { title, description, cover_url, unlock_date, contents } = req.body;
    if (!unlock_date) return res.status(400).json({ error: 'unlock_date is required' });
    const capsule = await prisma.journal_time_capsule.create({
      data: {
        channel_id: Number(req.params.channel_id),
        created_by: req.user.user_id,
        title,
        description,
        cover_url,
        unlock_date: new Date(unlock_date),
        contents,
      },
    });
    res.status(201).json(capsule);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.patch('/:channel_id/capsules/:id/contribute', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const { note } = req.body;
    const capsule = await prisma.journal_time_capsule.findFirst({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id) },
    });
    if (!capsule) return res.status(404).json({ error: 'Not found' });
    if (capsule.created_by === req.user.user_id) return res.status(400).json({ error: 'Creator uses the main contents field' });
    if (capsule.partner_id && capsule.partner_id !== req.user.user_id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.journal_time_capsule.update({
      where: { id: Number(req.params.id) },
      data: { partner_contents: { note }, partner_id: req.user.user_id },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.delete('/:channel_id/capsules/:id', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    await prisma.journal_time_capsule.deleteMany({
      where: { id: Number(req.params.id), channel_id: Number(req.params.channel_id), created_by: req.user.user_id },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ─── Monthly Memories ────────────────────────────────────────────────────────

router.get('/:channel_id/monthly/:year/:month', authenticateToken, async (req, res) => {
  try {
    await ensureJournalAccess(req.params.channel_id, req.user.user_id);
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    const messages = await prisma.chat_messages.findMany({
      where: {
        channel_id: Number(req.params.channel_id),
        sent_at: { gte: start, lt: end },
        deleted_at: null,
      },
      select: { message_id: true, sender_id: true, content_type: true, content: true, sent_at: true, metadata: true },
    });

    const total = messages.length;
    const photos = messages.filter(m => m.content_type === 'image').length;
    const videos = messages.filter(m => m.content_type === 'video').length;
    const audio = messages.filter(m => m.content_type === 'audio').length;
    const files = messages.filter(m => m.content_type === 'file').length;
    const links = messages.filter(m => m.content_type === 'link').length;
    const locations = messages.filter(m => m.content_type === 'location').length;
    const reactions = messages.reduce((acc, m) => {
      if (m.metadata?.reactions) {
        return acc + Object.values(m.metadata.reactions).reduce((s, arr) => s + arr.length, 0);
      }
      return acc;
    }, 0);

    const dayCounts = {};
    for (const m of messages) {
      if (m.sent_at) {
        const day = m.sent_at.toISOString().slice(0, 10);
        dayCounts[day] = (dayCounts[day] ?? 0) + 1;
      }
    }
    const most_active_day = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const media = messages
      .filter(m => ['image', 'video'].includes(m.content_type))
      .slice(0, 60)
      .map(m => ({ message_id: m.message_id, content_type: m.content_type, content: m.content, sent_at: m.sent_at }));

    res.json({ year, month, total, photos, videos, audio, files, links, locations, reactions, most_active_day, media });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

export default router;
