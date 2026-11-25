import { describe, expect, it } from 'vitest';
import {
  EMPTY_CREATOR_AUDIENCE_INTELLIGENCE,
  shapeCreatorAudienceIntelligence,
} from '../../utils/creator-audience-intelligence.js';

describe('creator audience intelligence', () => {
  it('returns aggregate-only analytics without viewer identities', () => {
    const result = shapeCreatorAudienceIntelligence({
      impressions: 1000n,
      starts: 600,
      meaningful_watches: 420,
      completed: 180,
      engaged: 90,
      returning_viewers: 70,
      new_viewers: 30,
      subscribers: 44,
      non_subscribers: 56,
      retention: [100, 84, 63, 48, 39, 30],
    }, [{ label: 'Home', value: 700n }]);

    expect(result.funnel.map(item => item.value)).toEqual([1000, 600, 420, 180, 90]);
    expect(result.sources).toEqual([{ label: 'Home', value: 700 }]);
    expect(result.privacy).toEqual({ aggregated: true, identities_exposed: false, minimum_audience: 5, suppressed: false });
    expect(JSON.stringify(result)).not.toContain('user_id');
  });

  it('uses safe finite defaults for empty or invalid database values', () => {
    const result = shapeCreatorAudienceIntelligence({ impressions: 'invalid', retention: [null, '50'] });
    expect(result.funnel[0].value).toBe(0);
    expect(result.retention).toEqual([]);
    expect(EMPTY_CREATOR_AUDIENCE_INTELLIGENCE.privacy).toMatchObject({ identities_exposed: false, suppressed: true });
  });
});
