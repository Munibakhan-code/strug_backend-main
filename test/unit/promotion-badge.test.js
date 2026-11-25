import { describe, it, expect } from 'vitest';
import { formatOfferBadge, resolvePromotionAudienceSegment } from '../../utils/promotion.js';

describe('formatOfferBadge / resolvePromotionAudienceSegment', () => {
  it('formats clear VIP / first-order / upsell badges', () => {
    expect(formatOfferBadge({
      audience_segment: 'vip',
      discount_type: 'percent',
      discount_value: 20,
      code: 'VIP20ABCD',
    })).toBe('VIP — 20% OFF');

    expect(formatOfferBadge({
      audience_segment: 'prospects',
      discount_type: 'percent',
      discount_value: 15,
      code: 'FIRST15XX',
    })).toBe('First order — 15% OFF');

    expect(formatOfferBadge({
      audience_segment: 'recent',
      discount_type: 'percent',
      discount_value: 10,
      code: 'UPSELL10X',
    })).toBe('Welcome back — 10% OFF');
  });

  it('infers VIP from Opportunities-style code prefix (PREFIX + digit) and never returns raw codes', () => {
    expect(resolvePromotionAudienceSegment({ code: 'VIP129WN4', audience_segment: null })).toBe('vip');
    expect(formatOfferBadge({
      code: 'VIP129WN4',
      title: 'VIP129WN4',
      audience_segment: null,
      discount_type: 'percent',
      discount_value: 12,
    })).toBe('VIP — 12% OFF');
  });

  it('does not treat seasonal shop codes as Opportunities audiences', () => {
    // These used to match startsWith('WIN') / startsWith('BACK') and 400 at shop checkout.
    expect(resolvePromotionAudienceSegment({ code: 'WINTER25', audience_segment: null })).toBeNull();
    expect(resolvePromotionAudienceSegment({ code: 'BACKTOSCHOOL', audience_segment: null })).toBeNull();
    expect(formatOfferBadge({
      code: 'WINTER25',
      audience_segment: null,
      discount_type: 'percent',
      discount_value: 25,
    })).toBeNull();
  });

  it('still infers win-back / re-activation from Opportunities generators', () => {
    expect(resolvePromotionAudienceSegment({ code: 'WIN15ABCD', audience_segment: null })).toBe('atrisk');
    expect(resolvePromotionAudienceSegment({ code: 'BACK20WXYZ', audience_segment: null })).toBe('churned');
  });

  it('returns null when segment/discount cannot be resolved', () => {
    expect(formatOfferBadge({
      code: 'RANDOM99',
      title: 'RANDOM99',
      audience_segment: null,
      discount_type: 'percent',
      discount_value: 10,
    })).toBeNull();
  });
});
