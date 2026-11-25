import prisma from '../utils/prisma-client.js';
import { sendEmail } from './email-service.js';

// Fallback tech-support inbox, used ONLY when the conversation's support agent has no email on file.
// The primary recipient is the ENGINEER handling the conversation (see below). The customer/reporter
// is NEVER emailed here — they get the in-app notification via notifyChatRecipients instead.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@strug.ca';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// When a CUSTOMER posts a message in a support conversation (chat_channel.context_type === 'support'),
// email the AGENT handling that conversation so they know to respond. Bug board #468 asked for support replies
// to reach the user via Notifications (already handled by notifyChatRecipients); this is the other
// direction — alert the humans on the support side by email. NEVER emails the customer.
//
// Fail-open: any lookup/send error is swallowed so it can't break sending the chat message. Call it
// fire-and-forget from the message route.
//
// Debounced: only emails when this message opens a NEW customer turn — i.e. the previous message in
// the channel was from the support agent (or there was none). Consecutive customer messages don't
// re-alert, so a burst of 5 messages sends 1 email, not 5.
export async function notifyTechSupportOnCustomerMessage({ channelId, senderId, content, messageId }) {
  try {
    const cid = Number(channelId);
    if (!cid) return false;

    const channel = await prisma.chat_channel.findUnique({
      where: { channel_id: cid },
      select: { context_type: true, context_id: true, channel_name: true },
    });
    if (!channel || channel.context_type !== 'support') return false;

    // Roles on the two participants: 'customer' vs 'support_agent'. Only alert on the customer's
    // messages — an agent's own reply must not email the support inbox.
    const participants = await prisma.chat_participants.findMany({
      where: { channel_id: cid },
      select: { user_id: true, role: true },
    });
    const senderRole = participants.find((p) => p.user_id === Number(senderId))?.role;
    if (senderRole === 'support_agent') return false;
    const agentUserIds = participants.filter((p) => p.role === 'support_agent').map((p) => p.user_id);

    // Debounce: look at the message immediately before this one. If it was also from the customer
    // (i.e. NOT from an agent), support has already been alerted for this turn — skip.
    const prev = await prisma.chat_messages.findFirst({
      where: { channel_id: cid, message_id: { not: Number(messageId) || undefined } },
      orderBy: { sent_at: 'desc' },
      select: { sender_id: true },
    });
    if (prev && !agentUserIds.includes(prev.sender_id)) return false;

    // Route the alert to the ENGINEER handling THIS conversation — the support agent(s) on the
    // channel — not a shared inbox. Fall back to SUPPORT_EMAIL only if no agent has an email on file.
    const agents = agentUserIds.length
      ? await prisma.user.findMany({ where: { user_id: { in: agentUserIds } }, select: { email: true } })
      : [];
    const agentEmails = agents.map((a) => a.email).filter(Boolean);
    const to = agentEmails.length ? agentEmails : [SUPPORT_EMAIL];

    const sender = await prisma.user.findUnique({
      where: { user_id: Number(senderId) },
      select: {
        email: true,
        social_profiles: { select: { display_name: true, handle: true }, take: 1 },
      },
    });
    const who = sender?.social_profiles?.[0]?.display_name
      || sender?.social_profiles?.[0]?.handle
      || sender?.email
      || `User #${senderId}`;
    const ticket = channel.context_id || channel.channel_name || String(cid);
    const body = content ? String(content) : '(no text)';

    await sendEmail({
      to,
      subject: `New support message from ${who} (${ticket})`,
      text: `${who} sent a new message in support conversation ${ticket}:\n\n${body}\n\nOpen the customer-support panel to reply.`,
      html: `<p><strong>${escapeHtml(who)}</strong> sent a new message in support conversation <strong>${escapeHtml(String(ticket))}</strong>:</p>`
        + `<blockquote style="border-left:3px solid #2563eb;padding-left:12px;color:#334155">${escapeHtml(body)}</blockquote>`
        + `<p>Open the customer-support panel to reply.</p>`,
    });
    return true;
  } catch (err) {
    console.error('[support-email] failed to notify tech support:', err?.message ?? err);
    return false;
  }
}
