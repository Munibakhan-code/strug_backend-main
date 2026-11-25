import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { checkHealth, createVoice, generateSpeech, generateLongForm } from '../services/voiceai-service.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const AVATAR_PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669'];
const randomAvatar = () => AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];

// Same fixed line for every voice, so previews are directly comparable.
const SAMPLE_TEXT = 'Hi, this is a quick preview of my voice.';

const toPresetView = (preset) => ({
  id: preset.voiceai_voice_preset_id,
  name: preset.name,
  avatar: preset.avatar,
  avatar_url: preset.avatar_url,
  sample_url: preset.sample_url,
  created_at: preset.created_at,
});

// Uploads an optional profile picture for a voice. Returns null (never
// throws) on anything other than a valid image file, so a bad/missing
// avatar never blocks saving the voice itself.
async function uploadAvatarImage(modalVoiceId, file) {
  if (!file || !file.mimetype?.startsWith('image/')) return null;
  try {
    const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const containerName = process.env.AZURE_VOICEAI_CONTAINER || 'voiceai-audio';
    return await uploadPublicBlob(containerName, `avatars/${modalVoiceId}.${ext}`, file.buffer, file.mimetype);
  } catch {
    return null;
  }
}

// Generates the fixed-text preview clip and uploads it to blob storage.
// Never throws — a failed sample must not block voice creation or a
// generate call; the lazy /sample endpoint below can retry it later.
async function generateAndSaveSample(preset) {
  try {
    const { buffer, contentType } = await generateSpeech(preset.modal_voice_id, { text: SAMPLE_TEXT });
    const containerName = process.env.AZURE_VOICEAI_CONTAINER || 'voiceai-audio';
    const sampleUrl = await uploadPublicBlob(containerName, `samples/${preset.modal_voice_id}.wav`, buffer, contentType);
    return prisma.voiceai_voice_preset.update({
      where: { voiceai_voice_preset_id: preset.voiceai_voice_preset_id },
      data: { sample_url: sampleUrl },
    });
  } catch {
    return preset;
  }
}

router.get('/health', authenticateToken, async (req, res, next) => {
  try {
    return res.json(await checkHealth());
  } catch (err) {
    return next(err);
  }
});

// PHASE 1: every saved voice is visible to everyone (global), while we build
// up the shared library. We still record the real uploader on each row
// (below), so nothing is lost when phase 2 adds personal-only scoping later.
router.get('/voices', authenticateToken, async (req, res, next) => {
  try {
    const presets = await prisma.voiceai_voice_preset.findMany({
      orderBy: { created_at: 'desc' },
    });
    return res.json(presets.map(toPresetView));
  } catch (err) {
    return next(err);
  }
});

const voiceUpload = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'avatar', maxCount: 1 }]);

router.post('/voices', authenticateToken, voiceUpload, async (req, res, next) => {
  const name = (req.body?.name || '').trim();
  const referenceFile = req.files?.file?.[0];
  if (!name) return res.status(400).json({ error: 'Invalid request', details: 'name is required' });
  if (!referenceFile) return res.status(400).json({ error: 'Invalid request', details: 'file is required' });

  try {
    const modalVoice = await createVoice({
      name,
      buffer: referenceFile.buffer,
      fileName: referenceFile.originalname,
      mimeType: referenceFile.mimetype,
    });

    const avatarUrl = await uploadAvatarImage(modalVoice.id, req.files?.avatar?.[0]);

    const preset = await prisma.voiceai_voice_preset.create({
      data: {
        user_id: req.user.user_id,
        modal_voice_id: modalVoice.id,
        name: modalVoice.name || name,
        avatar: randomAvatar(),
        avatar_url: avatarUrl,
      },
    });

    const withSample = await generateAndSaveSample(preset);
    return res.json(toPresetView(withSample));
  } catch (err) {
    return next(err);
  }
});

// Lazy backfill for voices saved before the preview-sample feature existed.
router.post('/voices/:id/sample', authenticateToken, async (req, res, next) => {
  try {
    const preset = await findPreset(req.params.id);
    if (!preset) return res.status(404).json({ error: 'Voice not found' });
    if (preset.sample_url) return res.json(toPresetView(preset));

    const withSample = await generateAndSaveSample(preset);
    return res.json(toPresetView(withSample));
  } catch (err) {
    return next(err);
  }
});

// Lets a picture be attached/replaced on a voice after the fact — used for
// voices saved before this feature existed, or to swap a bad image later.
router.post('/voices/:id/avatar', authenticateToken, upload.single('avatar'), async (req, res, next) => {
  try {
    const preset = await findPreset(req.params.id);
    if (!preset) return res.status(404).json({ error: 'Voice not found' });
    if (!req.file) return res.status(400).json({ error: 'Invalid request', details: 'avatar file is required' });

    const avatarUrl = await uploadAvatarImage(preset.modal_voice_id, req.file);
    if (!avatarUrl) return res.status(400).json({ error: 'Invalid request', details: 'avatar must be an image file' });

    const updated = await prisma.voiceai_voice_preset.update({
      where: { voiceai_voice_preset_id: preset.voiceai_voice_preset_id },
      data: { avatar_url: avatarUrl },
    });
    return res.json(toPresetView(updated));
  } catch (err) {
    return next(err);
  }
});

const generateSchema = z.object({
  text: z.string().min(1).max(3000),
  exaggeration: z.number().min(0).max(2).optional().default(0.5),
  languageId: z.string().optional().nullable().default(null),
  variant: z.enum(['turbo', 'original', 'multilingual']).optional().default('original'),
});

// PHASE 1: voices are global (see GET /voices above), so lookup isn't
// restricted to the requesting user — any authenticated user can generate
// with any saved voice. Revisit alongside the personal-scoping phase.
async function findPreset(voiceIdParam) {
  const id = Number(voiceIdParam);
  if (!Number.isInteger(id)) return null;
  return prisma.voiceai_voice_preset.findUnique({
    where: { voiceai_voice_preset_id: id },
  });
}

router.post('/generate/:voiceId', authenticateToken, async (req, res, next) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: (parsed.error.issues ?? parsed.error.errors) });
  }

  try {
    const preset = await findPreset(req.params.voiceId);
    if (!preset) return res.status(404).json({ error: 'Voice not found' });

    const { text, exaggeration, languageId, variant } = parsed.data;
    const { buffer, contentType } = await generateSpeech(preset.modal_voice_id, { text, exaggeration, languageId, variant });

    res.set('Content-Type', contentType);
    res.send(buffer);

    // Persist after the response has already gone out — storage hiccups must
    // never block or fail audio delivery the user already received.
    (async () => {
      try {
        const containerName = process.env.AZURE_VOICEAI_CONTAINER || 'voiceai-audio';
        const blobName = `${req.user.user_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
        const audioUrl = await uploadPublicBlob(containerName, blobName, buffer, contentType);
        await prisma.voiceai_generation.create({
          data: {
            user_id: req.user.user_id,
            text,
            exaggeration,
            modal_voice_id: preset.modal_voice_id,
            audio_url: audioUrl,
            status: 'completed',
          },
        });
      } catch {}
    })();
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Voice not found' });
    return next(err);
  }
});

const longFormSchema = z.object({
  text: z.string().min(1).max(20000),
  variant: z.enum(['turbo', 'original', 'multilingual']).optional().default('original'),
});

router.post('/long-form/:voiceId', authenticateToken, async (req, res, next) => {
  const parsed = longFormSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: (parsed.error.issues ?? parsed.error.errors) });
  }

  try {
    const preset = await findPreset(req.params.voiceId);
    if (!preset) return res.status(404).json({ error: 'Voice not found' });

    const { buffer, contentType } = await generateLongForm(preset.modal_voice_id, parsed.data);
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'inline; filename="narration.wav"');
    return res.send(buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Voice not found' });
    return next(err);
  }
});

router.get('/history', authenticateToken, async (req, res, next) => {
  try {
    const history = await prisma.voiceai_generation.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return res.json(history);
  } catch (err) {
    return next(err);
  }
});

export default router;
