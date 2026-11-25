import { describe, it, expect } from 'vitest';
import {
  parseSubscriptionUploadsQuery,
  isNewSubscriptionUpload,
  SUB_UPLOAD_DEFAULT_LIMIT,
  SUB_UPLOAD_MAX_LIMIT,
  SUB_UPLOAD_NEW_MS,
} from '../../utils/subscription-uploads.js';

describe('parseSubscriptionUploadsQuery', () => {
  it('defaults blank / NaN / non-positive limit and floors exclude', () => {
    expect(parseSubscriptionUploadsQuery({})).toEqual({ limit: SUB_UPLOAD_DEFAULT_LIMIT, excludeId: null });
    expect(parseSubscriptionUploadsQuery({ limit: '', exclude: '12.9' })).toEqual({ limit: SUB_UPLOAD_DEFAULT_LIMIT, excludeId: 12 });
    expect(parseSubscriptionUploadsQuery({ limit: '0', exclude: '-3' })).toEqual({ limit: SUB_UPLOAD_DEFAULT_LIMIT, excludeId: null });
  });

  it('honours a caller limit up to the ceiling', () => {
    expect(parseSubscriptionUploadsQuery({ limit: '5', exclude: '7' })).toEqual({ limit: 5, excludeId: 7 });
    expect(parseSubscriptionUploadsQuery({ limit: '99' })).toEqual({ limit: SUB_UPLOAD_MAX_LIMIT, excludeId: null });
  });
});

describe('isNewSubscriptionUpload', () => {
  it('marks recent uploads as new', () => {
    const now = Date.parse('2026-08-24T00:00:00Z');
    expect(isNewSubscriptionUpload(new Date(now - 60 * 60 * 1000), now)).toBe(true);
    expect(isNewSubscriptionUpload(new Date(now - SUB_UPLOAD_NEW_MS - 1), now)).toBe(false);
    expect(isNewSubscriptionUpload(null, now)).toBe(false);
  });
});
