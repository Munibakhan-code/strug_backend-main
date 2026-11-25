// The bug-report follow-up loop, end to end.
//
// Motivation (board #462): a report was resolved on a plausible theory because there was no
// way to ask the reporter "which account? which page? does it survive a hard refresh?".
// These tests pin the loop that closes that gap — board asks → reporter is reached → reporter
// answers as a normal app user → the answer lands on the ticket and it becomes actionable —
// and the privacy boundary around it (nothing new may leak to the public board).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app.js';
import { db, truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// The board is a different identity from an app user: a board_member JWT carries
// permission:'board' + member_id, and bugAdminAuth requires can_assign OR can_review.
function boardHeader(member) {
  const token = jwt.sign(
    { permission: 'board', member_id: member.member_id },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
}

async function createBoardMember(overrides = {}) {
  return db.board_member.create({
    data: {
      name: 'Board Reviewer',
      email: `reviewer-${Date.now()}-${Math.round(Math.random() * 1e6)}@strug.ca`,
      password: 'hashed-unused',
      status: 'approved',
      can_review: true,
      ...overrides,
    },
  });
}

async function createReport(user, overrides = {}) {
  return db.bug_report.create({
    data: {
      user_id: user.user_id,
      email: 'reporter@strug.test',
      title: 'Social comments disappear after posting',
      description: 'I post a comment and it vanishes.',
      category: 'bug',
      severity: 'high',
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe('the ask → answer loop', () => {
  it('board asks a question: it lands on the thread and blocks the ticket on the reporter', async () => {
    const reporter = await createUser();
    const member = await createBoardMember({ name: 'Senuda' });
    const report = await createReport(reporter);

    const res = await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'Which account were you on, and does it survive a hard refresh?' });

    expect(res.status).toBe(201);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.message).toMatchObject({
      author_type: 'board',
      author_name: 'Senuda',
      body: 'Which account were you on, and does it survive a hard refresh?',
    });
    // The whole point of the new status: a blocked ticket must not look like idle triage work.
    expect(res.body.data.status).toBe('awaiting_reporter');

    const row = await db.bug_report.findUnique({ where: { bug_report_id: report.bug_report_id } });
    expect(row.status).toBe('awaiting_reporter');
  });

  it('the reporter sees the question on GET /mine — as a normal app user, no board login', async () => {
    const reporter = await createUser();
    const member = await createBoardMember();
    const report = await createReport(reporter);

    await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'Which page were you on?' });

    const mine = await request(app).get('/bug-reports/mine').set(authHeader(reporter));

    expect(mine.status).toBe(200);
    expect(mine.body.reports).toHaveLength(1);
    const [mineReport] = mine.body.reports;
    expect(mineReport.awaiting_you).toBe(true);
    expect(mineReport.messages).toHaveLength(1);
    expect(mineReport.messages[0]).toMatchObject({ author_type: 'board', body: 'Which page were you on?' });
  });

  it('the reporter answers: the ticket becomes actionable again and flags the board', async () => {
    const reporter = await createUser();
    const member = await createBoardMember();
    const report = await createReport(reporter);

    await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'Which account?' });

    const answer = await request(app)
      .post(`/bug-reports/mine/${report.bug_report_id}/messages`)
      .set(authHeader(reporter))
      .send({ body: 'The @codezero account, on the profile page. It survives a refresh.' });

    expect(answer.status).toBe(201);
    expect(answer.body.data.message.author_type).toBe('reporter');
    // Answered ⇒ a human needs to look again. That is what `open` means.
    expect(answer.body.data.status).toBe('open');

    // ...and the board sees the answer, flagged so it can't sink into the open backlog.
    const admin = await request(app).get('/bug-reports/admin').set(boardHeader(member));
    const [card] = admin.body.reports;
    expect(card.status).toBe('open');
    expect(card.awaiting_board).toBe(true);
    expect(card.messages).toHaveLength(2);
    expect(card.messages.map((m) => m.author_type)).toEqual(['board', 'reporter']);
  });

  it('a late answer does not silently reopen a ticket the board already resolved', async () => {
    const reporter = await createUser();
    const report = await createReport(reporter, { status: 'resolved' });

    const answer = await request(app)
      .post(`/bug-reports/mine/${report.bug_report_id}/messages`)
      .set(authHeader(reporter))
      .send({ body: 'Oh, one more thing…' });

    expect(answer.status).toBe(201);
    expect(answer.body.data.status).toBe('resolved');
  });

  it('the POST echo and the GET list render a message identically', async () => {
    // #462's root cause was FE/BE field drift: the POST echo named fields differently from the
    // GET list, so a just-created row rendered differently from a refetched one. Both go
    // through serializeMessage() now — this test is what keeps them in lockstep.
    const reporter = await createUser();
    const member = await createBoardMember();
    const report = await createReport(reporter);

    const posted = await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'echo check' });

    const admin = await request(app).get('/bug-reports/admin').set(boardHeader(member));
    const fetched = admin.body.reports[0].messages[0];

    expect(Object.keys(posted.body.data.message).sort()).toEqual(Object.keys(fetched).sort());
    expect(posted.body.data.message).toEqual(fetched);
  });
});

describe('authorisation', () => {
  it('a normal user cannot ask a question through the board endpoint', async () => {
    const reporter = await createUser();
    const report = await createReport(reporter);

    const res = await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(authHeader(reporter))
      .send({ body: 'let me in' });

    expect(res.status).toBe(403);
  });

  it('a user cannot reply on someone else\'s report — and is not told it exists', async () => {
    const reporter = await createUser();
    const stranger = await createUser();
    const report = await createReport(reporter);

    const res = await request(app)
      .post(`/bug-reports/mine/${report.bug_report_id}/messages`)
      .set(authHeader(stranger))
      .send({ body: 'nosy' });

    expect(res.status).toBe(404); // same as "doesn't exist" — no existence oracle
    expect(await db.bug_report_message.count()).toBe(0);
  });

  it('refuses to ask a question on a report with no linked account', async () => {
    const member = await createBoardMember();
    const orphan = await db.bug_report.create({
      data: { title: 'Anonymous report', description: 'nobody to ask', user_id: null },
    });

    const res = await request(app)
      .post(`/bug-reports/admin/${orphan.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'who are you?' });

    expect(res.status).toBe(409);
    // The question is refused outright rather than written into a thread nobody will read.
    expect(await db.bug_report_message.count()).toBe(0);
  });
});

describe('privacy boundaries', () => {
  it('the public board leaks nothing new — no thread, no context, no description', async () => {
    const reporter = await createUser();
    const member = await createBoardMember();
    const report = await createReport(reporter, {
      is_public: true,
      admin_note: 'internal: probably a dupe of #401',
      client_context: { console: [{ level: 'error', message: 'TypeError: x is undefined', at: null }], api: [], session: null },
    });
    await request(app)
      .post(`/bug-reports/admin/${report.bug_report_id}/messages`)
      .set(boardHeader(member))
      .send({ body: 'which account?' });

    const pub = await request(app).get('/bug-reports/public');

    expect(pub.status).toBe(200);
    const [row] = pub.body.reports;
    const keys = Object.keys(row);
    for (const forbidden of ['description', 'email', 'admin_note', 'client_context', 'messages', 'user_id', 'page_url', 'user_agent', 'reporter']) {
      expect(keys).not.toContain(forbidden);
    }
    const serialised = JSON.stringify(pub.body);
    expect(serialised).not.toContain('which account?');
    expect(serialised).not.toContain('probably a dupe');
    expect(serialised).not.toContain('TypeError');
  });

  it('the reporter never sees the board-internal note or the captured console context', async () => {
    const reporter = await createUser();
    await createReport(reporter, {
      admin_note: 'internal: reporter is unreliable',
      client_context: { console: [{ level: 'error', message: 'TypeError: x is undefined', at: null }], api: [], session: null },
    });

    const mine = await request(app).get('/bug-reports/mine').set(authHeader(reporter));

    const [row] = mine.body.reports;
    expect(row).not.toHaveProperty('admin_note');
    expect(row).not.toHaveProperty('client_context');
    expect(JSON.stringify(mine.body)).not.toContain('unreliable');
  });
});

describe('capture at submit time', () => {
  it('stores sanitised context and strips the token out of page_url', async () => {
    const reporter = await createUser();

    const res = await request(app)
      .post('/bug-reports/submit')
      .set(authHeader(reporter))
      .field('title', 'Comments vanish')
      .field('description', 'I post a comment and it disappears immediately.')
      .field('category', 'bug')
      // The URL the SPA was on. Our own tooling authenticates via ?token=…&user=… — a live
      // access token must never be persisted into a board-readable column.
      .field('page_url', 'https://app.strug.ca/social?token=live-access-token&user=7')
      .field('client_context', JSON.stringify({
        build_sha: 'deadbeef123',
        viewport: '390x844',
        device_type: 'mobile',
        nav_id: 'social',
        console: [{ level: 'error', message: 'TypeError: comment.author is undefined', at: '2026-07-15T10:00:00.000Z' }],
        api: [{ method: 'POST', path: '/social/comments?token=leak', status: 500, at: '2026-07-15T10:00:00.000Z' }],
        session: { authenticated: true, user_id: reporter.user_id, locale: 'en', timezone: 'America/Toronto', session_age_s: 120 },
      }));

    expect(res.status).toBe(201);

    const row = await db.bug_report.findUnique({ where: { bug_report_id: res.body.data.bug_report_id } });
    expect(row.page_url).toBe('https://app.strug.ca/social');
    expect(row.page_url).not.toContain('live-access-token');
    expect(row).toMatchObject({ build_sha: 'deadbeef123', viewport: '390x844', device_type: 'mobile', nav_id: 'social' });
    expect(row.client_context.console[0].message).toContain('TypeError');
    expect(row.client_context.api[0].path).toBe('/social/comments'); // query stripped
    expect(row.client_context.session.user_id).toBe(reporter.user_id);
  });

  it('a malformed context blob costs the reporter nothing — the report still lands', async () => {
    const reporter = await createUser();

    const res = await request(app)
      .post('/bug-reports/submit')
      .set(authHeader(reporter))
      .field('title', 'Something broke')
      .field('description', 'It broke in a way I cannot describe well.')
      .field('client_context', 'not-valid-json{{{');

    expect(res.status).toBe(201);
    const row = await db.bug_report.findUnique({ where: { bug_report_id: res.body.data.bug_report_id } });
    expect(row.client_context).toBeNull();
  });
});
