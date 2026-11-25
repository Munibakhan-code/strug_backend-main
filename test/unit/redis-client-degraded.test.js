import { describe, it, expect, afterAll } from 'vitest';
import redis from '../../utils/redis-client.js';

// In CI / local-without-Redis the client never reaches 'ready', so every command must resolve a
// safe, correctly-shaped default instead of throwing "Connection is closed." — this is what keeps
// the ads engine + presence callers degrading quietly instead of spamming the logs every minute.
describe('redis-client — silent degradation when Redis is unavailable', () => {
    afterAll(() => { try { redis.disconnect(); } catch { /* noop */ } });

    it('reads (get) resolve to null, not a throw', async () => {
        await expect(redis.get('any:key')).resolves.toBeNull();
    });

    it('set / sadd / expire / del are no-ops that resolve (not reject)', async () => {
        await expect(redis.set('k', '1', 'PX', 1000, 'NX')).resolves.toBeNull();
        await expect(redis.sadd('s', 'x')).resolves.toBeNull();
        await expect(redis.expire('s', 60)).resolves.toBeNull();
        await expect(redis.del('k')).resolves.toBeNull();
    });

    it('list reads return an iterable array so for/of callers do not crash', async () => {
        const ids = await redis.smembers('ads:active:index');
        expect(Array.isArray(ids)).toBe(true);
        expect(ids).toEqual([]);
    });

    it('hash reads return an object so property access does not crash', async () => {
        const meta = await redis.hgetall('ads:campaign:1:meta');
        expect(meta).toEqual({});
    });

    it('event registration (.on) still works without throwing', () => {
        expect(() => redis.on('error', () => {})).not.toThrow();
    });
});
