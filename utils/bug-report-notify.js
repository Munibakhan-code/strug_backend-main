// utils/bug-report-notify.js
//
// Best-effort "a new report just came in" alert. Called fire-and-forget from
// POST /bug-reports/submit — it must NEVER block or fail the submission, so every
// path is wrapped and returns quietly.
//
// The same intake doubles as a feature-suggestion channel (category === 'feature'),
// so the alert renders as one of two kinds — a BUG REPORT or a FEATURE REQUEST —
// with distinct subject line, wording and accent, while sharing one code path.
//
// Recipients come from BUG_ALERT_EMAIL (comma-separated). If it (or Resend) isn't
// configured the alert is logged and skipped — exactly like the video-pipeline
// monitor's VIDEO_ALERT_EMAIL gate. Change the recipient via the env var, no code edit.

import { sendEmail, isResendConfigured } from '../services/email-service.js';

const ADMIN_PANEL_URL = process.env.BUG_ADMIN_PANEL_URL || 'https://strug.ca/bug-reports/admin';

const SEVERITY_COLOR = {
  low: '#5b8def',
  medium: '#e0a32e',
  high: '#e8743b',
  critical: '#e5484d',
};

// Per-kind presentation. `feature` submissions read as product requests, not defects,
// so the priority field is labelled "Priority" rather than "Severity" and the accent
// is a distinct violet. Everything else falls through to the bug-report styling.
const KIND = {
  bug: {
    emoji: '🐞',
    kicker: 'Strug · Bug reports',
    heading: 'New report',
    noun: 'bug report',
    levelLabel: 'Severity',
    cta: 'Open the triage panel →',
    accent: null, // use the severity colour
  },
  feature: {
    emoji: '💡',
    kicker: 'Strug · Feature requests',
    heading: 'New request',
    noun: 'feature request',
    levelLabel: 'Priority',
    cta: 'Open the feature board →',
    accent: '#7c5cff',
  },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function recipients() {
  return (process.env.BUG_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Email an admin that a new report was submitted. Best-effort; never throws.
 * Renders as a bug-report alert, or a feature-request alert when
 * `report.category === 'feature'`.
 * @param {object} report - the freshly created bug_report row (+ optional reporter label)
 */
export async function notifyNewBugReport(report) {
  try {
    if (!report) return;

    const to = recipients();
    if (to.length === 0 || !isResendConfigured()) {
      console.warn(
        `[bug-alert] new report #${report.bug_report_id} "${report.title}" — ` +
        `${to.length === 0 ? 'BUG_ALERT_EMAIL not set' : 'Resend not configured'}; email skipped`,
      );
      return;
    }

    const category = String(report.category || 'bug').toLowerCase();
    const isFeature = category === 'feature';
    const kind = isFeature ? KIND.feature : KIND.bug;

    const sev = String(report.severity || 'medium').toLowerCase();
    const sevColor = SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium;
    const accent = kind.accent || sevColor; // features get a fixed accent; bugs track severity
    const reporter = report.reporter_label || (report.user_id ? `user/${report.user_id}` : 'Anonymous');
    const idLabel = `#${String(report.bug_report_id).padStart(3, '0')}`;

    const subject = `${kind.emoji} New ${kind.noun} ${idLabel} · ${sev.toUpperCase()} — ${report.title}`;

    const rows = [
      [kind.levelLabel, `<span style="color:${sevColor};font-weight:700;text-transform:uppercase">${esc(sev)}</span>`],
      ['Category', esc(category)],
      ['Reporter', esc(reporter)],
      report.page_url ? ['Page', `<a href="${esc(report.page_url)}" style="color:#5b8def">${esc(report.page_url)}</a>`] : null,
      report.user_agent ? ['Agent', esc(report.user_agent)] : null,
    ].filter(Boolean);

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;margin:0 0 4px">${kind.kicker}</p>
        <h1 style="font-size:20px;margin:0 0 14px">${kind.heading} ${idLabel}: ${esc(report.title)}</h1>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          ${rows.map(([k, v]) => `<tr>
            <td style="padding:6px 10px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${k}</td>
            <td style="padding:6px 0">${v}</td></tr>`).join('')}
        </table>
        <p style="margin:16px 0 6px;color:#64748b;font-size:13px">Description</p>
        <blockquote style="margin:0;padding:12px 14px;background:#f1f5f9;border-left:3px solid ${accent};border-radius:8px;white-space:pre-wrap;font-size:14px">${esc(report.description)}</blockquote>
        <p style="margin:22px 0 0">
          <a href="${esc(ADMIN_PANEL_URL)}" style="display:inline-block;background:#3C67A6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600">${kind.cta}</a>
        </p>
        <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">You're receiving this because your address is in BUG_ALERT_EMAIL.</p>
      </div>`;

    const text =
      `New ${kind.noun} ${idLabel}: ${report.title}\n` +
      `${kind.levelLabel}: ${sev} · Category: ${category} · Reporter: ${reporter}\n` +
      (report.page_url ? `Page: ${report.page_url}\n` : '') +
      `\n${report.description}\n\nTriage: ${ADMIN_PANEL_URL}\n`;

    await sendEmail({ to, subject, html, text });
    console.log(`[bug-alert] emailed ${to.length} recipient(s) for ${kind.noun} #${report.bug_report_id}`);
  } catch (err) {
    // Never let a notification failure surface to the reporter.
    console.error('[bug-alert] failed to send new-report email:', err?.message || err);
  }
}

// ── Reporter ↔ board thread ──────────────────────────────────────────────────────────────
//
// The in-app notification (services/notify.js) is the PRIMARY channel for reaching a reporter
// — it's durable, it rings the bell, and it deep-links straight to the thread. Email is the
// FALLBACK for a reporter who isn't currently in the app. Both are best-effort and neither
// may ever block the board member who asked the question.

const APP_URL = process.env.APP_PUBLIC_URL || 'https://app.strug.ca';
const MY_REPORTS_URL = `${APP_URL}/my-reports`;

/**
 * Email a reporter that the board asked them a follow-up question.
 * Best-effort; never throws. Falls back silently when Resend/the address is missing —
 * the in-app notification has already landed regardless.
 *
 * @param {object} report   the bug_report row (needs bug_report_id, title)
 * @param {string} to       the reporter's email address
 * @param {string} question the board's message body
 * @param {string} [asker]  board member name, for the byline
 */
export async function notifyReporterQuestion(report, to, question, asker) {
  try {
    if (!report || !to || !question) return;
    if (!isResendConfigured()) {
      console.warn(`[bug-alert] question on #${report.bug_report_id} — Resend not configured; reporter email skipped`);
      return;
    }

    const idLabel = `#${String(report.bug_report_id).padStart(3, '0')}`;
    const from = asker ? esc(asker) : 'The Strug team';
    const subject = `Re: your report ${idLabel} — we need a bit more info`;

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;margin:0 0 4px">Strug · Bug reports</p>
        <h1 style="font-size:20px;margin:0 0 6px">A question about your report ${idLabel}</h1>
        <p style="margin:0 0 16px;color:#64748b;font-size:14px">${esc(report.title)}</p>
        <p style="margin:0 0 8px;color:#64748b;font-size:13px">${from} asked:</p>
        <blockquote style="margin:0;padding:12px 14px;background:#f1f5f9;border-left:3px solid #3C67A6;border-radius:8px;white-space:pre-wrap;font-size:14px">${esc(question)}</blockquote>
        <p style="margin:22px 0 0">
          <a href="${esc(MY_REPORTS_URL)}" style="display:inline-block;background:#3C67A6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600">Answer in the app →</a>
        </p>
        <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Replying here won't reach us — please answer in the app so it lands on your report.</p>
      </div>`;

    const text =
      `A question about your report ${idLabel}: ${report.title}\n\n` +
      `${asker || 'The Strug team'} asked:\n${question}\n\n` +
      `Answer in the app: ${MY_REPORTS_URL}\n`;

    await sendEmail({ to, subject, html, text });
    console.log(`[bug-alert] emailed reporter about question on #${report.bug_report_id}`);
  } catch (err) {
    console.error('[bug-alert] failed to send reporter-question email:', err?.message || err);
  }
}

/**
 * Email the board that the reporter answered. Recipients = BUG_ALERT_EMAIL, same as a new
 * report — the board has no per-member notification channel for bug reports, so without this
 * an answer would sit unread until someone happened to reload the triage panel.
 * Best-effort; never throws.
 */
export async function notifyBoardReply(report, answer, reporterLabel) {
  try {
    if (!report || !answer) return;

    const to = recipients();
    if (to.length === 0 || !isResendConfigured()) {
      console.warn(
        `[bug-alert] reporter replied on #${report.bug_report_id} — ` +
        `${to.length === 0 ? 'BUG_ALERT_EMAIL not set' : 'Resend not configured'}; email skipped`,
      );
      return;
    }

    const idLabel = `#${String(report.bug_report_id).padStart(3, '0')}`;
    const who = reporterLabel || (report.user_id ? `user/${report.user_id}` : 'The reporter');
    const subject = `💬 Reporter replied on ${idLabel} — ${report.title}`;

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;margin:0 0 4px">Strug · Bug reports</p>
        <h1 style="font-size:20px;margin:0 0 6px">${esc(who)} answered ${idLabel}</h1>
        <p style="margin:0 0 16px;color:#64748b;font-size:14px">${esc(report.title)}</p>
        <blockquote style="margin:0;padding:12px 14px;background:#f1f5f9;border-left:3px solid #34d399;border-radius:8px;white-space:pre-wrap;font-size:14px">${esc(answer)}</blockquote>
        <p style="margin:22px 0 0">
          <a href="${esc(ADMIN_PANEL_URL)}" style="display:inline-block;background:#3C67A6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600">Open the triage panel →</a>
        </p>
      </div>`;

    const text =
      `${who} answered ${idLabel}: ${report.title}\n\n${answer}\n\nTriage: ${ADMIN_PANEL_URL}\n`;

    await sendEmail({ to, subject, html, text });
    console.log(`[bug-alert] emailed ${to.length} recipient(s) about a reply on #${report.bug_report_id}`);
  } catch (err) {
    console.error('[bug-alert] failed to send reporter-reply email:', err?.message || err);
  }
}
