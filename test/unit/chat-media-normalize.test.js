import { describe, it, expect, vi, beforeEach } from 'vitest';

const jpegOut = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

vi.mock('sharp', () => {
  const chain = {
    rotate: vi.fn(function rotate() { return this; }),
    jpeg: vi.fn(function jpeg() { return this; }),
    toBuffer: vi.fn(async () => jpegOut),
  };
  return { default: vi.fn(() => chain) };
});

describe('normalizeChatImageUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through non-HEIC buffers unchanged', async () => {
    const { normalizeChatImageUpload, isHeicMime } = await import('../../utils/chat-media-normalize.js');
    expect(isHeicMime('image/jpeg')).toBe(false);
    const buf = Buffer.from('abc');
    const out = await normalizeChatImageUpload(buf, 'image/jpeg');
    expect(out.converted).toBe(false);
    expect(out.buffer).toBe(buf);
    expect(out.mime).toBe('image/jpeg');
  });

  it('converts HEIC to JPEG', async () => {
    const { normalizeChatImageUpload, isHeicMime } = await import('../../utils/chat-media-normalize.js');
    expect(isHeicMime('image/heic')).toBe(true);
    const out = await normalizeChatImageUpload(Buffer.from('heic-bytes'), 'image/heic');
    expect(out.converted).toBe(true);
    expect(out.mime).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    expect(out.buffer.equals(jpegOut)).toBe(true);
  });

  it('treats HEIF the same as HEIC', async () => {
    const { normalizeChatImageUpload } = await import('../../utils/chat-media-normalize.js');
    const out = await normalizeChatImageUpload(Buffer.from('heif'), 'image/heif');
    expect(out.mime).toBe('image/jpeg');
    expect(out.converted).toBe(true);
  });
});
