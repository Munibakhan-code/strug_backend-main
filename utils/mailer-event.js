import { EventEmitter } from 'events';
import { sendEmail } from './mailer.js';
import { emailLngFromUser, resolveEmailLng } from './email-lang.js';

const mailerEvents = new EventEmitter();

function resolvePayloadLng(data) {
  if (data.lng) return resolveEmailLng(data.lng);
  if (data.user) return emailLngFromUser(data.user, data.fallbackLng || 'en');
  if (data.language) return resolveEmailLng(data.language, data.fallbackLng || 'en');
  return resolveEmailLng(data.fallbackLng, 'en');
}

mailerEvents.on('send_email', async (data) => {
  try {
    const { templateName, variables, to, subjectKey } = data;
    const lng = resolvePayloadLng(data);
    await sendEmail(templateName, variables, to, subjectKey, lng);
    console.log(`📧 Background Email [${lng}] → ${to}`);
  } catch (error) {
    console.error('❌ Background Email Failed:', error.message);
  }
});

export default mailerEvents;
