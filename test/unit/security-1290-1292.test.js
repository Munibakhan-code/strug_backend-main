/**
 * #1292: global Prisma omit for bank / OTP / KYC fields.
 * Source-level guard so default client config keeps stripping these.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../../utils/prisma-client.js'), 'utf8');

describe('prisma-client omit expansion (#1292)', () => {
  it('omits bank account numbers on bank_info and withdrawal models', () => {
    expect(src).toMatch(/bank_info:\s*\{\s*bank_account_number:\s*true/);
    expect(src).toMatch(/withdrawalRequest:\s*\{\s*account_number:\s*true/);
    expect(src).toMatch(/artistWithdrawalRequest:\s*\{\s*account_number:\s*true/);
    expect(src).toMatch(/celebrityWithdrawalRequest:\s*\{\s*account_number:\s*true/);
  });

  it('omits driver document URLs and food/ride OTP codes', () => {
    expect(src).toMatch(/driver_document:\s*\{\s*document_url:\s*true,\s*document_name:\s*true/);
    expect(src).toMatch(/food_order:\s*\{\s*otp_code:\s*true/);
    expect(src).toMatch(/active_trip:\s*\{\s*otp_code:\s*true/);
  });

  it('omits ads tax_id and brn', () => {
    expect(src).toMatch(/ads_account_profile:\s*\{\s*tax_id:\s*true,\s*brn:\s*true/);
  });
});

describe('app.js scaffold unmount (#1291)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

  it('does not mount cloth / discord / flash / cam / calm catalog scaffolds', () => {
    for (const p of [
      '/cloth',
      '/cloth-category',
      '/discord-server',
      '/flash-card',
      '/flashcard',
      '/cam-post',
      '/calm-lesson',
      '/calm-providers',
    ]) {
      expect(appSrc).not.toMatch(new RegExp(`app\\.use\\('${p.replace('/', '\\/')}'`));
    }
  });

  it('keeps calm-lesson-order-buy and dg-cart mounted', () => {
    expect(appSrc).toMatch(/app\.use\('\/calm-lesson-order-buy'/);
    expect(appSrc).toMatch(/app\.use\('\/dg-cart'/);
  });
});
