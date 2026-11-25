import { describe, it, expect } from 'vitest';
import { buildTimeoutExcludeIds } from '../../utils/ride-dispatch.js';

describe('buildTimeoutExcludeIds', () => {
  it('includes timed-out driver with declined list', () => {
    expect(buildTimeoutExcludeIds([10, 20], 30)).toEqual([10, 20, 30]);
  });

  it('dedupes when timed-out driver already declined', () => {
    expect(buildTimeoutExcludeIds([10, 20], 20)).toEqual([10, 20]);
  });

  it('handles empty declined list', () => {
    expect(buildTimeoutExcludeIds([], 5)).toEqual([5]);
  });

  it('ignores invalid timed-out id', () => {
    expect(buildTimeoutExcludeIds([10], null)).toEqual([10]);
    expect(buildTimeoutExcludeIds([10], NaN)).toEqual([10]);
  });
});
