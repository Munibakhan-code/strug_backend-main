/**
 * Stamp channel origin onto each chat message metadata (Jobs Phase 4).
 * Does not overwrite an explicit client origin / source_vertical.
 */

const SKIP_TYPES = new Set(['', 'dm', 'null', 'undefined']);

export function normalizeMessageOriginKey(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key || SKIP_TYPES.has(key)) return '';
  return key.slice(0, 64);
}

/**
 * @param {object|null|undefined} metadata
 * @param {{ context_type?: unknown, context_id?: unknown }|null|undefined} channel
 */
export function mergeMessageOriginMetadata(metadata, channel) {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...metadata }
      : {};

  const existing = normalizeMessageOriginKey(
    base.origin ?? base.source_vertical ?? base.context_type,
  );
  if (existing) {
    if (!base.origin) base.origin = existing;
    return base;
  }

  const fromChannel = normalizeMessageOriginKey(channel?.context_type);
  if (!fromChannel) return Object.keys(base).length ? base : metadata ?? null;

  base.origin = fromChannel;
  if (channel?.context_id != null && channel.context_id !== '') {
    const idNum = Number(channel.context_id);
    base.origin_context_id = Number.isFinite(idNum) ? idNum : String(channel.context_id).slice(0, 64);
  }
  return base;
}
