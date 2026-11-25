// Stateless, signed price quotes ("lock the price, disclose the change").
//
// A fare-estimate endpoint hands the client a quote_id alongside the amount it just
// computed. At booking/confirm time the client sends that quote_id back; the server
// verifies it (signature + expiry + that the inputs haven't changed) and treats its
// amount as authoritative instead of silently re-pricing and charging whatever the
// route/catalog happens to compute a few seconds later. No table, no cleanup cron —
// the token itself carries everything needed to validate it.
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const QUOTE_TTL_SEC = 5 * 60; // long enough to review a fare, short enough that stale routes/prices can't be replayed
const SIGNING_KEY = process.env.QUOTE_SIGNING_KEY || process.env.ACCESS_TOKEN_KEY;

/** Stable hash of the inputs a quote was computed from, so a quote can't be replayed against different inputs. */
export function hashQuoteInputs(inputs) {
  const stable = JSON.stringify(inputs, Object.keys(inputs).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
}

/**
 * @param {number} amount - the authoritative price this quote locks in
 * @param {object} inputs - the exact inputs (pickup/dropoff/vehicle/etc.) the amount was computed from
 * @returns {{ quote_id: string, amount: number, expires_at: string }}
 */
export function signQuote(amount, inputs) {
  const inputs_hash = hashQuoteInputs(inputs);
  const expires_at = new Date(Date.now() + QUOTE_TTL_SEC * 1000);
  const quote_id = jwt.sign({ amount, inputs_hash }, SIGNING_KEY, { expiresIn: QUOTE_TTL_SEC });
  return { quote_id, amount, expires_at: expires_at.toISOString() };
}

/**
 * Verify a quote_id against the inputs the caller is about to book with, and return the
 * locked amount if it still matches. Returns { ok: false, status, error, expired } on any
 * failure so callers can distinguish "please refresh your quote" from a hard error.
 */
export function verifyQuote(quote_id, inputs) {
  if (!quote_id || typeof quote_id !== 'string') {
    return { ok: false, status: 400, error: 'A price quote is required — refresh the fare and try again.' };
  }
  let decoded;
  try {
    decoded = jwt.verify(quote_id, SIGNING_KEY);
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return {
      ok: false,
      status: 409,
      expired: true,
      error: expired ? 'This price quote has expired.' : 'This price quote is invalid.',
    };
  }
  const inputs_hash = hashQuoteInputs(inputs);
  if (inputs_hash !== decoded.inputs_hash) {
    return { ok: false, status: 409, expired: true, error: 'The trip details changed since this price was quoted.' };
  }
  return { ok: true, amount: Number(decoded.amount) };
}
