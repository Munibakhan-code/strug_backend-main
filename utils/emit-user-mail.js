/**
 * Best-effort branded mail to a user by id (decrypt email, emit mailerEvents).
 * Never throws into the request path — mail failures are logged only.
 */
import prisma from './prisma-client.js';
import { decrypt } from './crypto.js';
import mailerEvents from './mailer-event.js';

export function appPublicBase() {
  return String(process.env.FRONTEND_URL || process.env.APP_URL || 'https://app.strug.ca').replace(
    /\/$/,
    '',
  );
}

/**
 * @param {number|string} userId
 * @returns {Promise<{ email: string, user: object, name: string }|null>}
 */
export async function loadMailRecipient(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const user = await prisma.user.findUnique({
    where: { user_id: id },
    select: { user_id: true, email: true, language: true, name: true },
  });
  if (!user?.email) return null;
  let email;
  try {
    email = decrypt(user.email);
  } catch {
    email = user.email;
  }
  email = String(email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  return {
    email,
    user,
    name: String(user.name || '').trim() || 'there',
  };
}

/**
 * @param {{
 *   userId: number|string,
 *   templateName: string,
 *   subjectKey: string,
 *   variables?: Record<string, unknown>,
 * }} opts
 */
export async function emitUserMail({ userId, templateName, subjectKey, variables = {} }) {
  try {
    const recipient = await loadMailRecipient(userId);
    if (!recipient) return { ok: false, reason: 'no_email' };
    mailerEvents.emit('send_email', {
      templateName,
      subjectKey,
      to: recipient.email,
      user: recipient.user,
      variables: {
        name: recipient.name,
        ...variables,
      },
    });
    return { ok: true };
  } catch (err) {
    console.error(`[Mail] emitUserMail ${templateName} failed:`, err?.message || err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Resolve social_profile → user mail recipient.
 * @param {number|string} profileId
 */
export async function emitSocialProfileMail({
  profileId,
  templateName,
  subjectKey,
  variables = {},
}) {
  try {
    const id = Number(profileId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false, reason: 'bad_id' };
    const profile = await prisma.social_profile.findUnique({
      where: { profile_id: id },
      select: {
        profile_id: true,
        display_name: true,
        user_id: true,
        user: { select: { user_id: true, email: true, language: true, name: true } },
      },
    });
    if (!profile?.user_id) return { ok: false, reason: 'no_user' };
    return emitUserMail({
      userId: profile.user_id,
      templateName,
      subjectKey,
      variables: {
        profile_name: profile.display_name || profile.user?.name || 'there',
        ...variables,
      },
    });
  } catch (err) {
    console.error(`[Mail] emitSocialProfileMail ${templateName} failed:`, err?.message || err);
    return { ok: false, reason: 'error' };
  }
}
