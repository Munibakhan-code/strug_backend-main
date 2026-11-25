import { describe, expect, it } from 'vitest';
import { normalizeYoutubeSourceUrl, youtubeWatchUrl } from '../../utils/youtube-source.js';

describe('normalizeYoutubeSourceUrl', () => {
  it('maps @handle URLs to the uploads tab', () => {
    expect(normalizeYoutubeSourceUrl('https://www.youtube.com/@SomeCreator')).toBe(
      'https://www.youtube.com/@SomeCreator/videos',
    );
  });

  it('maps channel ids and playlists', () => {
    expect(normalizeYoutubeSourceUrl('UCabcdefghijklmnopqrstuv')).toMatch(/\/channel\/UC/);
    expect(normalizeYoutubeSourceUrl('https://youtube.com/playlist?list=PLabc')).toBe(
      'https://www.youtube.com/playlist?list=PLabc',
    );
  });

  it('maps youtu.be watch links', () => {
    expect(normalizeYoutubeSourceUrl('https://youtu.be/abcdefghijk')).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk',
    );
  });

  it('rejects non-YouTube hosts', () => {
    expect(() => normalizeYoutubeSourceUrl('https://vimeo.com/123')).toThrow(/Only YouTube/);
  });
});

describe('youtubeWatchUrl', () => {
  it('builds a watch URL', () => {
    expect(youtubeWatchUrl('abcdefghijk')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });
});
