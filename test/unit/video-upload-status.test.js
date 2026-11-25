import { describe, it, expect } from 'vitest';
import { statusFromUploadVisibility, isOwnerOnlyVideoStatus } from '../../utils/video-upload-status.js';

describe('statusFromUploadVisibility', () => {
  it('maps public to pending so the worker can promote to safe', () => {
    expect(statusFromUploadVisibility('public')).toBe('pending');
    expect(statusFromUploadVisibility(undefined)).toBe('pending');
    expect(statusFromUploadVisibility('')).toBe('pending');
  });

  it('maps unlisted to pending_unlisted', () => {
    expect(statusFromUploadVisibility('unlisted')).toBe('pending_unlisted');
    expect(statusFromUploadVisibility('Unlisted')).toBe('pending_unlisted');
  });

  it('maps private to private immediately', () => {
    expect(statusFromUploadVisibility('private')).toBe('private');
    expect(statusFromUploadVisibility('PRIVATE')).toBe('private');
  });

  it('treats unknown values as public/pending', () => {
    expect(statusFromUploadVisibility('draft')).toBe('pending');
    expect(statusFromUploadVisibility('safe')).toBe('pending');
  });
});

describe('isOwnerOnlyVideoStatus', () => {
  it('is true for private and pending_private', () => {
    expect(isOwnerOnlyVideoStatus('private')).toBe(true);
    expect(isOwnerOnlyVideoStatus('pending_private')).toBe(true);
  });

  it('is false for public, unlisted, and processing sentinels', () => {
    expect(isOwnerOnlyVideoStatus('safe')).toBe(false);
    expect(isOwnerOnlyVideoStatus('pending')).toBe(false);
    expect(isOwnerOnlyVideoStatus('unlisted')).toBe(false);
    expect(isOwnerOnlyVideoStatus('pending_unlisted')).toBe(false);
    expect(isOwnerOnlyVideoStatus(undefined)).toBe(false);
  });
});
