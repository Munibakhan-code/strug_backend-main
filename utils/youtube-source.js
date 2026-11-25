/**
 * Normalize a creator-pasted YouTube URL into something yt-dlp can list
 * (channel /videos tab, playlist, or a single watch URL).
 */

const CHANNEL_ID = /^UC[\w-]{20,}$/;
const VIDEO_ID = /^[\w-]{11}$/;

export function normalizeYoutubeSourceUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    const err = new Error('Paste a YouTube channel, playlist, or video URL');
    err.status = 400;
    throw err;
  }
  if (CHANNEL_ID.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}/videos`;
  }
  if (VIDEO_ID.test(trimmed) && !trimmed.includes('.')) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }

  let url;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    const err = new Error('That does not look like a YouTube URL');
    err.status = 400;
    throw err;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    const err = new Error('Only YouTube channel, playlist, or video links are supported');
    err.status = 400;
    throw err;
  }

  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0];
    if (!VIDEO_ID.test(id)) {
      const err = new Error('Invalid YouTube video link');
      err.status = 400;
      throw err;
    }
    return `https://www.youtube.com/watch?v=${id}`;
  }

  const list = url.searchParams.get('list');
  if (list) return `https://www.youtube.com/playlist?list=${list}`;

  const video = url.searchParams.get('v');
  if (video && VIDEO_ID.test(video)) return `https://www.youtube.com/watch?v=${video}`;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'channel' && parts[1]) {
    return `https://www.youtube.com/channel/${parts[1]}/videos`;
  }
  if (parts[0] === 'c' && parts[1]) {
    return `https://www.youtube.com/c/${parts[1]}/videos`;
  }
  if (parts[0] === 'user' && parts[1]) {
    return `https://www.youtube.com/user/${parts[1]}/videos`;
  }
  if (parts[0]?.startsWith('@')) {
    return `https://www.youtube.com/${parts[0]}/videos`;
  }
  if (parts[0] === 'playlist' && list) {
    return `https://www.youtube.com/playlist?list=${list}`;
  }

  const err = new Error('Use a channel URL (youtube.com/@handle), playlist, or video link');
  err.status = 400;
  throw err;
}

export function youtubeWatchUrl(youtubeId) {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}
