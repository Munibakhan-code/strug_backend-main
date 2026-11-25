import { describe, it, expect } from 'vitest';
import { whipPublishUrl, resolveWhipResourceUrl } from '../../services/live-playback.js';

describe('whipPublishUrl', () => {
  it('builds the MediaMTX WHIP path from the stream key', () => {
    expect(whipPublishUrl('strug_abc', 'http://127.0.0.1:8889')).toBe(
      'http://127.0.0.1:8889/strug_abc/whip',
    );
  });

  it('encodes the stream key', () => {
    expect(whipPublishUrl('a/b', 'http://127.0.0.1:8889')).toBe(
      'http://127.0.0.1:8889/a%2Fb/whip',
    );
  });

  it('returns null without a key or base', () => {
    expect(whipPublishUrl('', 'http://127.0.0.1:8889')).toBe(null);
    expect(whipPublishUrl('k', '')).toBe(null);
  });
});

describe('resolveWhipResourceUrl', () => {
  it('keeps absolute Location headers', () => {
    expect(resolveWhipResourceUrl('http://127.0.0.1:8889/strug_k/whip/id', 'http://127.0.0.1:8889'))
      .toBe('http://127.0.0.1:8889/strug_k/whip/id');
  });

  it('joins a relative Location against the internal base', () => {
    expect(resolveWhipResourceUrl('/strug_k/whip/id', 'http://127.0.0.1:8889'))
      .toBe('http://127.0.0.1:8889/strug_k/whip/id');
  });

  it('returns null for empty location', () => {
    expect(resolveWhipResourceUrl(null)).toBe(null);
    expect(resolveWhipResourceUrl('  ')).toBe(null);
  });
});
