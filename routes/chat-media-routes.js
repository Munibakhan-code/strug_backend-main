import path from 'path';
import express from 'express';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { authenticateToken } from '../middleware/authentication.js';
import { generateVideoReadSAS, isTrustedBlobUrl, uploadVideoStream } from '../utils/azure-storage.js';
import {
  chatRoomName,
  createChatMessage,
  ensureChannelParticipant,
  sendChatError,
} from '../services/chat-service.js';
import { notifyChatRecipients } from '../services/chat-notification-service.js';
import { sanitizeWaveformPeaks, sanitizeMediaCaption } from '../utils/chat-media-metadata.js';
import { normalizeChatImageUpload } from '../utils/chat-media-normalize.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
function extractChatChannelIdFromBlobUrl(blobUrl) {
  try {
    const match = new URL(blobUrl).pathname.match(/\/chat\/(\d+)\//);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

router.get('/sign', authenticateToken, async (req, res) => {
  try {
    const blobUrl = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(blobUrl)) {
      return res.status(400).json({ error: 'url query parameter is required' });
    }

    const channelId = extractChatChannelIdFromBlobUrl(blobUrl);
    if (!channelId) {
      return res.status(400).json({ error: 'Unsupported chat media URL' });
    }

    // Only ever sign URLs that point at our own storage account + chat-media
    // container. Otherwise a crafted URL could leak a valid SAS to another host.
    const container = process.env.AZURE_CHAT_MEDIA_CONTAINER || 'chat-media';
    if (!isTrustedBlobUrl(blobUrl, container)) {
      return res.status(400).json({ error: 'Unsupported chat media URL' });
    }

    await ensureChannelParticipant(channelId, req.user.user_id);
    const signedUrl = generateVideoReadSAS(container, blobUrl.split('?')[0]);

    res.json({ signed_url: signedUrl, expires_in_seconds: 6 * 60 * 60 });
  } catch (err) {
    sendChatError(res, err, 'Failed to sign chat media URL');
  }
});

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'application/pdf',
]);

router.post('/channel/:channel_id', authenticateToken, upload.single('file'), async (req, res) => {
  const io = req.app.get('io');

  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const detected = await fileTypeFromBuffer(req.file.buffer);
    const mimeType = (detected?.mime || req.file.mimetype || '').toLowerCase();
    let normalizedMime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    // Browsers often tag voice-note WebM as video/webm (audio-only container).
    if (
      normalizedMime === 'video/webm' &&
      /^voice-/i.test(req.file.originalname || '')
    ) {
      normalizedMime = 'audio/webm';
    }
    if (!allowedMimeTypes.has(normalizedMime)) {
      return res.status(400).json({
        error: `Unsupported chat attachment type (${normalizedMime || 'unknown'})`,
      });
    }

    let uploadBuffer = req.file.buffer;
    let uploadSize = req.file.size;
    let uploadExt = detected?.ext || path.extname(req.file.originalname).toLowerCase().slice(1) || 'bin';
    try {
      const normalized = await normalizeChatImageUpload(req.file.buffer, normalizedMime);
      uploadBuffer = normalized.buffer;
      normalizedMime = normalized.mime;
      uploadSize = normalized.buffer.length;
      if (normalized.ext) uploadExt = normalized.ext;
    } catch (normErr) {
      if (normErr?.statusCode === 400) {
        return res.status(400).json({ error: normErr.message });
      }
      throw normErr;
    }

    const durationInput = req.body.duration_seconds ?? req.body.durationSeconds;
    const durationMsInput = req.body.duration_ms ?? req.body.durationMs;
    const durationSeconds = Number(durationInput);
    const durationMs = Number(durationMsInput);
    const safeDurationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds)
      : Number.isFinite(durationMs) && durationMs > 0
        ? Math.round(durationMs / 1000)
        : null;
    const safeDurationMs = safeDurationSeconds ? safeDurationSeconds * 1000 : null;

    let clientMetadata = {};
    if (req.body.metadata) {
      try {
        const parsed = JSON.parse(req.body.metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          clientMetadata = parsed;
        }
      } catch {
        /* ignore malformed metadata */
      }
    }

    const rawPeaks = clientMetadata.waveform_peaks;
    const waveformPeaks = sanitizeWaveformPeaks(rawPeaks);
    const caption = sanitizeMediaCaption(clientMetadata.caption);

    const originalExt = path.extname(req.file.originalname).toLowerCase();
    const extension = uploadExt || detected?.ext || originalExt.slice(1) || 'bin';
    const channelId = Number(req.params.channel_id);
    await ensureChannelParticipant(channelId, req.user.user_id);
    const blobName = `chat/${channelId}/${req.user.user_id}-${Date.now()}.${extension}`;
    const container = process.env.AZURE_CHAT_MEDIA_CONTAINER || 'chat-media';
    const mediaUrl = await uploadVideoStream(
      container,
      blobName,
      uploadBuffer,
      normalizedMime,
    );
    const contentType =
      normalizedMime.split('/')[0] === 'application'
        ? 'file'
        : normalizedMime.split('/')[0];

    const message = await createChatMessage({
      channelId,
      senderId: req.user.user_id,
      content: mediaUrl,
      contentType,
      metadata: {
        filename: req.file.originalname,
        mime_type: normalizedMime,
        size: uploadSize,
        url: mediaUrl,
        ...(safeDurationSeconds ? { duration_seconds: safeDurationSeconds, duration_ms: safeDurationMs } : {}),
        ...(waveformPeaks?.length ? { waveform_peaks: waveformPeaks } : {}),
        ...(caption ? { caption } : {}),
      },
    });

    io?.to(chatRoomName(channelId)).emit('message-created', message);
    await notifyChatRecipients(io, {
      channelId,
      senderId: req.user.user_id,
      messageId: message.message_id,
      content: message.content,
    });

    res.status(201).json(message);
  } catch (err) {
    sendChatError(res, err, 'Failed to upload chat attachment');
  }
});

export default router;
