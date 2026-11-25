import i18next from './i18n.js';
import { decrypt } from './crypto.js';
import { sendEmail } from './mailer.js';
import { emailLngFromUser } from './email-lang.js';

/** Passenger notification events (trip complete uses ride-receipt.hbs). */
export const RIDE_STATUS_EMAIL_EVENT = {
  ASSIGNED: 'assigned',
  ARRIVED: 'arrived',
  REMINDER: 'reminder',
};

const EVENT_CONFIG = {
  [RIDE_STATUS_EMAIL_EVENT.ASSIGNED]: {
    subjectKey: 'emails.ride_status.subjects.assigned',
    titleKey: 'emails.ride_status.titles.assigned',
    messageKey: 'emails.ride_status.messages.assigned',
  },
  [RIDE_STATUS_EMAIL_EVENT.ARRIVED]: {
    subjectKey: 'emails.ride_status.subjects.arrived',
    titleKey: 'emails.ride_status.titles.arrived',
    messageKey: 'emails.ride_status.messages.arrived',
  },
  [RIDE_STATUS_EMAIL_EVENT.REMINDER]: {
    subjectKey: 'emails.ride_status.subjects.reminder',
    titleKey: 'emails.ride_status.titles.reminder',
    messageKey: 'emails.ride_status.messages.reminder',
  },
};

function rideTrackUrl() {
  const base = (process.env.FRONTEND_URL || 'https://strug.ca').replace(/\/$/, '');
  return `${base}/ride`;
}

export function buildRideStatusEmailVars(event, context = {}, lng = 'en') {
  const cfg = EVENT_CONFIG[event];
  if (!cfg) return null;

  const t = i18next.getFixedT(lng);
  const ride = context.ride ?? null;
  const trip = context.trip ?? null;
  const rideId = ride?.ride_request_id ?? trip?.request_id ?? null;

  return {
    status_title: t(cfg.titleKey),
    status_message: t(cfg.messageKey),
    ride_id: rideId,
    ride_id_label: rideId != null ? `#${rideId}` : '—',
    trip_id_label: trip?.trip_id != null ? `#${trip.trip_id}` : '—',
    pickup_address: ride?.pickup_address ?? '—',
    drop_address: ride?.drop_address ?? '—',
    driver_name: context.driverName ?? 'Your driver',
    vehicle_type: context.vehicleType ?? '—',
    plate_number: context.plate ?? '—',
    eta: context.eta ?? '',
    track_url: rideTrackUrl(),
  };
}

/**
 * Queue a branded ride-status email to the passenger. No-op when email is missing.
 * @param {'assigned'|'arrived'} event
 */
export async function sendPassengerRideStatusEmail(event, { passengerUser, ride, trip, driverName, vehicleType, plate, eta }) {
  const cfg = EVENT_CONFIG[event];
  if (!cfg || !passengerUser?.email) return;

  const lng = emailLngFromUser(passengerUser);
  const variables = buildRideStatusEmailVars(
    event,
    { ride, trip, driverName, vehicleType, plate, eta },
    lng,
  );
  if (!variables) return;

  const plainEmail = decrypt(passengerUser.email);
  await sendEmail('ride-status', variables, plainEmail, cfg.subjectKey, lng);
}

export async function loadPassengerUserForRide(prisma, passengerId) {
  if (!passengerId) return null;
  return prisma.user.findUnique({
    where: { user_id: passengerId },
    select: { user_id: true, email: true, language: true, name: true },
  });
}
