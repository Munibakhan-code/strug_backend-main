/**
 * Medical Phase 3 — public listing search helpers.
 * Symptom aliases expand free-text `q` onto specialties; insurance is self-reported
 * on listing attributes (not a payer network).
 */

export const MEDICAL_SYMPTOM_ALIASES = [
  { specialty: 'Orthopedics', terms: ['knee pain', 'knee', 'joint', 'fracture', 'sports injury', 'back pain', 'hip'] },
  { specialty: 'Psychiatry', terms: ['anxiety', 'depression', 'mental', 'panic', 'therapy', 'adhd', 'insomnia'] },
  { specialty: 'Dermatology', terms: ['rash', 'acne', 'eczema', 'skin', 'mole', 'psoriasis'] },
  { specialty: 'Cardiology', terms: ['chest pain', 'heart', 'hypertension', 'blood pressure', 'palpitation'] },
  { specialty: 'Pediatrics', terms: ['child', 'kid', 'newborn', 'infant', 'pediatric', 'baby'] },
  { specialty: 'Physiotherapy', terms: ['physio', 'physiotherapy', 'rehab', 'rehabilitation'] },
  { specialty: 'Dentistry', terms: ['tooth', 'teeth', 'dental', 'dentist', 'cavity'] },
  { specialty: 'General Practice', terms: ['checkup', 'check-up', 'flu', 'cold', 'fever', 'primary care', 'gp'] },
];

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

/** Extra specialty names to OR into GET /booking/listings?q= for medical. */
export function expandMedicalSearchTerms(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const nq = norm(q);
  const extras = [];
  for (const row of MEDICAL_SYMPTOM_ALIASES) {
    // Reverse containment (t.includes(nq)) only for queries long enough to be
    // meaningful — q=a would otherwise match "anxiety", "rash", "knee pain", etc.
    if (row.terms.some((t) => nq.includes(t) || (nq.length >= 3 && t.includes(nq)))) {
      extras.push(row.specialty);
    }
  }
  return [q, ...extras.filter((s) => norm(s) !== nq)];
}

/** Self-reported plan id/label from query; null means no insurance filter. */
export function parseMedicalInsuranceFilter(query = {}) {
  const raw = query.insurance_plan ?? query.insurance ?? '';
  const id = norm(raw);
  if (!id || id === 'all') return null;
  return String(raw).trim();
}

export function insuranceMatchTokens(plan) {
  const token = String(plan || '').trim();
  if (!token) return [];
  const lower = norm(token);
  const spaced = lower.replace(/-/g, ' ');
  const dashed = lower.replace(/\s+/g, '-');
  return [...new Set([token, lower, spaced, dashed, token.replace(/-/g, ' ')])].filter(Boolean);
}

/**
 * Prisma-safe AND clause for self-reported insurance on attributes JSON.
 * Matches comma-separated `insurance` string or `insurance_plans` array of ids.
 * Hyphen and space variants so `blue-cross` still matches "Blue Cross".
 */
export function medicalInsuranceWhere(plan) {
  const tokens = insuranceMatchTokens(plan);
  if (!tokens.length) return null;
  const OR = [];
  for (const t of tokens) {
    OR.push({ attributes: { path: ['insurance'], string_contains: t, mode: 'insensitive' } });
    OR.push({ attributes: { path: ['insurance_plans'], array_contains: String(t).toLowerCase() } });
  }
  return { OR };
}
