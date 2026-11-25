import { describe, expect, it } from 'vitest';
import {
  normalizeTwitterSourceUrl,
  truncateTownHallContent,
  twitterStatusUrl,
} from '../../utils/twitter-source.js';

describe('normalizeTwitterSourceUrl', () => {
  it('maps bare handles and @handles to x.com profile URLs', () => {
    expect(normalizeTwitterSourceUrl('SomeCreator')).toBe('https://x.com/SomeCreator');
    expect(normalizeTwitterSourceUrl('@SomeCreator')).toBe('https://x.com/SomeCreator');
  });

  it('normalizes twitter.com and mobile hosts to x.com', () => {
    expect(normalizeTwitterSourceUrl('https://twitter.com/SomeCreator')).toBe('https://x.com/SomeCreator');
    expect(normalizeTwitterSourceUrl('https://mobile.twitter.com/SomeCreator/with_replies')).toBe(
      'https://x.com/SomeCreator',
    );
  });

  it('keeps status URLs', () => {
    expect(normalizeTwitterSourceUrl('https://x.com/SomeCreator/status/1234567890123456789')).toBe(
      'https://x.com/SomeCreator/status/1234567890123456789',
    );
  });

  it('rejects non-X hosts and empty input', () => {
    expect(() => normalizeTwitterSourceUrl('https://instagram.com/foo')).toThrow(/Only X/);
    expect(() => normalizeTwitterSourceUrl('')).toThrow(/Paste/);
  });
});

describe('truncateTownHallContent', () => {
  it('returns cleaned text under the limit', () => {
    expect(truncateTownHallContent('  hello   world  ')).toBe('hello world');
  });

  it('truncates with an ellipsis at max length', () => {
    const long = 'a'.repeat(300);
    const out = truncateTownHallContent(long, { max: 280 });
    expect(out.length).toBe(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it('uses fallback when text is empty', () => {
    expect(truncateTownHallContent('', { fallback: 'Imported from X' })).toBe('Imported from X');
  });
});

describe('twitterStatusUrl', () => {
  it('builds a status URL', () => {
    expect(twitterStatusUrl('@foo', '99')).toBe('https://x.com/foo/status/99');
  });
});
