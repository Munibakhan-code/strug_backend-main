const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function parsePageLimit(raw, fallback = DEFAULT_LIMIT, ceiling = MAX_LIMIT) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), ceiling);
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function pageResult(rows, limit, cursorFromRow) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    has_more: hasMore,
    next_cursor: hasMore && data.length ? encodeCursor(cursorFromRow(data[data.length - 1])) : null,
  };
}
