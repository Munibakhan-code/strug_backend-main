/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  mergeMessageOriginMetadata,
  normalizeMessageOriginKey,
} from '../../utils/chat-message-origin.js';

describe('normalizeMessageOriginKey', () => {
  it('drops dm and empty', () => {
    expect(normalizeMessageOriginKey('dm')).toBe('');
    expect(normalizeMessageOriginKey(null)).toBe('');
  });

  it('keeps job_application', () => {
    expect(normalizeMessageOriginKey('job_application')).toBe('job_application');
  });
});

describe('mergeMessageOriginMetadata', () => {
  it('stamps channel context onto empty metadata', () => {
    const m = mergeMessageOriginMetadata(null, {
      context_type: 'job_application',
      context_id: 44,
    });
    expect(m).toEqual({ origin: 'job_application', origin_context_id: 44 });
  });

  it('does not overwrite client origin', () => {
    const m = mergeMessageOriginMetadata(
      { origin: 'medical', reply_to: { id: 1 } },
      { context_type: 'food', context_id: 9 },
    );
    expect(m.origin).toBe('medical');
    expect(m.reply_to).toEqual({ id: 1 });
  });

  it('returns null when no origin and no metadata', () => {
    expect(mergeMessageOriginMetadata(null, { context_type: 'dm' })).toBeNull();
  });
});
