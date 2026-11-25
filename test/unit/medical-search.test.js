import { describe, it, expect } from 'vitest';
import {
  expandMedicalSearchTerms,
  parseMedicalInsuranceFilter,
  medicalInsuranceWhere,
} from '../../utils/medical-search.js';

describe('expandMedicalSearchTerms (Phase 3 symptom → specialty)', () => {
  it('returns empty for blank query', () => {
    expect(expandMedicalSearchTerms('')).toEqual([]);
    expect(expandMedicalSearchTerms('   ')).toEqual([]);
  });

  it('keeps the original term and adds mapped specialties', () => {
    const knee = expandMedicalSearchTerms('knee pain');
    expect(knee[0]).toBe('knee pain');
    expect(knee).toContain('Orthopedics');

    const anxiety = expandMedicalSearchTerms('anxiety');
    expect(anxiety).toContain('Psychiatry');

    const rash = expandMedicalSearchTerms('RASH');
    expect(rash).toContain('Dermatology');
  });

	it('does not duplicate when the query is already a specialty name', () => {
    const terms = expandMedicalSearchTerms('Cardiology');
    expect(terms.filter((t) => t.toLowerCase() === 'cardiology')).toHaveLength(1);
  });

  it('does not reverse-match one- or two-character queries onto every alias', () => {
    expect(expandMedicalSearchTerms('a')).toEqual(['a']);
    expect(expandMedicalSearchTerms('ra')).toEqual(['ra']);
    expect(expandMedicalSearchTerms('ras')).toContain('Dermatology');
  });
});

describe('parseMedicalInsuranceFilter / medicalInsuranceWhere', () => {
  it('treats missing and all as no filter', () => {
    expect(parseMedicalInsuranceFilter({})).toBeNull();
    expect(parseMedicalInsuranceFilter({ insurance_plan: 'all' })).toBeNull();
    expect(parseMedicalInsuranceFilter({ insurance: '' })).toBeNull();
  });

  it('reads insurance_plan or insurance', () => {
    expect(parseMedicalInsuranceFilter({ insurance_plan: 'OHIP' })).toBe('OHIP');
    expect(parseMedicalInsuranceFilter({ insurance: 'aetna' })).toBe('aetna');
  });

  it('builds a Prisma OR on attributes.insurance / insurance_plans', () => {
    expect(medicalInsuranceWhere('')).toBeNull();
    const where = medicalInsuranceWhere('OHIP');
    expect(where.OR.length).toBeGreaterThanOrEqual(2);
    expect(where.OR[0].attributes.path).toEqual(['insurance']);
    expect(where.OR[0].attributes.string_contains).toBe('OHIP');
    expect(where.OR.some((c) => c.attributes.array_contains === 'ohip')).toBe(true);
  });

  it('matches hyphen and space variants of a plan id', () => {
    const where = medicalInsuranceWhere('blue-cross');
    const contains = where.OR.map((c) => c.attributes.string_contains || c.attributes.array_contains);
    expect(contains).toEqual(expect.arrayContaining(['blue-cross', 'blue cross']));
  });
});
