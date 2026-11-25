import { describe, it, expect } from 'vitest';
import { townHallQueueContainer } from '../../workers/video-reconciliation.js';

const ENV = {
  AZURE_TOWNHALL_POSTS_CONTAINER: 'townhall-posts',
  AZURE_SOCIAL_POSTS_CONTAINER: 'social-posts',
};

describe('townHallQueueContainer', () => {
  it('matches create-path default when the URL has no container segment', () => {
    expect(townHallQueueContainer(
      'https://st.blob.core.windows.net/unknown-bucket/raw/a.mp4',
      ENV,
    )).toBe('townhall-posts');
  });

  it('reads townhall-posts from a blob URL even if social env is set', () => {
    expect(townHallQueueContainer(
      'https://st.blob.core.windows.net/townhall-posts/raw/a.mp4',
      ENV,
    )).toBe('townhall-posts');
  });

  it('uses social-posts when the stored URL is in that container (legacy uploads)', () => {
    expect(townHallQueueContainer(
      'https://st.blob.core.windows.net/social-posts/raw/a.mp4',
      ENV,
    )).toBe('social-posts');
  });

  it('does not default to AZURE_SOCIAL_POSTS_CONTAINER for empty or missing urls', () => {
    expect(townHallQueueContainer('', ENV)).toBe('townhall-posts');
    expect(townHallQueueContainer(null, ENV)).toBe('townhall-posts');
    expect(townHallQueueContainer(undefined, ENV)).toBe('townhall-posts');
  });

  it('does not treat a random host path as a container just because the query mentions social-posts', () => {
    expect(townHallQueueContainer(
      'https://evil.example/x?next=/social-posts/steal',
      ENV,
    )).toBe('townhall-posts');
  });

  it('parses Azurite paths that prefix the account name', () => {
    expect(townHallQueueContainer(
      'http://127.0.0.1:10000/devstoreaccount1/townhall-posts/clip.mp4',
      ENV,
    )).toBe('townhall-posts');
  });

  it('honors a custom town hall env name when the URL has no known segment', () => {
    expect(townHallQueueContainer('https://st.blob.core.windows.net/other/a.mp4', {
      AZURE_TOWNHALL_POSTS_CONTAINER: 'th-prod',
      AZURE_SOCIAL_POSTS_CONTAINER: 'social-posts',
    })).toBe('th-prod');
  });
});
