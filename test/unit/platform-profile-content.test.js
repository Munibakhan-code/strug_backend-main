import { describe, it, expect } from 'vitest';
import {
  buildProfileContentPayload,
  dayOfYearUTC,
  mapCatalogBook,
  mapCuratedBook,
  pickByDay,
  weatherCodeLabel,
  PROFILE_POLL,
  PROFILE_CURATED_BOOKS,
} from '../../utils/platform-profile-content.js';

describe('platform-profile-content helpers', () => {
  it('buildProfileContentPayload returns non-empty curated lists', () => {
    const data = buildProfileContentPayload(new Date('2026-09-05T12:00:00.000Z'));
    expect(data.whats_new.length).toBeGreaterThan(0);
    expect(data.platform_news.length).toBeGreaterThan(0);
    expect(data.quotes.length).toBeGreaterThan(0);
    expect(data.quote_of_day?.text).toBeTruthy();
    expect(data.feature_spotlight?.nav).toBeTruthy();
    expect(data.spin_items.length).toBe(6);
    expect(data.poll.id).toBe(PROFILE_POLL.id);
    expect(data.daily_goals.length).toBe(3);
  });

  it('pickByDay is stable for the same UTC day and wraps empty to null', () => {
    const day = new Date('2026-03-01T15:00:00.000Z');
    const a = pickByDay(['x', 'y', 'z'], day);
    const b = pickByDay(['x', 'y', 'z'], day);
    expect(a).toBe(b);
    expect(pickByDay([], day)).toBeNull();
    expect(pickByDay(null, day)).toBeNull();
  });

  it('dayOfYearUTC rejects nothing and is 1..366-ish', () => {
    const d = dayOfYearUTC(new Date('2026-01-01T00:00:00.000Z'));
    expect(d).toBe(1);
  });

  it('mapCatalogBook and mapCuratedBook mark savable books', () => {
    expect(mapCatalogBook({
      content_id: 42,
      content_title: 'Test',
      author: 'A',
      content_description: 'Desc',
    })).toEqual(expect.objectContaining({
      id: '42',
      source: 'catalog',
      savable: true,
      title: 'Test',
    }));
    expect(mapCatalogBook(null)).toBeNull();
    expect(mapCuratedBook(PROFILE_CURATED_BOOKS[0])).toEqual(expect.objectContaining({
      source: 'curated',
      savable: true,
      id: 'curated:atomic-habits',
    }));
  });

  it('weatherCodeLabel covers clear, rain, and unknown', () => {
    expect(weatherCodeLabel(0)).toBe('Clear');
    expect(weatherCodeLabel(61)).toBe('Rain');
    expect(weatherCodeLabel('nope')).toBe('Unknown');
  });
});
