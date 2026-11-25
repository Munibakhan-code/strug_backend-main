import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// End-to-end verification of the jobs vertical (feat/jobs-vertical):
// employer profile (agents) → post job → seeker applies → employer moves the
// applicant through the pipeline. Also locks in the security fix: the
// applications list is no longer readable without auth / across users.

describe('jobs vertical', () => {
  let employer, seeker, outsider, category;
  let agentId, jobId, appId;

  beforeAll(async () => {
    await truncateAll();
    employer = await createUser();
    seeker = await createUser();
    outsider = await createUser();
    category = await db.job_categories.create({ data: { job_category_name: 'Engineering' } });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('employer creates a profile (agent_user_id derived from token, not body)', async () => {
    const res = await request(app)
      .post('/agents')
      .set(authHeader(employer))
      .send({ agent_user_id: 999999, company_name: 'Acme Co', industry: 'Technology' });
    expect(res.status).toBe(201);
    expect(res.body.agent_user_id).toBe(employer.user_id); // body id ignored
    expect(res.body.company_name).toBe('Acme Co');
    agentId = res.body.agent_id;
  });

  it('employer posts a job under their own agent profile', async () => {
    const res = await request(app)
      .post('/job')
      .set(authHeader(employer))
      .send({
        job_name: 'Backend Engineer',
        description: 'Node.js services',
        job_category_id: category.job_category_id,
        location: 'Toronto, ON',
        is_remote: true,
        employment_type: 'full_time',
        salary_min: 90000,
        salary_max: 130000,
      });
    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe(agentId);
    expect(res.body.status).toBe('open');
    jobId = res.body.job_id;
  });

  it('a user without an employer profile cannot post a job', async () => {
    const res = await request(app)
      .post('/job')
      .set(authHeader(seeker))
      .send({ job_name: 'Should fail' });
    expect(res.status).toBe(403);
  });

  it('public job search returns the open job with filters', async () => {
    const res = await request(app).get('/job?keyword=backend&is_remote=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((j) => j.job_id === jobId)).toBe(true);
  });

  it('seeker applies with résumé URL (candidate profile auto-created)', async () => {
    const res = await request(app)
      .post('/job/applications')
      .set(authHeader(seeker))
      .send({
        job_id: jobId,
        cover_letter: 'I would love to join.',
        cv_url: 'https://cdn.example.com/resumes/seeker.pdf',
      });
    expect(res.status).toBe(201);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.cv_url).toContain('seeker.pdf');
    appId = res.body.data.job_application_id;

    const cand = await db.candidate.findFirst({ where: { candidate_user_id: seeker.user_id } });
    expect(cand).toBeTruthy();
  });

  it('duplicate application is rejected (unique seeker+job)', async () => {
    const res = await request(app)
      .post('/job/applications')
      .set(authHeader(seeker))
      .send({ job_id: jobId });
    expect(res.status).toBe(409);
  });

  it('records seeker funnel analytics (view → apply)', async () => {
    const view = await request(app)
      .post('/job/analytics')
      .set(authHeader(seeker))
      .send({ event: 'job_viewed', job_id: jobId });
    expect(view.status).toBe(202);

    const applied = await request(app)
      .post('/job/analytics')
      .set(authHeader(seeker))
      .send({ event: 'job_applied', job_id: jobId, job_application_id: appId });
    expect(applied.status).toBe(202);

    const bad = await request(app)
      .post('/job/analytics')
      .set(authHeader(seeker))
      .send({ event: 'not_a_real_event' });
    expect(bad.status).toBe(400);
  });

  it('seeker sees their own applications', async () => {
    const res = await request(app).get('/job/applications/mine').set(authHeader(seeker));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].job_application_id).toBe(appId);
  });

  it('employer sees applicants for their job; an outsider cannot', async () => {
    const mine = await request(app).get(`/job/${jobId}/applications`).set(authHeader(employer));
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBe(1);

    const forbidden = await request(app).get(`/job/${jobId}/applications`).set(authHeader(outsider));
    expect(forbidden.status).toBe(403);
  });

  it('employer moves the applicant through the pipeline (and notifies the seeker)', async () => {
    const res = await request(app)
      .patch(`/job/applications/${appId}/status`)
      .set(authHeader(employer))
      .send({ status: 'shortlisted' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('shortlisted');

    const notif = await db.notification.findFirst({
      where: { user_id: seeker.user_id, type: 'job.application.status' },
    });
    expect(notif).toBeTruthy();
  });

  it('a non-employer cannot change application status', async () => {
    const res = await request(app)
      .patch(`/job/applications/${appId}/status`)
      .set(authHeader(seeker))
      .send({ status: 'hired' });
    expect(res.status).toBe(403);
  });

  it('SECURITY: the applications list is not readable without auth', async () => {
    const res = await request(app).get('/job/applications');
    expect(res.status).toBe(401);
  });

  it('SECURITY: a single application is not readable by an unrelated user', async () => {
    const res = await request(app).get(`/job/applications/${appId}`).set(authHeader(outsider));
    expect(res.status).toBe(403);
  });

  it('SECURITY: candidate directory is not listable by a normal user', async () => {
    const res = await request(app).get('/candidate').set(authHeader(outsider));
    expect(res.status).toBe(403);
  });

  it('rejects apply when the job is closed', async () => {
    await db.jobs.update({ where: { job_id: jobId }, data: { status: 'closed' } });
    const res = await request(app)
      .post('/job/applications')
      .set(authHeader(outsider))
      .send({ job_id: jobId, cover_letter: 'too late' });
    expect(res.status).toBe(409);
    await db.jobs.update({ where: { job_id: jobId }, data: { status: 'open' } });
  });

  it('rejects apply when the deadline has passed', async () => {
    await db.jobs.update({
      where: { job_id: jobId },
      data: { status: 'open', deadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const res = await request(app)
      .post('/job/applications')
      .set(authHeader(outsider))
      .send({ job_id: jobId });
    expect(res.status).toBe(409);
    await db.jobs.update({ where: { job_id: jobId }, data: { deadline: null } });
  });

  it('supports offset + salary sort on public search', async () => {
    const res = await request(app).get('/job?sort=salary_desc&limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('employer can save notes, schedule interview, and read timeline', async () => {
    const notes = await request(app)
      .patch(`/job/applications/${appId}/notes`)
      .set(authHeader(employer))
      .send({ employer_notes: ' Strong communicator ' });
    expect(notes.status).toBe(200);
    expect(notes.body.employer_notes).toBe('Strong communicator');

    const when = '2026-09-15T15:00:00.000Z';
    const interview = await request(app)
      .patch(`/job/applications/${appId}/interview`)
      .set(authHeader(employer))
      .send({ interview_at: when, interview_notes: 'Bring portfolio' });
    expect(interview.status).toBe(200);
    expect(new Date(interview.body.interview_at).toISOString()).toBe(when);
    expect(interview.body.interview_notes).toBe('Bring portfolio');

    const timeline = await request(app)
      .get(`/job/applications/${appId}/timeline`)
      .set(authHeader(employer));
    expect(timeline.status).toBe(200);
    expect(Array.isArray(timeline.body)).toBe(true);
    expect(timeline.body.some((e) => e.event_type === 'status')).toBe(true);
    expect(timeline.body.some((e) => e.event_type === 'note')).toBe(true);
    expect(timeline.body.some((e) => e.event_type === 'interview')).toBe(true);

    const forbidden = await request(app)
      .get(`/job/applications/${appId}/timeline`)
      .set(authHeader(outsider));
    expect(forbidden.status).toBe(403);
  });

  it('employer bulk-status updates owned applications only', async () => {
    const bulk = await request(app)
      .post('/job/applications/bulk-status')
      .set(authHeader(employer))
      .send({ ids: [appId], status: 'reviewed' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.updated).toBe(1);
    expect(bulk.body.applications[0].status).toBe('reviewed');

    const denied = await request(app)
      .post('/job/applications/bulk-status')
      .set(authHeader(outsider))
      .send({ ids: [appId], status: 'hired' });
    expect(denied.status).toBe(403);
  });

  it('employer analytics returns a funnel by status', async () => {
    const res = await request(app).get('/job/my/analytics').set(authHeader(employer));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.by_status).toBeTruthy();
    expect(res.body.by_status.reviewed).toBeGreaterThanOrEqual(1);
  });

  it('employer and seeker can open a job_application chat; outsider cannot', async () => {
    const employerChat = await request(app)
      .post(`/chat-context/job-application/${appId}`)
      .set(authHeader(employer));
    expect([200, 201]).toContain(employerChat.status);
    expect(employerChat.body.channel_id).toBeTruthy();

    const seekerChat = await request(app)
      .post(`/chat-context/job-application/${appId}`)
      .set(authHeader(seeker));
    expect([200, 201]).toContain(seekerChat.status);
    expect(seekerChat.body.channel_id).toBe(employerChat.body.channel_id);

    const forbidden = await request(app)
      .post(`/chat-context/job-application/${appId}`)
      .set(authHeader(outsider));
    expect(forbidden.status).toBe(403);
  });

  it('seeker can save a search and run alerts', async () => {
    const created = await request(app)
      .post('/job/saved-searches')
      .set(authHeader(seeker))
      .send({
        name: 'Remote Node',
        filters: { keyword: 'Backend', is_remote: true },
        alert_enabled: true,
        frequency: 'immediate',
      });
    expect(created.status).toBe(201);
    expect(created.body.data?.saved_search_id).toBeTruthy();

    const list = await request(app).get('/job/saved-searches').set(authHeader(seeker));
    expect(list.status).toBe(200);
    expect(list.body.data.some((r) => r.saved_search_id === created.body.data.saved_search_id)).toBe(true);

    const run = await request(app)
      .post('/job/saved-searches/run-alerts')
      .set(authHeader(seeker));
    expect(run.status).toBe(200);
    expect(run.body.successful).toBe(true);
  });

  it('public company profile and hiring rail (no auth, no user PII)', async () => {
    const profile = await request(app).get(`/agents/${agentId}/public`);
    expect(profile.status).toBe(200);
    expect(profile.body.agent_id).toBe(agentId);
    expect(profile.body.company_name).toBe('Acme Co');
    expect(profile.body.user).toBeUndefined();
    expect(profile.body.email).toBeUndefined();
    expect(Array.isArray(profile.body.jobs)).toBe(true);
    expect(profile.body.jobs.some((j) => j.job_id === jobId)).toBe(true);

    const byAgent = await request(app).get(`/job?agent_id=${agentId}`);
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.some((j) => j.job_id === jobId)).toBe(true);

    const hiring = await request(app).get('/agents/hiring?limit=8');
    expect(hiring.status).toBe(200);
    expect(Array.isArray(hiring.body)).toBe(true);
    expect(hiring.body.some((c) => c.agent_id === agentId && c.open_count >= 1)).toBe(true);
    expect(hiring.body.every((c) => c.user == null && c.email == null)).toBe(true);
  });

  it('recommended jobs require auth, exclude applied, and skip ads', async () => {
    await request(app)
      .put('/candidate/me')
      .set(authHeader(seeker))
      .send({ skills: 'Node.js, Backend', location: 'Toronto', desired_salary: 110000 });

    const unauth = await request(app).get('/job/recommended');
    expect(unauth.status).toBe(401);

    const res = await request(app)
      .get('/job/recommended?limit=8')
      .set(authHeader(seeker));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((j) => !j.is_ad && !j.sponsored)).toBe(true);
    expect(res.body.some((j) => j.job_id === jobId)).toBe(false);
  });

  it('seeker can report a job; employer cannot report own listing; blocked content rejected', async () => {
    const own = await request(app)
      .post(`/job/${jobId}/report`)
      .set(authHeader(employer))
      .send({ reason: 'scam' });
    expect(own.status).toBe(400);

    const bad = await request(app)
      .post('/job')
      .set(authHeader(employer))
      .send({ job_name: 'Pay to apply now', description: 'Send fee' });
    expect(bad.status).toBe(400);

    const report = await request(app)
      .post(`/job/${jobId}/report`)
      .set(authHeader(seeker))
      .send({ reason: 'misleading_pay', details: 'Pay range looks fake' });
    expect(report.status).toBe(201);
    expect(report.body.successful).toBe(true);

    const dup = await request(app)
      .post(`/job/${jobId}/report`)
      .set(authHeader(seeker))
      .send({ reason: 'scam' });
    expect(dup.status).toBe(409);
  });
});
