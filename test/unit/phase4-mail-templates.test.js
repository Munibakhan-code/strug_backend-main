/**
 * Phase 4 branded templates: render smoke + plaintext builders.
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EMAIL_TEMPLATE_REGISTRY,
  sampleVariablesForTemplate,
} from '../../scripts/email-template-registry.js';
import { renderEmailHtml } from '../../utils/mailer.js';
import i18next from '../../utils/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mailerSrc = fs.readFileSync(path.join(__dirname, '../../utils/mailer.js'), 'utf8');

const PHASE4 = ['event-invite', 'board-invite', 'property-saved-search', 'job-saved-search'];

describe('Phase 4 mail templates', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
  });

  it('registers all Phase 4 templates with subject keys', () => {
    for (const name of PHASE4) {
      const row = EMAIL_TEMPLATE_REGISTRY.find((r) => r.template === name);
      expect(row, name).toBeTruthy();
      expect(row.subjectKey).toMatch(/^emails\./);
    }
  });

  it('renders Phase 4 templates without throwing', async () => {
    const t = i18next.getFixedT('en');
    for (const name of PHASE4) {
      const vars = sampleVariablesForTemplate(name, t);
      const html = await renderEmailHtml(name, vars, 'en');
      expect(html).toMatch(/strug/i);
      expect(html.length).toBeGreaterThan(200);
    }
  });

  it('event-invite HTML includes RSVP link and event title', async () => {
    const t = i18next.getFixedT('en');
    const vars = sampleVariablesForTemplate('event-invite', t);
    const html = await renderEmailHtml('event-invite', vars, 'en');
    expect(html).toContain(vars.rsvp_url);
    expect(html).toContain(vars.event_title);
  });

  it('board-invite HTML includes temp password (admin-created account)', async () => {
    const t = i18next.getFixedT('en');
    const vars = sampleVariablesForTemplate('board-invite', t);
    const html = await renderEmailHtml('board-invite', vars, 'en');
    expect(html).toContain(vars.temp_password);
    expect(html).toContain(vars.board_url);
  });

  it('mailer builds plaintext for event-invite and board-invite', () => {
    expect(mailerSrc).toMatch(/templateName === ['"]event-invite['"]/);
    expect(mailerSrc).toMatch(/templateName === ['"]board-invite['"]/);
    expect(mailerSrc).toMatch(/variables\?\.rsvp_url/);
    expect(mailerSrc).toMatch(/variables\?\.board_url/);
  });

  it('rejects empty match list shape in sample (edge)', () => {
    const t = i18next.getFixedT('en');
    const vars = sampleVariablesForTemplate('property-saved-search', t);
    expect(Array.isArray(vars.matches)).toBe(true);
    expect(vars.matches.length).toBeGreaterThan(0);
    expect(vars.matches[0]).toEqual(expect.objectContaining({ title: expect.any(String) }));
  });
});
