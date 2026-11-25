import { findExistingRideshareRefund, formatCancelFeePct } from './ride-refund.js';

/** System cancels when dispatch exhausts — never charge a cancel fee. */
export const SYSTEM_NO_DRIVER_REASONS = new Set([
  'no_driver_available',
  'no_driver_found',
  'all_drivers_declined',
]);

export function isSystemNoDriverReason(reason) {
  return SYSTEM_NO_DRIVER_REASONS.has(String(reason || ''));
}

export function buildRideCancellationBaseMessage(reason) {
  if (reason === 'all_drivers_declined') {
    return 'No drivers accepted your ride. Please try booking again.';
  }
  if (reason === 'no_driver_found' || reason === 'no_driver_available') {
    return 'No drivers were available. Your ride request has been cancelled.';
  }
  if (reason === 'cancelled_by_passenger') {
    return 'Your ride was cancelled.';
  }
  if (reason === 'no_show') {
    return 'Your ride was cancelled because you did not board within the wait time after your driver arrived.';
  }
  if (reason === 'replaced_by_new_booking') {
    return 'Your previous ride request was replaced by a new booking.';
  }
  return 'Your ride request was cancelled.';
}

/** User-facing copy for socket/API — mirrors cancelRideRequest messaging. */
export function buildRideCancellationMessage(reason, refund = null) {
  const baseMessage = buildRideCancellationBaseMessage(reason);
  if (!refund?.refunded) {
    if (isSystemNoDriverReason(reason)) {
      return `${baseMessage} Any payment collected has been refunded to your wallet or card.`;
    }
    return baseMessage;
  }
  const cancelFee = refund.cancel_fee > 0 ? refund.cancel_fee : null;
  if (cancelFee > 0) {
    return `${baseMessage} A ${formatCancelFeePct(cancelFee, refund.paid_amount)}% cancellation fee ($${Number(cancelFee).toFixed(2)}) was applied. $${Number(refund.amount).toFixed(2)} refunded to your wallet or card.`;
  }
  return `${baseMessage} $${Number(refund.amount).toFixed(2)} refunded to your wallet or card.`;
}

/**
 * Poll/GET summary for cancelled rides — reason, no-driver flag, refund copy.
 */
export async function buildRideCancellationSummary(rideRequest) {
  if (!rideRequest || (rideRequest.status || '').toLowerCase() !== 'cancelled') {
    return null;
  }

  const reason = rideRequest.cancellation_reason || 'cancelled';
  const passengerId = rideRequest.passenger_id;
  let refundAmount = null;
  let refunded = false;
  let cancelFee = null;
  let paidAmount = null;

  if (passengerId) {
    const existing = await findExistingRideshareRefund(Number(passengerId), rideRequest.ride_request_id);
    if (existing) {
      refunded = true;
      refundAmount = Math.abs(Number(existing.amount));
      cancelFee = existing.cancel_fee != null ? Number(existing.cancel_fee) : null;
      paidAmount = existing.paid_amount != null ? Number(existing.paid_amount) : null;
    }
  }

  const refundPayload = refunded
    ? { refunded: true, amount: refundAmount, cancel_fee: cancelFee, paid_amount: paidAmount }
    : null;

  return {
    reason,
    is_no_driver: isSystemNoDriverReason(reason),
    refund: refunded,
    refund_amount: refundAmount,
    cancel_fee: cancelFee,
    paid_amount: paidAmount,
    message: buildRideCancellationMessage(reason, refundPayload),
  };
}
