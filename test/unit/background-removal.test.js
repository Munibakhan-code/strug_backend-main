import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBackgroundRemovalEnabled,
  getBackgroundRemovalProviderName,
  removeImageBackground,
} from '../../services/background-removal.js';

const ORIGINAL_ENV = { ...process.env };

function setEnv(provider, key) {
  if (provider === undefined) delete process.env.BG_REMOVAL_PROVIDER;
  else process.env.BG_REMOVAL_PROVIDER = provider;
  if (key === undefined) delete process.env.BG_REMOVAL_API_KEY;
  else process.env.BG_REMOVAL_API_KEY = key;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('background removal provider selection', () => {
  it('is disabled when no provider is configured', () => {
    setEnv(undefined, undefined);
    expect(isBackgroundRemovalEnabled()).toBe(false);
    expect(getBackgroundRemovalProviderName()).toBe(null);
  });

  it('is disabled for provider "none"', () => {
    setEnv('none', 'some-key');
    expect(isBackgroundRemovalEnabled()).toBe(false);
  });

  it('is disabled when the provider is set but the API key is missing', () => {
    setEnv('removebg', undefined);
    expect(isBackgroundRemovalEnabled()).toBe(false);
  });

  it('is disabled for an unknown provider', () => {
    setEnv('not-a-real-provider', 'key');
    expect(isBackgroundRemovalEnabled()).toBe(false);
  });

  it('resolves known providers case-insensitively', () => {
    setEnv('RemoveBG', 'key');
    expect(isBackgroundRemovalEnabled()).toBe(true);
    expect(getBackgroundRemovalProviderName()).toBe('Remove.bg');

    setEnv('clipdrop', 'key');
    expect(getBackgroundRemovalProviderName()).toBe('Clipdrop');
  });
});

describe('removeImageBackground', () => {
  beforeEach(() => setEnv('removebg', 'test-key'));

  it('throws when not configured (callers fall back to the original image)', async () => {
    setEnv(undefined, undefined);
    await expect(removeImageBackground(Buffer.from('x'))).rejects.toThrow(/not enabled/i);
  });

  it('throws for an unknown provider', async () => {
    setEnv('mystery', 'key');
    await expect(removeImageBackground(Buffer.from('x'))).rejects.toThrow(/unknown background removal provider/i);
  });

  it('throws when the API key is missing', async () => {
    setEnv('clipdrop', undefined);
    await expect(removeImageBackground(Buffer.from('x'))).rejects.toThrow(/BG_REMOVAL_API_KEY/);
  });

  it('returns a PNG buffer from a successful provider call', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      expect(String(url)).toContain('remove.bg');
      expect(opts.headers['X-Api-Key']).toBe('test-key');
      return {
        ok: true,
        arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
      };
    }));

    const out = await removeImageBackground(Buffer.from('fake-image'), 'image/jpeg');
    expect(out.contentType).toBe('image/png');
    expect(Buffer.compare(out.buffer, pngBytes)).toBe(0);
  });

  it('surfaces provider HTTP errors with status and body excerpt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      text: async () => 'insufficient credits',
    })));

    await expect(removeImageBackground(Buffer.from('img'))).rejects.toThrow(/402.*insufficient credits/s);
  });

  it('rejects an empty provider response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })));

    await expect(removeImageBackground(Buffer.from('img'))).rejects.toThrow(/empty body/i);
  });
});
