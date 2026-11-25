import xss from 'xss';

function recursiveSanitize(data) {
  if (typeof data === 'string') {
    return xss(data);
  }
  if (Array.isArray(data)) {
    return data.map(item => recursiveSanitize(item));
  }
  if (data !== null && typeof data === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = recursiveSanitize(value);
    }
    return sanitized;
  }
  return data;
}

export function sanitizeInput(req, res, next) {
  if (req.body) {
    req.body = recursiveSanitize(req.body);
  }
  next();
}