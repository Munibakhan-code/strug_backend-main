/**
 * Minimal PDF builder for structured résumé (no external PDF dependency).
 * Outputs a valid single-page (or multi-page) PDF 1.4 buffer.
 */

import { parseResumeJson, hasResumeJsonContent } from './candidate-resume-json.js';

function pdfEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E\n]/g, (ch) => {
      // Keep ASCII; drop unsupported glyphs for the built-in Helvetica fonts.
      if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
      return '';
    });
}

function wrapLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * @param {unknown} resumeJson
 * @param {{ name?: string, headline?: string }=} profile
 * @returns {Buffer}
 */
export function buildResumePdfBuffer(resumeJson, profile = {}) {
  const resume = parseResumeJson(resumeJson);
  if (!hasResumeJsonContent(resume) && !String(profile.headline || '').trim()) {
    throw new Error('Add summary, experience, or education before exporting.');
  }

  const pageW = 612;
  const pageH = 792;
  const margin = 54;
  const maxChars = 88;
  const lines = [];

  const push = (text, size = 11, bold = false) => {
    lines.push({ text: String(text || ''), size, bold });
  };

  push(String(profile.name || 'Resume').slice(0, 80), 18, true);
  if (profile.headline) push(String(profile.headline).slice(0, 120), 11, false);
  push(' ', 8, false);

  if (resume.summary) {
    push('SUMMARY', 12, true);
    for (const l of wrapLines(resume.summary, maxChars)) push(l, 10, false);
    push(' ', 8, false);
  }

  if (resume.experience.length) {
    push('EXPERIENCE', 12, true);
    for (const row of resume.experience) {
      push([row.title, row.company].filter(Boolean).join(' · ') || 'Role', 11, true);
      const dates = [row.start, row.current ? 'Present' : row.end].filter(Boolean).join(' – ');
      if (dates) push(dates, 9, false);
      if (row.description) {
        for (const l of wrapLines(row.description, maxChars)) push(l, 10, false);
      }
      push(' ', 6, false);
    }
  }

  if (resume.education.length) {
    push('EDUCATION', 12, true);
    for (const row of resume.education) {
      push([row.school, row.degree].filter(Boolean).join(' · ') || 'Education', 11, true);
      const detail = [row.field, row.end].filter(Boolean).join(' · ');
      if (detail) push(detail, 9, false);
      push(' ', 6, false);
    }
  }

  // Paginate content into content streams.
  const pages = [];
  let y = pageH - margin;
  let contentOps = [];
  const flushPage = () => {
    pages.push(contentOps.join('\n'));
    contentOps = [];
    y = pageH - margin;
  };

  for (const row of lines) {
    const leading = row.size + 4;
    if (y - leading < margin) flushPage();
    const font = row.bold ? 'F2' : 'F1';
    contentOps.push('BT');
    contentOps.push(`/${font} ${row.size} Tf`);
    contentOps.push(`${margin} ${y} Td`);
    contentOps.push(`(${pdfEscape(row.text)}) Tj`);
    contentOps.push('ET');
    y -= leading;
  }
  if (contentOps.length) flushPage();
  if (!pages.length) {
    pages.push('BT /F1 11 Tf 54 738 Td (Resume) Tj ET');
  }

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const contentIds = pages.map((stream) =>
    add(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`),
  );

  const pageIds = contentIds.map((contentId) =>
    add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`,
    ),
  );

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = add(`<< /Type /Pages /Kids [ ${kids} ] /Count ${pageIds.length} >>`);

  // Patch Parent refs now that pagesId is known.
  for (let i = 0; i < pageIds.length; i += 1) {
    const idx = pageIds[i] - 1;
    objects[idx] = objects[idx].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }

  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}
