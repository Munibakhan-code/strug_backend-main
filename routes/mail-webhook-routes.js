/**
 * Phase 5: inbound mail events (bounce / complaint) → suppression list.
 * Stub accepts a shared-secret POSTed payload from an ESP or SMTP relay webhook.
 * Not production-hardened signature schemes (Resend/SNS/etc.); extend when cutover lands.
 */
import express from 'express';
import {
  upsertMailSuppression,
  SUPPRESSION_REASONS,
} from '../services/mail/suppression.js';

const router = express.Router();

function webhookSecret() {
  return String(process.env.MAIL_WEBHOOK_SECRET || '').trim();
}

function authorizeWebhook(req, res, next) {
  const expected = webhookSecret();
  if (!expected) {
    return res.status(503).json({
      message: 'Mail webhook disabled (set MAIL_WEBHOOK_SECRET)',
    });
  }
  const header =
    req.get('x-mail-webhook-secret') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!header || header !== expected) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  return next();
}

/**
 * Normalize common ESP shapes into { email, reason }.
 * Supports:
 *   { email, reason?, type?, event? }
 *   { type: 'email.bounced'|'email.complained', data: { email } }  (Resend-ish)
 *   { Message: "<sns json string>" }  (passthrough unwrap only)
 */
export function parseMailWebhookPayload(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Body must be a JSON object' };
  }

  let payload = body;
  if (typeof body.Message === 'string') {
    try {
      payload = JSON.parse(body.Message);
    } catch {
      return { error: 'Invalid SNS Message JSON' };
    }
  }

  const type = String(
    payload.type || payload.event || payload.notificationType || '',
  )
    .trim()
    .toLowerCase();

  let email =
    payload.email ||
    payload.to ||
    payload.recipient ||
    payload.data?.email ||
    payload.mail?.destination?.[0] ||
    null;
  if (Array.isArray(email)) email = email[0];
  email = String(email || '')
    .trim()
    .toLowerCase();

  if (!email || !email.includes('@')) {
    return { error: 'Missing or invalid email' };
  }

  let reason = String(payload.reason || '').trim().toLowerCase();
  if (!SUPPRESSION_REASONS.includes(reason)) {
    if (/complaint|spam|complained/.test(type) || reason === 'spam') {
      reason = 'complaint';
    } else if (/bounce|bounced|hard/.test(type) || /bounce/.test(reason)) {
      reason = 'bounce';
    } else if (/unsub/.test(type) || /unsub/.test(reason)) {
      reason = 'unsubscribe';
    } else {
      reason = 'bounce';
    }
  }

  return {
    email,
    reason,
    source: String(payload.source || payload.provider || 'webhook').slice(0, 64),
    note: payload.note ? String(payload.note).slice(0, 500) : `event:${type || reason}`,
  };
}

/**
 * POST /mail/webhook/events
 * Headers: X-Mail-Webhook-Secret: <MAIL_WEBHOOK_SECRET>
 * Body: { email, reason?: 'bounce'|'complaint'|…, type?: string }
 */
router.post('/events', authorizeWebhook, async (req, res) => {
  try {
    const parsed = parseMailWebhookPayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const row = await upsertMailSuppression({
      to: parsed.email,
      reason: parsed.reason,
      source: parsed.source,
      note: parsed.note,
    });

    res.json({
      ok: true,
      suppressed: true,
      reason: row.reason,
      to_hint: row.to_hint,
      to_hash: row.to_hash,
    });
  } catch (err) {
    console.error('[Mail Webhook] failed:', err?.message || err);
    res.status(500).json({ message: 'Failed to record suppression' });
  }
});

export default router;
