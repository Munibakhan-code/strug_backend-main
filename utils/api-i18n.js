/**
 * Helpers for translated API responses (use with i18next-http-middleware on req.t).
 */

export function apiMessage(req, key, options = {}) {
  if (typeof req?.t === 'function') {
    return req.t(key, options);
  }
  return key;
}

export function sendError(res, status, req, key, options = {}) {
  const message = apiMessage(req, key, options);
  return res.status(status).json({ successful: false, message, error: message });
}

export function sendSuccess(res, req, key, data = {}, options = {}) {
  const message = key ? apiMessage(req, key, options) : undefined;
  return res.json({ successful: true, ...(message ? { message } : {}), ...data });
}
