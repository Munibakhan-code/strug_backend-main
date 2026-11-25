/**
 * Branded mail for medical / venue booking events (booking-engine call sites).
 */
import { appPublicBase, emitUserMail } from './emit-user-mail.js';

const MAIL_VERTICALS = new Set(['medical', 'venue']);

function whenLabel(bookingOrPayload) {
  const date = bookingOrPayload?.start_date
    ? String(bookingOrPayload.start_date).slice(0, 10)
    : bookingOrPayload?.date
      ? String(bookingOrPayload.date).slice(0, 10)
      : '';
  const time = bookingOrPayload?.start_time || bookingOrPayload?.time || '';
  return [date, time].filter(Boolean).join(' ') || null;
}

/**
 * Guest: booking confirmed (accept or instant book).
 */
export function emitBookingConfirmedMail({ vertical, guestId, bookingId, listingTitle, booking }) {
  if (!MAIL_VERTICALS.has(vertical) || !guestId) return;
  const isMedical = vertical === 'medical';
  const base = appPublicBase();
  emitUserMail({
    userId: guestId,
    templateName: isMedical ? 'medical-booking-confirmed' : 'venue-booking-confirmed',
    subjectKey: isMedical
      ? 'emails.medical_booking_confirmed.subject'
      : 'emails.venue_booking_confirmed.subject',
    variables: {
      listing_title: listingTitle || null,
      when_label: whenLabel(booking || {}),
      booking_id: bookingId,
      cta_url: isMedical ? `${base}/medical` : `${base}/venues`,
    },
  }).catch(() => {});
}

/**
 * Host: new booking request (or instant confirmed notify).
 */
export function emitBookingRequestMail({
  vertical,
  hostId,
  guestName,
  bookingId,
  listingTitle,
}) {
  if (!MAIL_VERTICALS.has(vertical) || !hostId) return;
  const isMedical = vertical === 'medical';
  const base = appPublicBase();
  emitUserMail({
    userId: hostId,
    templateName: isMedical ? 'medical-booking-request' : 'venue-booking-request',
    subjectKey: isMedical
      ? 'emails.medical_booking_request.subject'
      : 'emails.venue_booking_request.subject',
    variables: {
      guest_name: guestName || 'A guest',
      listing_title: listingTitle || null,
      booking_id: bookingId,
      cta_url: isMedical ? `${base}/medical` : `${base}/venues`,
    },
  }).catch(() => {});
}
