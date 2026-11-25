import { describe, it, expect } from 'vitest';
import { getAllowedModels, isModelAllowed } from '../../ai/vertical-model-map.js';

describe('vertical-model-map medical (Phase 3)', () => {
  it('allows booking listings, not Flo symptom_log', () => {
    expect(getAllowedModels('medical')).toEqual(['booking_listing', 'booking']);
    expect(isModelAllowed('medical', 'booking_listing')).toBe(true);
    expect(isModelAllowed('medical', 'symptom_log')).toBe(false);
    expect(isModelAllowed('medical', 'symptom_types')).toBe(false);
  });
});
