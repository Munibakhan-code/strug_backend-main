// Sanitiser for auto-captured bug-report context.
//
// This is a trust boundary: the blob arrives from the browser, so a hostile or simply buggy
// client must not be able to land secrets, unbounded data, or unmodelled shapes in a row the
// board reads. These tests pin the ALLOW-LIST behaviour, not just the happy path.

import { describe, it, expect } from 'vitest';
import { sanitizeClientContext, stripUrlParams, redactSecrets } from '../../utils/bug-report-context.js';

describe('stripUrlParams', () => {
  it('drops the query string — this is how `?token=…` would otherwise be persisted', () => {
    // Our own Playwright auth pattern is ?token=…&user=… — a reporter filing from such a URL
    // would put a live access token into a board-readable column.
    expect(stripUrlParams('https://app.strug.ca/social?token=abc123&user=7')).toBe('https://app.strug.ca/social');
  });

  it('drops the fragment', () => {
    expect(stripUrlParams('https://app.strug.ca/videos#t=42')).toBe('https://app.strug.ca/videos');
  });

  it('keeps a clean url intact and maps empty to null', () => {
    expect(stripUrlParams('https://app.strug.ca/feed')).toBe('https://app.strug.ca/feed');
    expect(stripUrlParams('')).toBeNull();
    expect(stripUrlParams(null)).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('redacts JWTs, bearer tokens, stripe keys, emails and key=value secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo3fQ.s1gn4tur3v4lu3';
    expect(redactSecrets(`failed with ${jwt}`)).not.toContain('eyJhbGci');
    expect(redactSecrets('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redactSecrets('key sk_live_ABCDEF123456')).not.toContain('sk_live_ABCDEF123456');
    expect(redactSecrets('user bob@example.com failed')).not.toContain('bob@example.com');
    expect(redactSecrets('password=hunter2')).not.toContain('hunter2');
  });
});

describe('sanitizeClientContext', () => {
  it('returns all-nulls for missing / malformed input rather than throwing', () => {
    // A broken blob must never cost the user the report they just typed.
    for (const bad of [undefined, null, '', 'not json{', '[]', '42']) {
      const out = sanitizeClientContext(bad);
      expect(out.context).toBeNull();
      expect(out.build_sha).toBeNull();
    }
  });

  it('hoists valid scalars and rejects malformed ones', () => {
    const ok = sanitizeClientContext(JSON.stringify({
      build_sha: 'a1b2c3d4e5f6', viewport: '390x844', device_type: 'mobile', nav_id: 'social',
    }));
    expect(ok).toMatchObject({ build_sha: 'a1b2c3d4e5f6', viewport: '390x844', device_type: 'mobile', nav_id: 'social' });

    const bad = sanitizeClientContext(JSON.stringify({
      build_sha: 'not-a-sha!!', viewport: 'huge', device_type: 'toaster', nav_id: 'drop table;',
    }));
    expect(bad).toMatchObject({ build_sha: null, viewport: null, device_type: null, nav_id: null });
  });

  it('keeps only {level,message,at} on console entries, capped at 5 and redacted', () => {
    const raw = JSON.stringify({
      console: Array.from({ length: 9 }, (_, i) => ({
        level: 'error',
        message: `boom ${i} Bearer sekrettoken123`,
        at: '2026-07-15T10:00:00.000Z',
        stack: 'SHOULD NOT SURVIVE',
        cookie: 'SHOULD NOT SURVIVE',
      })),
    });
    const { context } = sanitizeClientContext(raw);
    expect(context.console).toHaveLength(5);
    for (const e of context.console) {
      expect(Object.keys(e).sort()).toEqual(['at', 'level', 'message']);
      expect(e.message).not.toContain('sekrettoken123');
    }
  });

  it('keeps only method/path/status/at on API failures — never bodies, headers or query params', () => {
    const raw = JSON.stringify({
      api: [{
        method: 'post',
        path: '/social/comments?token=liveaccesstoken',
        status: 500,
        at: '2026-07-15T10:00:00.000Z',
        requestBody: { password: 'hunter2' },
        headers: { Authorization: 'Bearer abc' },
        response: 'stack trace with PII',
      }],
    });
    const { context } = sanitizeClientContext(raw);
    expect(context.api).toHaveLength(1);
    const [call] = context.api;
    expect(Object.keys(call).sort()).toEqual(['at', 'method', 'path', 'status']);
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/social/comments'); // query stripped
    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('Bearer');
  });

  it('drops unmodelled top-level keys entirely (allow-list, not filter)', () => {
    const { context } = sanitizeClientContext(JSON.stringify({
      console: [{ level: 'error', message: 'x', at: '2026-07-15T10:00:00.000Z' }],
      localStorage: { strug_access_token: 'secret' },
      cookies: 'session=abc',
    }));
    expect(Object.keys(context).sort()).toEqual(['api', 'console', 'session']);
    expect(JSON.stringify(context)).not.toContain('secret');
  });

  it('keeps the session block that answers "which account / was it a fresh load"', () => {
    const { context } = sanitizeClientContext(JSON.stringify({
      session: { authenticated: true, user_id: 42, locale: 'en', timezone: 'America/Toronto', session_age_s: 90 },
    }));
    expect(context.session).toEqual({
      authenticated: true, user_id: 42, locale: 'en', timezone: 'America/Toronto', session_age_s: 90,
    });
  });

  it('returns a null context when there is nothing worth storing', () => {
    // So the board can honestly say "no context captured" rather than render 3 empty sections.
    const { context } = sanitizeClientContext(JSON.stringify({ console: [], api: [] }));
    expect(context).toBeNull();
  });

  it('caps total size against a hostile client', () => {
    const huge = 'x'.repeat(50_000);
    const { context } = sanitizeClientContext(JSON.stringify({
      console: Array.from({ length: 5 }, () => ({ level: 'error', message: huge, at: '2026-07-15T10:00:00.000Z' })),
    }));
    // Each message is truncated to 300 chars, so this stays far under the 8KB ceiling.
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThan(8 * 1024);
  });
});
