import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';

/** Demo Mux stream — only used when LIVE_ALLOW_DEMO_FALLBACK=1 (local/dev). Never in prod paths by default. */
export const FALLBACK_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

export const LIVE_RTMP_URL = process.env.LIVE_RTMP_URL;
export const LIVE_HLS_BASE = process.env.LIVE_HLS_BASE;
/** Public base for viewer HLS (proxy or CDN). Defaults to API play proxy path. */
export const LIVE_PUBLIC_PLAYBACK_BASE = (process.env.LIVE_PUBLIC_PLAYBACK_BASE
  || process.env.LIVE_CDN_HLS_BASE
  || '').replace(/\/$/, '');
export const LIVE_HOOK_SECRET = process.env.LIVE_HOOK_SECRET;
/** Internal MediaMTX WebRTC HTTP base for WHIP ingest (browser / phone go-live). */
export const LIVE_WHIP_INTERNAL = (process.env.LIVE_WHIP_INTERNAL || 'http://127.0.0.1:8889').replace(/\/$/, '');
export const VOD_AUTH_ENFORCE = process.env.LIVE_VOD_AUTH_ENFORCE === 'true'
  || process.env.LIVE_VOD_AUTH_ENFORCE === '1';
/** Opt-in only: serve Mux demo when MediaMTX egress is missing (local UI smoke tests). */
export const LIVE_ALLOW_DEMO_FALLBACK = process.env.LIVE_ALLOW_DEMO_FALLBACK === 'true'
  || process.env.LIVE_ALLOW_DEMO_FALLBACK === '1';

export function mediaEgressEnabled() {
  return Boolean(LIVE_RTMP_URL && LIVE_HLS_BASE);
}

function demoFallbackOrNull() {
  return LIVE_ALLOW_DEMO_FALLBACK ? FALLBACK_HLS : null;
}

/** Internal MediaMTX HLS URL — for server-side probes only; never return to public clients. */
export function internalHlsUrlFor(streamKey) {
  if (!LIVE_HLS_BASE || !streamKey) return null;
  return `${LIVE_HLS_BASE.replace(/\/$/, '')}/${streamKey}/index.m3u8`;
}

export function mintStreamKey() {
  return `strug_${crypto.randomBytes(16).toString('hex')}`;
}

/** Public playback path id — not usable as RTMP publish credential. */
export function mintPlaybackId() {
  return `play_${crypto.randomBytes(16).toString('hex')}`;
}

/** MediaMTX WHIP publish URL for a stream key. Server-side only — never send to viewers. */
export function whipPublishUrl(streamKey, base = LIVE_WHIP_INTERNAL) {
  if (!base || !streamKey) return null;
  return `${String(base).replace(/\/$/, '')}/${encodeURIComponent(streamKey)}/whip`;
}

/** Resolve a WHIP Location header (absolute or path) against the internal MediaMTX base. */
export function resolveWhipResourceUrl(location, internalBase = LIVE_WHIP_INTERNAL) {
  if (!location || typeof location !== 'string') return null;
  const loc = location.trim();
  if (!loc) return null;
  if (/^https?:\/\//i.test(loc)) return loc;
  const base = String(internalBase || '').replace(/\/$/, '');
  if (!base) return loc.startsWith('/') ? loc : `/${loc}`;
  const path = loc.startsWith('/') ? loc : `/${loc}`;
  return `${base}${path}`;
}

/**
 * Public playback URL for viewers. Uses playback_id + public/CDN base so the
 * RTMP stream_key never appears in client-facing URLs.
 * Returns null when no public URL can be built (caller should treat as unavailable).
 */
export function publicPlaybackUrl(sessionOrPlaybackId, { apiOrigin } = {}) {
  const playbackId = typeof sessionOrPlaybackId === 'string'
    ? sessionOrPlaybackId
    : sessionOrPlaybackId?.playback_id;
  if (!playbackId) {
    return demoFallbackOrNull();
  }
  const base = LIVE_PUBLIC_PLAYBACK_BASE
    || (apiOrigin ? `${String(apiOrigin).replace(/\/$/, '')}/live-session/play` : null);
  if (base) {
    return `${base.replace(/\/$/, '')}/${playbackId}/index.m3u8`;
  }
  // Relative proxy path — Vite/FE can resolve against API origin.
  return `/live-session/play/${playbackId}/index.m3u8`;
}

/**
 * Client-facing playback URL. Never exposes internal MediaMTX paths keyed by stream_key.
 * Without playback_id, returns null (or demo URL only when LIVE_ALLOW_DEMO_FALLBACK=1).
 */
export function resolvePlaybackUrl(session, { apiOrigin } = {}) {
  if (!session) return demoFallbackOrNull();
  if (session.playback_id) return publicPlaybackUrl(session, { apiOrigin });
  return demoFallbackOrNull();
}

export function hookSecretValid(provided) {
  if (!LIVE_HOOK_SECRET || typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(LIVE_HOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sanitize a single HLS asset path segment (playlist or segment filename).
 * Rejects traversal and nested paths after Express has decoded the param.
 */
export function sanitizeHlsAssetParam(asset) {
  const rest = String(asset || 'index.m3u8').replace(/^\/+/, '');
  if (!rest) return null;
  if (rest.includes('..') || rest.includes('/') || rest.includes('\\') || rest.includes('\0')) {
    return null;
  }
  // Flat MediaMTX assets only: index.m3u8, segN.ts, init.mp4, etc.
  if (!/^[A-Za-z0-9._-]+$/.test(rest)) return null;
  return rest;
}

/** Resolve session for HLS proxy by public playback_id only (never stream_key). */
export async function findSessionByPlaybackPath(pathId) {
  const id = String(pathId || '').replace(/^\/+/, '').split('/')[0];
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) return null;
  return prisma.live_session.findFirst({
    where: { playback_id: id },
    select: {
      session_id: true,
      stream_key: true,
      playback_id: true,
      status: true,
      streamer_id: true,
    },
  });
}
