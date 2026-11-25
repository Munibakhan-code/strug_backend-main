/**
 * Format Prisma @db.Time / Date / time-string values for shift emails.
 * Bare "HH:MM:SS" strings are Invalid Date in V8 if passed to `new Date(...)`.
 */
export function formatShiftTimeForEmail(value) {
  if (value == null || value === '') return 'N/A';

  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/);
    if (m) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        const d = new Date(1970, 0, 1, hh, mm, Number(m[3] || 0));
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }
  }

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
