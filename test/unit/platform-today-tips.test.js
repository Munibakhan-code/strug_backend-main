import { describe, it, expect } from 'vitest';
import { buildPlatformTips } from '../../utils/platform-today-tips.js';

describe('buildPlatformTips', () => {
  it('includes live counts in tip copy when stats are non-zero', () => {
    const tips = buildPlatformTips({
      active_sellers: 1240,
      orders_today: 12,
      live_streams: 3,
      videos_watched_today: 18000,
    });
    expect(tips).toHaveLength(5);
    expect(tips[0].text).toMatch(/1\.2k sellers/i);
    expect(tips[1].text).toMatch(/12 paid orders/i);
    expect(tips[2].text).toMatch(/3 creators are live/i);
    expect(tips[3].text).toMatch(/18k videos/i);
  });

  it('uses hedged copy when counts are zero', () => {
    const tips = buildPlatformTips({
      active_sellers: 0,
      orders_today: 0,
      live_streams: 0,
      videos_watched_today: 0,
    });
    expect(tips[0].text).toMatch(/real sellers/i);
    expect(tips[2].text).toMatch(/When creators go live/i);
  });

  it('treats missing stats as zero without throwing', () => {
    const tips = buildPlatformTips(undefined);
    expect(Array.isArray(tips)).toBe(true);
    expect(tips.length).toBeGreaterThanOrEqual(4);
  });

  it('uses singular nouns when sellers or orders is exactly 1', () => {
    const tips = buildPlatformTips({
      active_sellers: 1,
      orders_today: 1,
      live_streams: 1,
      videos_watched_today: 1,
    });
    expect(tips[0].text).toBe('1 seller has listings on Strug right now.');
    expect(tips[1].text).toBe('1 paid order was placed on Strug today.');
    expect(tips[2].text).toMatch(/1 creator is live/i);
    expect(tips[3].text).toMatch(/1 video on Strug today/i);
  });
});
