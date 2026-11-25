// Keep required fields and lengths aligned with the channel schema and registration UI.
export function validateChannelInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Channel details must be an object.' };
  }
  const data = {};
  for (const [field, limit] of [['handle', 50], ['display_name', 100]]) {
    const value = body[field];
    if (value === undefined && partial) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return { error: `${field === 'handle' ? 'Handle' : 'Channel name'} is required and must be text.`, field };
    }
    const trimmed = value.trim();
    if (trimmed.length > limit) return { error: `${field === 'handle' ? 'Handle' : 'Channel name'} must be ${limit} characters or fewer.`, field };
    if (field === 'handle' && !/^[a-zA-Z0-9._]+$/.test(trimmed)) {
      return { error: 'Handle may contain only letters, numbers, dots and underscores.', field };
    }
    data[field] = field === 'handle' ? trimmed.toLowerCase() : trimmed;
  }
  for (const field of partial ? ['description', 'content_niche'] : ['description']) {
    if (body[field] === undefined) continue;
    if (body[field] !== null && typeof body[field] !== 'string') {
      return { error: `${field} must be text or null.`, field };
    }
    data[field] = body[field] === null ? null : body[field].trim();
  }
  if (partial && Object.keys(data).length === 0) return { error: 'Provide channel details to update.' };
  return { data };
}
