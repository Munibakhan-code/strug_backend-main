import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    push_subscription: { findMany: vi.fn(), delete: vi.fn() },
    social_profile: { findUnique: vi.fn() },
  },
}));

describe('web-push-service VAPID configuration', () => {
  const originalPublicKey = process.env.VAPID_PUBLIC_KEY;
  const originalPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.resetModules();
    if (originalPublicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = originalPublicKey;
    if (originalPrivateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = originalPrivateKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('uses bundled VAPID keys when env keys are absent', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    process.env.NODE_ENV = 'production';

    const service = await import('../../services/web-push-service.js');

    expect(service.isWebPushConfigured()).toBe(true);
    expect(service.getVapidPublicKey()).toMatch(/^B/);
  });

  it('prefers env VAPID keys over bundled keys', async () => {
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';
    process.env.NODE_ENV = 'production';

    const service = await import('../../services/web-push-service.js');

    expect(service.isWebPushConfigured()).toBe(false);
    expect(service.getVapidPublicKey()).toBe('env-public-key');
  });
});
