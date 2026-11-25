import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { globalErrorHandler } from '../../middleware/error-handler.js';

// Regression for the Zod v3 -> v4 upgrade.
//
// ZodError#errors was removed in Zod 4 in favour of #issues. The handler still read `.errors`
// and called `.map` on it, so `err.errors.map` threw a TypeError *inside the error handler*.
// Express treats a throwing error handler as unhandled and falls back to its own, which answers
// with an HTML 500 — so every validation failure routed through next(err) returned a 500 HTML
// page instead of this 400 JSON body, across all 43 route files that use Zod.

function runHandler(err) {
  const req = { originalUrl: '/api/thing', method: 'POST', correlationId: 'cid-42', user: null };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  globalErrorHandler(err, req, res, vi.fn());
  return res;
}

function zodErrorFor(schema, value) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return result.error;
}

describe('globalErrorHandler — Zod validation', () => {
  it('does not throw on a real Zod 4 error', () => {
    const err = zodErrorFor(z.object({ email: z.string() }), { email: 123 });
    expect(() => runHandler(err)).not.toThrow();
  });

  it('answers 400 with the documented envelope', () => {
    const err = zodErrorFor(z.object({ email: z.string() }), { email: 123 });
    const res = runHandler(err);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      successful: false,
      code: 'VALIDATION_ERROR',
      correlation_id: 'cid-42',
    });
  });

  it('reports the offending field and message', () => {
    const schema = z.object({ email: z.string(), age: z.number() });
    const res = runHandler(zodErrorFor(schema, { email: 123, age: 'old' }));
    const fields = res.body.errors.map((e) => e.field);
    expect(fields).toContain('email');
    expect(fields).toContain('age');
    for (const e of res.body.errors) expect(typeof e.message).toBe('string');
  });

  it('joins nested paths with dots', () => {
    const schema = z.object({ user: z.object({ profile: z.object({ handle: z.string() }) }) });
    const res = runHandler(zodErrorFor(schema, { user: { profile: { handle: 7 } } }));
    expect(res.body.errors[0].field).toBe('user.profile.handle');
  });

  it('does not fall over on a ZodError carrying no issues', () => {
    const res = runHandler(new z.ZodError([]));
    expect(res.statusCode).toBe(400);
    expect(res.body.errors).toEqual([]);
  });

  it('reads .issues, which is the only property Zod 4 actually provides', () => {
    // Guards the exact upgrade breakage: if this ever reverts to `.errors`, the value is
    // undefined and `.map` throws inside the handler.
    const err = zodErrorFor(z.object({ email: z.string() }), { email: 123 });
    expect(Array.isArray(err.issues)).toBe(true);
    expect(err.errors).toBeUndefined();
    expect(runHandler(err).body.errors.length).toBe(err.issues.length);
  });

  it('a hand-built ZodError-shaped object is NOT treated as one', () => {
    // Zod 4 brands ZodError via Symbol.hasInstance, so only genuine parse failures reach the
    // validation branch. Anything else is an unexpected error and must surface as a 500.
    const impostor = Object.create(z.ZodError.prototype);
    Object.assign(impostor, { issues: [{ path: ['name'], message: 'Required' }] });
    expect(impostor instanceof z.ZodError).toBe(false);
    expect(runHandler(impostor).statusCode).toBe(500);
  });
});
