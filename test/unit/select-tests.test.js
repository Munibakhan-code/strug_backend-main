import { describe, expect, it } from 'vitest';
import {
  enrichSelection,
  isIntegrationTest,
  matchesGlob,
  selectFromChangedFiles,
} from '../../scripts/select-tests.js';

const manifest = {
  fullSuiteTriggers: [
    'package-lock.json',
    'prisma/schema.prisma',
    '.github/workflows/test.yml',
    'scripts/guard-*.js',
  ],
  verticals: {
    core: {
      always: true,
      watch: ['middleware/**'],
      tests: ['test/unit/authentication.test.js'],
    },
    food: {
      watch: ['routes/food-routes.js', 'routes/delivery-driver-routes.js'],
      tests: ['test/unit/food-order-create.test.js', 'test/integration/food-analytics.test.js'],
    },
    recruiter: {
      watch: ['routes/referral-*.js', 'utils/recruiter-*.js'],
      tests: ['test/unit/recruiter-share.test.js'],
    },
    platform: {
      watch: ['utils/**', 'middleware/authentication.js'],
      tests: ['test/unit/ssrf-guard.test.js', 'test/integration/security-authz.test.js'],
    },
  },
};

describe('select-tests', () => {
  it('matches ** and * globs', () => {
    expect(matchesGlob('middleware/auth.js', 'middleware/**')).toBe(true);
    expect(matchesGlob('.github/workflows/test.yml', '.github/workflows/test.yml')).toBe(true);
    expect(matchesGlob('scripts/guard-malware.js', 'scripts/guard-*.js')).toBe(true);
    expect(matchesGlob('routes/food-routes.js', 'routes/food-routes.js')).toBe(true);
  });

  it('food route change runs food + core smoke only', () => {
    const r = selectFromChangedFiles(['routes/food-routes.js'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core', 'food']);
    expect(r.tests).toHaveLength(3);
    expect(r.tests).not.toContain('test/unit/ssrf-guard.test.js');
    expect(r.needsIntegration).toBe(true);
    expect(r.unitTests).toEqual([
      'test/unit/authentication.test.js',
      'test/unit/food-order-create.test.js',
    ]);
    expect(r.integrationTests).toEqual(['test/integration/food-analytics.test.js']);
  });

  it('recruiter util change prefers recruiter over platform utils/**', () => {
    const r = selectFromChangedFiles(['utils/recruiter-share.js'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core', 'recruiter']);
    expect(r.needsIntegration).toBe(false);
  });

  it('unmapped code routes to platform instead of full suite', () => {
    const r = selectFromChangedFiles(['routes/mystery-routes.js'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toContain('platform');
    expect(r.verticals).toContain('core');
  });

  it('lockfile change forces the full suite', () => {
    const r = selectFromChangedFiles(['package-lock.json'], manifest);
    expect(r.runFull).toBe(true);
    expect(r.needsIntegration).toBe(true);
  });

  it('docs-only diffs keep core smoke without integration', () => {
    const r = selectFromChangedFiles(['README.md', 'docs/plan.md'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core']);
    expect(r.needsIntegration).toBe(false);
  });

  it('empty changed list still runs always-on core smoke', () => {
    const r = selectFromChangedFiles([], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core']);
    expect(r.tests).toEqual(['test/unit/authentication.test.js']);
  });

  it('ignores webp and ico assets when unmatched', () => {
    const r = selectFromChangedFiles(['assets/logo.webp', 'favicon.ico'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core']);
    expect(r.needsIntegration).toBe(false);
  });

  it('auth middleware change still selects platform security-authz', () => {
    const r = selectFromChangedFiles(['middleware/authentication.js'], manifest);
    expect(r.runFull).toBe(false);
    expect(r.verticals).toEqual(['core', 'platform']);
    expect(r.integrationTests).toContain('test/integration/security-authz.test.js');
  });

  it('isIntegrationTest detects test/integration paths', () => {
    expect(isIntegrationTest('test/integration/security-authz.test.js')).toBe(true);
    expect(isIntegrationTest('test/unit/authentication.test.js')).toBe(false);
  });

  it('enrichSelection splits unit vs integration', () => {
    const r = enrichSelection({
      runFull: false,
      reason: 'x',
      verticals: ['core'],
      tests: ['test/unit/a.test.js', 'test/integration/b.test.js'],
    });
    expect(r.unitTests).toEqual(['test/unit/a.test.js']);
    expect(r.integrationTests).toEqual(['test/integration/b.test.js']);
    expect(r.needsIntegration).toBe(true);
  });
});
