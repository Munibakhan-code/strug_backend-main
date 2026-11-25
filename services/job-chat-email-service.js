import prisma from '../utils/prisma-client.js';
import { sendEmail } from './email-service.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Optional email when a message lands on a job_application chat channel.
 * Opt-in via JOB_CHAT_EMAIL=true. Debounced to one email per turn (same pattern as support).
 * Fire-and-forget — never throws to the message route.
 */
export async function notifyJobApplicationChatMessage({ channelId, senderId, content, messageId }) {
  try {
    if (process.env.JOB_CHAT_EMAIL !== 'true') return false;

    const cid = Number(channelId);
    if (!cid) return false;

    const channel = await prisma.chat_channel.findUnique({
      where: { channel_id: cid },
      select: { context_type: true, context_id: true },
    });
    if (!channel || channel.context_type !== 'job_application') return false;

    const recipients = await prisma.chat_participants.findMany({
      where: { channel_id: cid, user_id: { not: Number(senderId) } },
      select: { user_id: true },
    });
    if (!recipients.length) return false;

    // Debounce. Two guards, both needed:
    //  - same sender as the previous message => a burst, not a new turn.
    //  - previous message is recent => the thread is live and the recipient is almost
    //    certainly already looking at it, so an email is noise. Only once the thread has
    //    gone quiet does a new message warrant one. Without this, an alternating
    //    back-and-forth emails on every single message.
    const prev = await prisma.chat_messages.findFirst({
      where: { channel_id: cid, message_id: { not: Number(messageId) || undefined } },
      orderBy: { sent_at: 'desc' },
      select: { sender_id: true, sent_at: true },
    });
    if (prev && Number(prev.sender_id) === Number(senderId)) return false;
    const quietMs = Number(process.env.JOB_CHAT_EMAIL_QUIET_MS) || 15 * 60 * 1000;
    if (prev?.sent_at && Date.now() - new Date(prev.sent_at).getTime() < quietMs) return false;

    const sender = await prisma.user.findUnique({
      where: { user_id: Number(senderId) },
      select: {
        name: true,
        email: true,
        // social_profiles is a to-one relation (schema.prisma:2311) — no `take`, no [0].
        social_profiles: { select: { display_name: true, handle: true } },
      },
    });
    const who = sender?.social_profiles?.display_name
      || sender?.social_profiles?.handle
      || sender?.name
      || `User #${senderId}`;

    let jobTitle = 'a job application';
    const appId = Number(channel.context_id);
    if (Number.isFinite(appId)) {
      const app = await prisma.job_application.findUnique({
        where: { job_application_id: appId },
        include: { jobs: { select: { job_name: true } } },
      });
      if (app?.jobs?.job_name) jobTitle = app.jobs.job_name;
    }

    const body = content ? String(content).slice(0, 500) : '(no text)';
    const users = await prisma.user.findMany({
      where: { user_id: { in: recipients.map((r) => r.user_id) } },
      select: { email: true },
    });

    // Emails are stored plaintext (encryptedFields is empty), and support-email-service.js:61
    // reads them directly. Decrypting here only worked because decrypt() throws on non-hex
    // input and the catch fell back to the raw value.
    const to = users.map((u) => u.email).filter(Boolean);
    if (!to.length) return false;

    await sendEmail({
      to,
      subject: `New Jobs message about ${jobTitle}`,
      html: `<p><strong>${escapeHtml(who)}</strong> messaged you about <strong>${escapeHtml(jobTitle)}</strong>.</p>
<p>${escapeHtml(body)}</p>
<p><a href="${escapeHtml(process.env.FRONTEND_URL || 'https://app.strug.ca')}/messages?channel=${cid}">Open conversation</a></p>`,
    });
    return true;
  } catch (err) {
    console.error('Job application chat email failed:', err.message);
    return false;
  }
}
