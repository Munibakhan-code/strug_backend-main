/**
 * OTP emails must include the code in the plain-text part.
 * Subject-only text made clients look empty / broken.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mailerSrc = fs.readFileSync(path.join(__dirname, '../../utils/mailer.js'), 'utf8');
const layoutSrc = fs.readFileSync(
  path.join(__dirname, '../../templates/emails/layout.hbs'),
  'utf8',
);

describe('mailer OTP plaintext + layout hygiene', () => {
  it('builds a text body for otp that includes otp_code (not subject-only)', () => {
    expect(mailerSrc).toMatch(/templateName === ['"]otp['"]/);
    expect(mailerSrc).toMatch(/variables\?\.otp_code/);
    expect(mailerSrc).toMatch(/text:\s*textBody/);
    expect(mailerSrc).not.toMatch(/text:\s*subject\s*,/);
  });

  it('layout comments are English-only (no Sinhala HTML comments)', () => {
    expect(layoutSrc).not.toMatch(/[\u0D80-\u0DFF]/);
  });
});
