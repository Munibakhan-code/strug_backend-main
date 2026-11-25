import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EMAIL_TEMPLATE_REGISTRY,
  buildMailInventoryMarkdown,
} from '../../scripts/email-template-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, '../../templates/emails');

describe('email template registry organization', () => {
  it('every registry row has vertical, owner, audience, priority', () => {
    for (const row of EMAIL_TEMPLATE_REGISTRY) {
      expect(row.vertical, row.template).toBeTruthy();
      expect(row.owner, row.template).toBeTruthy();
      expect(['user', 'ops']).toContain(row.audience);
      expect(['critical', 'high', 'normal', 'low']).toContain(row.priority);
      expect(row.subjectKey).toMatch(/^emails\./);
    }
  });

  it('every .hbs except layout is registered (and vice versa)', () => {
    const hbs = fs
      .readdirSync(templatesDir)
      .filter((f) => f.endsWith('.hbs') && f !== 'layout.hbs')
      .map((f) => f.replace(/\.hbs$/, ''))
      .sort();
    const registered = EMAIL_TEMPLATE_REGISTRY.map((r) => r.template).sort();
    expect(registered).toEqual(hbs);
  });

  it('buildMailInventoryMarkdown includes vertical column', () => {
    const md = buildMailInventoryMarkdown();
    expect(md).toMatch(/\| Template \| Vertical \|/);
    expect(md).toContain('| `otp` |');
    expect(md).toContain('auth');
  });

  it('rejects empty registry shape (edge)', () => {
    const md = buildMailInventoryMarkdown([]);
    expect(md).toContain('| Template | Vertical |');
    expect(md.split('\n').filter((l) => l.startsWith('| `')).length).toBe(0);
  });
});
