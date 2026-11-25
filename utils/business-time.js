/**
 * Business-timezone day helpers.
 *
 * "Today" for OpenTable-style booked-today counts (and any local-day window)
 * must be computed in a stable business timezone — NOT raw UTC. A UTC-only day
 * boundary makes "Booked N times today" flip at the wrong wall-clock time for
 * every non-UTC region (e.g. it resets mid-afternoon in the Americas, and after
 * ~5am for South Asia). See reviewer note: "move booked_today / slot-day
 * filtering off UTC-only boundaries."
 *
 * Uses the built-in Intl API (IANA + DST aware, zero dependencies). Override the
 * zone with the RESERVATION_TIMEZONE env var; falls back to America/Toronto,
 * which matches the platform's primary reservation region.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_BUSINESS_TIMEZONE = 'America/Toronto';

/** Configured business timezone, validated at import; bad values fall back safely. */
export const BUSINESS_TIMEZONE = resolveConfiguredTimeZone();

function resolveConfiguredTimeZone() {
  const configured = (process.env.RESERVATION_TIMEZONE || '').trim();
  if (configured && isValidTimeZone(configured)) return configured;
  return DEFAULT_BUSINESS_TIMEZONE;
}

/** True when the string is an IANA zone the runtime's Intl accepts. */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset (ms) between the given zone's wall clock and UTC at `instant`.
 * Positive east of UTC, negative west. DST-aware for the specific instant.
 */
function tzOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - instant.getTime();
}

/**
 * UTC Date for the start of the local calendar day (midnight) in `timeZone`
 * that contains `instant`.
 */
export function startOfDayInTimeZone(instant = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_BUSINESS_TIMEZONE;
  const base = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  const d = Number(parts.find((p) => p.type === 'day').value);
  // Midnight wall-clock treated as UTC, then shifted by the zone's offset so the
  // result is the true UTC instant of local midnight.
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs(new Date(utcGuess), zone);
  return new Date(utcGuess - offset);
}

/**
 * YYYY-MM-DD calendar day for `instant` in `timeZone` (DST-aware).
 * Prefer this over `toISOString().slice(0, 10)`, which is always UTC and shifts
 * late local evenings onto the next calendar day.
 */
export function calendarDayKey(instant = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_BUSINESS_TIMEZONE;
  const base = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(base.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return y && m && d ? `${y}-${m}-${d}` : '';
}

/**
 * Step one local calendar day backward from the local midnight of `instant`.
 * Uses a 12h probe so DST spring-forward / fall-back days stay correct.
 */
export function previousStartOfDayInTimeZone(instant = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const start = startOfDayInTimeZone(instant, timeZone);
  return startOfDayInTimeZone(new Date(start.getTime() - 12 * 60 * 60 * 1000), timeZone);
}

/**
 * Step one local calendar day forward from the local midnight of `instant`.
 */
export function nextStartOfDayInTimeZone(instant = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const start = startOfDayInTimeZone(instant, timeZone);
  return startOfDayInTimeZone(new Date(start.getTime() + Math.round(1.5 * MS_PER_DAY)), timeZone);
}

/**
 * Half-open [start, end) UTC range covering the local calendar day in `timeZone`
 * that contains `instant`. End is computed from the *next* local midnight so it
 * stays correct across DST transitions (23h / 25h days).
 */
export function dayRangeInTimeZone(instant = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const start = startOfDayInTimeZone(instant, timeZone);
  // Land safely inside the next local day (36h clears any DST shift), then snap
  // back to that day's midnight.
  const nextDayProbe = new Date(start.getTime() + Math.round(1.5 * MS_PER_DAY));
  const end = startOfDayInTimeZone(nextDayProbe, timeZone);
  return { start, end };
}
