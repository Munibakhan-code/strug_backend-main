/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { buildResumePdfBuffer } from '../../utils/resume-pdf.js';

describe('buildResumePdfBuffer', () => {
  it('rejects empty résumé', () => {
    expect(() => buildResumePdfBuffer({})).toThrow(/Add summary/);
  });

  it('returns a PDF buffer with header', () => {
    const buf = buildResumePdfBuffer(
      { summary: 'Builder', experience: [{ title: 'Eng', company: 'Co' }], education: [] },
      { name: 'Sam', headline: 'Engineer' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('utf8')).toBe('%PDF-');
    expect(buf.toString('utf8')).toContain('%%EOF');
  });
});
