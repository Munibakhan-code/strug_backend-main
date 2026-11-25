import mailerEvents from './mailer-event.js';
import { decrypt } from './crypto.js';
import { emailLngFromUser } from './email-lang.js';
import i18next from './i18n.js';

function userEmail(user) {
  if (!user?.email) return null;
  try {
    return decrypt(user.email);
  } catch {
    return user.email;
  }
}

function formatOrderDate(order) {
  const d = order?.date ? new Date(order.date) : new Date();
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function formatOrderTime(order) {
  const d = order?.date ? new Date(order.date) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function serviceName(order) {
  return order?.service_type?.type_name || order?.service_type?.name || 'Service';
}

const SCENARIOS = {
  placed: {
    subjectKey: 'emails.services.subjects.order_placed_customer',
    titleKey: 'emails.services.subjects.order_placed_customer',
    messageKey: 'emails.services.messages.order_placed',
  },
  accepted: {
    subjectKey: 'emails.services.subjects.order_accepted_customer',
    titleKey: 'emails.services.subjects.order_accepted_customer',
    messageKey: 'emails.services.messages.order_accepted',
  },
  cancelled: {
    subjectKey: 'emails.services.subjects.order_cancelled_customer',
    titleKey: 'emails.services.subjects.order_cancelled_customer',
    messageKey: 'emails.services.messages.order_cancelled',
  },
};

/** Branded service/rental order email via service-appointment template. */
export function queueServiceOrderEmail(order, scenario, extra = {}) {
  const cfg = SCENARIOS[scenario];
  if (!cfg || !order?.user) return;

  const to = userEmail(order.user);
  if (!to) return;

  const lng = emailLngFromUser(order.user);
  const t = i18next.getFixedT(lng);

  mailerEvents.emit('send_email', {
    templateName: 'service-appointment',
    variables: {
      service_name: serviceName(order),
      date: formatOrderDate(order),
      time: formatOrderTime(order),
      other_party_name: extra.other_party_name || 'Strug',
      isProvider: false,
      title: t(cfg.titleKey),
      message: t(cfg.messageKey),
    },
    to,
    subjectKey: cfg.subjectKey,
    user: order.user,
  });
}
