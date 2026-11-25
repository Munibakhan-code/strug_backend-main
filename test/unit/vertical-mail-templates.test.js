/**
 * Vertical branded mails: dating / medical / venues / social.
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import {
  EMAIL_TEMPLATE_REGISTRY,
  sampleVariablesForTemplate,
} from '../../scripts/email-template-registry.js';
import { renderEmailHtml } from '../../utils/mailer.js';
import i18next from '../../utils/i18n.js';

const VERTICAL = [
  'dating-match',
  'dating-worth-it-invite',
  'medical-booking-confirmed',
  'medical-booking-request',
  'venue-booking-confirmed',
  'venue-booking-request',
  'social-new-follower',
];

const emitUserMail = vi.fn().mockResolvedValue({ ok: true });
const emitSocialProfileMail = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../../utils/emit-user-mail.js', () => ({
  appPublicBase: () => 'https://app.strug.ca',
  emitUserMail: (...a) => emitUserMail(...a),
  emitSocialProfileMail: (...a) => emitSocialProfileMail(...a),
  loadMailRecipient: vi.fn(),
}));

describe('vertical mail templates', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
  });

  beforeEach(() => {
    emitUserMail.mockClear();
    emitSocialProfileMail.mockClear();
  });

  it('registers all vertical templates', () => {
    for (const name of VERTICAL) {
      const row = EMAIL_TEMPLATE_REGISTRY.find((r) => r.template === name);
      expect(row, name).toBeTruthy();
      expect(row.subjectKey).toMatch(/^emails\./);
    }
  });

  it('renders vertical templates without throwing', async () => {
    const t = i18next.getFixedT('en');
    for (const name of VERTICAL) {
      const vars = sampleVariablesForTemplate(name, t);
      const html = await renderEmailHtml(name, vars, 'en');
      expect(html.length).toBeGreaterThan(150);
      expect(html).toContain(vars.cta_url);
    }
  });

  it('rejects empty follower name in sample as invalid product copy edge', () => {
    const t = i18next.getFixedT('en');
    const vars = sampleVariablesForTemplate('social-new-follower', t);
    expect(String(vars.follower_name || '').trim().length).toBeGreaterThan(0);
  });

  it('booking helper only mails medical and venue', async () => {
    const { emitBookingConfirmedMail, emitBookingRequestMail } = await import(
      '../../utils/booking-vertical-mail.js'
    );
    emitBookingConfirmedMail({
      vertical: 'hotel',
      guestId: 1,
      bookingId: 9,
      listingTitle: 'X',
    });
    expect(emitUserMail).not.toHaveBeenCalled();

    emitBookingConfirmedMail({
      vertical: 'medical',
      guestId: 2,
      bookingId: 10,
      listingTitle: 'Dr',
      booking: { start_date: '2026-09-20', start_time: '10:00' },
    });
    expect(emitUserMail).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 2,
        templateName: 'medical-booking-confirmed',
      }),
    );

    emitBookingRequestMail({
      vertical: 'venue',
      hostId: 3,
      guestName: 'Sam',
      bookingId: 11,
      listingTitle: 'Hall',
    });
    expect(emitUserMail).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 3,
        templateName: 'venue-booking-request',
      }),
    );
  });

  it('booking helper no-ops on missing user id', async () => {
    const { emitBookingConfirmedMail } = await import(
      '../../utils/booking-vertical-mail.js'
    );
    emitBookingConfirmedMail({
      vertical: 'medical',
      guestId: null,
      bookingId: 1,
    });
    expect(emitUserMail).not.toHaveBeenCalled();
  });
});
