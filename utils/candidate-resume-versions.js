/**
 * Multi-resume version helpers.
 */

import { normalizeResumeJson, parseResumeJson } from './candidate-resume-json.js';

export const MAX_RESUME_VERSIONS = 8;
export const MAX_RESUME_LABEL = 80;

export function normalizeResumeLabel(raw, fallback = 'Resume') {
  const text = String(raw ?? '').trim().slice(0, MAX_RESUME_LABEL);
  return text || fallback;
}

export function serializeResumeVersion(row) {
  if (!row) return null;
  return {
    resume_version_id: row.resume_version_id,
    candidate_id: row.candidate_id,
    label: row.label,
    resume_json: row.resume_json ?? null,
    resume_url: row.resume_url ?? null,
    is_default: Boolean(row.is_default),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export function normalizeResumeVersionInput(body = {}) {
  const label = normalizeResumeLabel(body.label, 'Resume');
  const resume_json =
    body.resume_json === undefined
      ? undefined
      : body.resume_json == null
        ? null
        : normalizeResumeJson(parseResumeJson(body.resume_json));
  const resume_url =
    body.resume_url === undefined
      ? undefined
      : body.resume_url == null || !String(body.resume_url).trim()
        ? null
        : String(body.resume_url).trim().slice(0, 2048);
  const is_default = body.is_default === undefined ? undefined : Boolean(body.is_default);
  return { label, resume_json, resume_url, is_default };
}
