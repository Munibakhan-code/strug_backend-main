/** Sanitize client-supplied voice waveform peaks for chat message metadata. */
export function sanitizeWaveformPeaks(raw) {
  if (!Array.isArray(raw)) return null;
  const peaks = raw
    .slice(0, 64)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  return peaks.length ? peaks : null;
}

export function sanitizeMediaCaption(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 2000);
  return trimmed || null;
}
