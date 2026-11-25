// Client for our own self-hosted Chatterbox TTS service (open-source model,
// deployed on Modal serverless GPU). This is NOT a third-party paid API —
// CHATTERBOX_MODAL_BASE_URL points at our own FastAPI service. The Modal
// service currently has no authentication of its own, so it must only ever
// be called from this backend (never exposed to the browser) and every call
// here sits behind our own authenticateToken middleware.

const REQUEST_TIMEOUT_MS = 20 * 1000;
// The GPU container scales from zero — the first request after idle can take
// 1-3 minutes to cold-start. Generation calls get a much longer timeout.
const GENERATE_TIMEOUT_MS = 4 * 60 * 1000;

function baseUrl() {
  const url = process.env.CHATTERBOX_MODAL_BASE_URL?.trim();
  if (!url) throw new Error('CHATTERBOX_MODAL_BASE_URL is not set');
  return url.replace(/\/+$/, '');
}

// Shared secret so the Modal service can reject calls that don't come from
// us — the service has no auth of its own, so this header is the only thing
// stopping anyone with the URL from calling it directly. Sent whenever set;
// omitted (not a hard failure) if the Modal side hasn't been updated to
// check it yet, so this stays backward compatible during rollout.
function authHeaders() {
  const key = process.env.CHATTERBOX_INTERNAL_KEY?.trim();
  return key ? { 'X-Internal-Key': key } : {};
}

export function isChatterboxEnabled() {
  return Boolean(process.env.CHATTERBOX_MODAL_BASE_URL?.trim());
}

export async function checkHealth() {
  const res = await fetch(`${baseUrl()}/health`, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Voice engine health check failed (${res.status})`);
  return res.json();
}

export async function listVoices() {
  const res = await fetch(`${baseUrl()}/v1/voices`, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to list voices (${res.status})`);
  return res.json();
}

/**
 * Save a new voice preset from a short reference clip.
 * Returns { id, name, reference_path, created_at } — `id` is the Modal-side
 * voice id, the only thing needed to generate speech with this voice later.
 */
export async function createVoice({ name, buffer, fileName, mimeType }) {
  const form = new FormData();
  form.append('name', name);
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/wav' }), fileName || 'reference.wav');

  const res = await fetch(`${baseUrl()}/v1/voices`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to save voice (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function postAudio(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });

  if (res.status === 404) {
    const err = new Error('Voice not found');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Voice generation failed (${res.status}): ${errBody.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'audio/wav';
  return { buffer, contentType };
}

/** Generate speech for a saved voice preset. Returns { buffer, contentType }. */
export function generateSpeech(voiceId, { text, exaggeration = 0.5, languageId = null, variant = 'original' }) {
  return postAudio(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    text,
    exaggeration,
    language_id: languageId,
    variant,
  });
}

/** Generate speech for longer text, keeping voice consistency across it. */
export function generateLongForm(voiceId, { text, variant = 'original' }) {
  return postAudio(`/v1/long-form/${encodeURIComponent(voiceId)}`, { text, variant });
}
