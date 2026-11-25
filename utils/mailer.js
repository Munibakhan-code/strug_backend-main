import handlebars from 'handlebars';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import i18next from './i18n.js';
import { sendEmail as sendViaMail, isMailConfigured } from '../services/email-service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');
const LOGO_CID = 'struglogo';
const LOGO_URL =
  process.env.STRUG_EMAIL_LOGO_URL?.trim() || 'https://strug.ca/favicon.ico';

let logoAttachmentCache = null;

/** Inline logo for mail providers (contentId must match layout.hbs cid:struglogo). */
async function getLogoAttachment() {
  if (logoAttachmentCache) return logoAttachmentCache;

  if (await fs.pathExists(LOGO_PATH)) {
    const buf = await fs.readFile(LOGO_PATH);
    logoAttachmentCache = {
      filename: 'logo.png',
      content: buf.toString('base64'),
      contentType: 'image/png',
      contentId: LOGO_CID,
    };
    return logoAttachmentCache;
  }

  if (LOGO_URL) {
    logoAttachmentCache = {
      filename: 'logo.png',
      path: LOGO_URL,
      contentType: 'image/png',
      contentId: LOGO_CID,
    };
    return logoAttachmentCache;
  }

  return null;
}

function getLogoImgHtml() {
  return `<img src="cid:${LOGO_CID}" alt="Strug" height="30" border="0" style="display:block;height:30px;width:auto;max-width:120px;" />`;
}

export async function renderEmailHtml(templateName, variables, lng = 'en') {
  await i18next.changeLanguage(lng);
  const t = i18next.getFixedT(lng);
  handlebars.registerHelper('t', function (key, options) {
    const extra = options?.hash ? { ...options.hash } : {};
    return t(key, { ...variables, ...extra });
  });

  const templatePath = path.join(__dirname, '..', 'templates', 'emails', `${templateName}.hbs`);
  const layoutPath = path.join(__dirname, '..', 'templates', 'emails', 'layout.hbs');

  if (!(await fs.pathExists(templatePath))) {
    throw new Error(`Template not found: ${templateName}`);
  }
  if (!(await fs.pathExists(layoutPath))) {
    throw new Error('Master layout not found.');
  }

  const templateSource = await fs.readFile(templatePath, 'utf8');
  const layoutSource = await fs.readFile(layoutPath, 'utf8');

  const mainTemplate = handlebars.compile(templateSource);
  const layoutTemplate = handlebars.compile(layoutSource);

  const bodyHtml = mainTemplate({
    frontend_url: (process.env.FRONTEND_URL || 'https://strug.ca').replace(/\/$/, ''),
    ...variables,
  });
  return layoutTemplate({
    ...variables,
    frontend_url: (process.env.FRONTEND_URL || 'https://strug.ca').replace(/\/$/, ''),
    body: bodyHtml,
    logo_img: getLogoImgHtml(),
  });
}

/**
 * Send a branded Handlebars email via the mail facade (all app email flows use this).
 * @param {string} templateName
 * @param {object} variables
 * @param {string} to
 * @param {string} subjectKey — i18n key under emails.*
 * @param {string} [lng='en']
 */
export const sendEmail = async (templateName, variables, to, subjectKey, lng = 'en') => {
  if (!isMailConfigured()) {
    throw new Error(
      'Mail is not configured. Set MAIL_PROVIDER and provider credentials (see docs/mail-gap-matrix.md)',
    );
  }

  try {
    await i18next.changeLanguage(lng);
    const t = i18next.getFixedT(lng);
    const finalHtml = await renderEmailHtml(templateName, variables, lng);
    const subject = t(subjectKey, { ...variables });
    // Plain-text must include the OTP (and readable copy). Subject-only made
    // text clients look empty / broken ("technical" junk with no usable code).
    let textBody = subject;
    if (templateName === 'otp' && variables?.otp_code) {
      textBody = [
        subject,
        '',
        t('emails.otp.instruction', { ...variables }),
        '',
        String(variables.otp_code),
        '',
        t('emails.otp.ignore', { ...variables }),
      ].join('\n');
    } else if (templateName === 'event-invite' && variables?.rsvp_url) {
      textBody = [
        subject,
        '',
        t('emails.event_invite.instruction', {
          name: variables.guest_name || variables.name || 'there',
          event_title: variables.event_title,
        }),
        variables.event_when || '',
        variables.event_city || '',
        '',
        String(variables.rsvp_url),
        '',
        t('emails.event_invite.thanks'),
      ].join('\n');
    } else if (templateName === 'board-invite' && variables?.board_url) {
      textBody = [
        subject,
        '',
        t('emails.board_invite.instruction', { name: variables.name || 'there' }),
        '',
        `${t('emails.board_invite.email_label')}: ${variables.email || ''}`,
        `${t('emails.board_invite.temp_password')}: ${variables.temp_password || ''}`,
        '',
        String(variables.board_url),
        '',
        t('emails.board_invite.change_password'),
      ].join('\n');
    } else if (variables?.cta_url) {
      textBody = [subject, '', String(variables.cta_url)].join('\n');
    }
    const logo = await getLogoAttachment();
    const attachments = logo ? [logo] : [];

    await sendViaMail({
      to,
      subject,
      html: finalHtml,
      text: textBody,
      attachments,
      tags: [{ name: 'template', value: String(templateName) }],
    });

    console.log(`📧 [SUCCESS] Email [${lng.toUpperCase()}]: ${templateName} → ${to}`);
  } catch (error) {
    console.error('❌ [MAILER ERROR]:', error.message);
    throw error;
  }
};
