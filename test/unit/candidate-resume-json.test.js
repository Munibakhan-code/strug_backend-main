/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  emptyResumeJson,
  parseResumeJson,
  normalizeResumeJson,
  hasResumeJsonContent,
} from '../../utils/candidate-resume-json.js';

describe('parseResumeJson', () => {
  it('returns empty shape for null', () => {
    expect(parseResumeJson(null)).toEqual(emptyResumeJson());
  });

  it('parses valid JSON string', () => {
    const raw = JSON.stringify({
      summary: 'Builder',
      experience: [{ title: 'Dev', company: 'Strug' }],
      education: [{ school: 'UofT', degree: 'BSc' }],
    });
    const r = parseResumeJson(raw);
    expect(r.summary).toBe('Builder');
    expect(r.experience[0].title).toBe('Dev');
    expect(r.education[0].school).toBe('UofT');
  });

  it('rejects malformed JSON string', () => {
    expect(parseResumeJson('{bad json')).toEqual(emptyResumeJson());
  });

  it('drops experience rows without title or company', () => {
    const r = parseResumeJson({ experience: [{ title: '', company: '' }, { title: 'PM', company: 'Acme' }] });
    expect(r.experience).toHaveLength(1);
    expect(r.experience[0].title).toBe('PM');
  });
});

describe('normalizeResumeJson', () => {
  it('caps oversized summary', () => {
    const r = normalizeResumeJson({ summary: 'x'.repeat(5000) });
    expect(r.summary.length).toBe(4000);
  });

  it('marks current roles and trims fields', () => {
    const r = normalizeResumeJson({
      experience: [{ title: '  Lead  ', company: 'Co', current: true, end: '2020' }],
    });
    expect(r.experience[0].title).toBe('Lead');
    expect(r.experience[0].current).toBe(true);
  });
});

describe('hasResumeJsonContent', () => {
  it('is false for empty resume', () => {
    expect(hasResumeJsonContent(emptyResumeJson())).toBe(false);
  });

  it('is true when summary exists', () => {
    expect(hasResumeJsonContent({ summary: 'Hello' })).toBe(true);
  });

  it('is false for blank summary only', () => {
    expect(hasResumeJsonContent({ summary: '   ' })).toBe(false);
  });
});
