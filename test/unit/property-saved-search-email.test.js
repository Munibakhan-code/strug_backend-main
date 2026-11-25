/**
 * Property saved-search optional email (PROPERTY_SAVED_SEARCH_EMAIL).
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    property_saved_search: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    property: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../services/notify.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/mailer.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/cron-email.js', () => ({
  logCronError: vi.fn(),
}));

vi.mock('../../utils/property-filters.js', () => ({
  buildPublicPropertyWhere: vi.fn(() => ({ status: 'published' })),
  filtersToPropertyQuery: vi.fn(() => ({})),
  describeSavedSearchFilters: vi.fn(() => 'Downtown condo'),
}));

vi.mock('../../utils/crypto.js', () => ({
  decrypt: vi.fn((v) => v),
}));

import prisma from '../../utils/prisma-client.js';
import { notify } from '../../services/notify.js';
import { sendEmail } from '../../utils/mailer.js';
import { runPropertySavedSearchAlerts } from '../../utils/property-saved-search-cron.js';

describe('runPropertySavedSearchAlerts email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROPERTY_SAVED_SEARCH_EMAIL;
    prisma.property_saved_search.findMany.mockResolvedValue([
      {
        saved_search_id: 1,
        user_id: 9,
        name: 'Condo hunt',
        vertical: 'realestate',
        filters: {},
        created_at: new Date('2026-01-01'),
        last_notified_at: null,
        alert_enabled: true,
      },
    ]);
    prisma.property.findMany.mockResolvedValue([
      {
        property_id: 42,
        property_name: 'York Condo',
        city: 'Toronto',
        price_min: 500000,
        vertical: 'realestate',
      },
    ]);
    prisma.property_saved_search.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({
      email: 'seeker@example.com',
      name: 'Seeker',
      language: 'en',
    });
  });

  it('does not email unless PROPERTY_SAVED_SEARCH_EMAIL=true', async () => {
    const r = await runPropertySavedSearchAlerts(null);
    expect(r.notified).toBe(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('sends branded property-saved-search when opt-in is on', async () => {
    process.env.PROPERTY_SAVED_SEARCH_EMAIL = 'true';
    const r = await runPropertySavedSearchAlerts(null);
    expect(r.notified).toBe(1);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][0]).toBe('property-saved-search');
    expect(sendEmail.mock.calls[0][2]).toBe('seeker@example.com');
    expect(sendEmail.mock.calls[0][3]).toBe('emails.property_saved_search.subject');
    expect(sendEmail.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headline: expect.stringMatching(/listing/i),
        matches: [expect.objectContaining({ title: 'York Condo', detail: 'Toronto' })],
      }),
    );
  });

  it('skips mail when user has no email (edge)', async () => {
    process.env.PROPERTY_SAVED_SEARCH_EMAIL = 'true';
    prisma.user.findUnique.mockResolvedValue({ email: null, name: 'X', language: 'en' });
    await runPropertySavedSearchAlerts(null);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.property_saved_search.update).toHaveBeenCalled();
  });

  it('no-ops when there are no matches (edge)', async () => {
    prisma.property.findMany.mockResolvedValue([]);
    const r = await runPropertySavedSearchAlerts(null);
    expect(r.notified).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
