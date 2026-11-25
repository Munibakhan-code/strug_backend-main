/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeResumeLabel,
  normalizeResumeVersionInput,
  serializeResumeVersion,
} from '../../utils/candidate-resume-versions.js';

describe('normalizeResumeLabel', () => {
  it('trims and falls back', () => {
    expect(normalizeResumeLabel('  Tech  ')).toBe('Tech');
    expect(normalizeResumeLabel('')).toBe('Resume');
  });
});

describe('normalizeResumeVersionInput', () => {
  it('normalizes json and default flag', () => {
    const r = normalizeResumeVersionInput({
      label: 'Product',
      resume_json: { summary: 'Hi', experience: [], education: [] },
      is_default: 1,
    });
    expect(r.label).toBe('Product');
    expect(r.resume_json.summary).toBe('Hi');
    expect(r.is_default).toBe(true);
  });
});

describe('serializeResumeVersion', () => {
  it('returns null for missing', () => {
    expect(serializeResumeVersion(null)).toBeNull();
  });
});
