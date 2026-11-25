/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  isSafeHttpUrl,
  normalizePortfolioItemInput,
  normalizePortfolioMediaType,
  serializePortfolioItem,
} from '../../utils/candidate-portfolio.js';

describe('isSafeHttpUrl', () => {
  it('accepts https URLs', () => {
    expect(isSafeHttpUrl('https://cdn.example/x.png')).toBe(true);
  });

  it('rejects empty and javascript URLs', () => {
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('normalizePortfolioMediaType', () => {
  it('detects image from URL extension when type missing', () => {
    expect(normalizePortfolioMediaType('', 'https://x/a.JPG')).toBe('image');
  });

  it('keeps explicit type', () => {
    expect(normalizePortfolioMediaType('pdf', 'https://x/a.png')).toBe('pdf');
  });
});

describe('normalizePortfolioItemInput', () => {
  it('accepts a valid gallery item', () => {
    const r = normalizePortfolioItemInput({
      title: '  Case study  ',
      url: 'https://cdn.example/work.png',
      media_type: 'image',
    });
    expect(r.ok).toBe(true);
    expect(r.item.title).toBe('Case study');
    expect(r.item.media_type).toBe('image');
  });

  it('rejects bad URL', () => {
    const r = normalizePortfolioItemInput({ url: 'not-a-url' });
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range sort_order', () => {
    const r = normalizePortfolioItemInput({
      url: 'https://cdn.example/a.pdf',
      sort_order: -1,
    });
    expect(r.ok).toBe(false);
  });
});

describe('serializePortfolioItem', () => {
  it('returns null for missing row', () => {
    expect(serializePortfolioItem(null)).toBeNull();
  });

  it('maps fields', () => {
    expect(serializePortfolioItem({
      portfolio_item_id: 3,
      candidate_id: 1,
      title: 'A',
      url: 'https://x',
      media_type: null,
      sort_order: 2,
    })).toMatchObject({ portfolio_item_id: 3, media_type: 'link', sort_order: 2 });
  });
});
