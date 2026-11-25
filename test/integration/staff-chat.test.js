import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app.js';
import { db, closeDb } from '../helpers/db.js';

// End-to-end verification of the internal staff messaging routes (/board/messages), keyed on
// board_member. Covers: RBAC-scoped channel listing, team-channel access gating, DM dedupe,
// role-gated custom-channel creation, the allowed_roles invite gate, and send→history.
// Runs against the local/CI test DB (schema synced via `prisma db push`).

const boardAuth = (memberId) => ({
  Authorization: `Bearer ${jwt.sign({ permission: 'board', member_id: memberId }, process.env.ACCESS_TOKEN_KEY, { expiresIn: '1h' })}`,
});

describe('staff messaging (/board/messages)', () => {
  let financeRole, plainRole;
  let alice, bob, carol; // alice: finance + can_create; bob: finance; carol: no finance, no create

  beforeAll(async () => {
    // Clean slate (order matters for the bare-int FKs we model in app code).
    await db.staff_message.deleteMany();
    await db.staff_channel_member.deleteMany();
    await db.staff_channel.deleteMany();
    await db.board_notification.deleteMany();
    await db.board_member.deleteMany();
    await db.board_role.deleteMany();

    financeRole = await db.board_role.create({
      data: { key: `finance-${Date.now()}`, name: 'Finance', access: { finance: 'write' }, can_create_channels: true },
    });
    plainRole = await db.board_role.create({
      data: { key: `member-${Date.now()}`, name: 'Member', access: {}, can_create_channels: false },
    });

    const mk = (name, email, roleId) =>
      db.board_member.create({ data: { name, email, password: 'x', status: 'approved', role_id: roleId } });
    alice = await mk('Alice', `alice-${Date.now()}@strug.ca`, financeRole.role_id);
    bob = await mk('Bob', `bob-${Date.now()}@strug.ca`, financeRole.role_id);
    carol = await mk('Carol', `carol-${Date.now()}@strug.ca`, plainRole.role_id);
  });

  afterAll(async () => {
    await closeDb();
  });

  const financeChannelId = async (memberId) => {
    const res = await request(app).get('/board/messages/channels').set(boardAuth(memberId));
    const fin = res.body.channels.teams.find((t) => t.dashboard_key === 'finance');
    return fin?.channel_id;
  };

  it('lists company + team channels scoped by RBAC access', async () => {
    const aliceRes = await request(app).get('/board/messages/channels').set(boardAuth(alice.member_id));
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.channels.company.length).toBeGreaterThanOrEqual(1);
    expect(aliceRes.body.channels.teams.some((t) => t.dashboard_key === 'finance')).toBe(true);
    expect(aliceRes.body.can_create_channels).toBe(true);

    const carolRes = await request(app).get('/board/messages/channels').set(boardAuth(carol.member_id));
    expect(carolRes.body.channels.teams.some((t) => t.dashboard_key === 'finance')).toBe(false);
    expect(carolRes.body.can_create_channels).toBe(false);
  });

  it('gates team-channel access: finance member can post, non-member is 403', async () => {
    const cid = await financeChannelId(alice.member_id);
    expect(cid).toBeTruthy();

    const send = await request(app)
      .post(`/board/messages/channels/${cid}/messages`)
      .set(boardAuth(alice.member_id))
      .send({ content: 'hello finance' });
    expect(send.status).toBe(201);
    expect(send.body.message.sender.name).toBe('Alice');

    const denied = await request(app).get(`/board/messages/channels/${cid}/messages`).set(boardAuth(carol.member_id));
    expect(denied.status).toBe(403);

    const history = await request(app).get(`/board/messages/channels/${cid}/messages`).set(boardAuth(bob.member_id));
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m) => m.content)).toContain('hello finance');
  });

  it('dedupes DMs by dm_key and gates non-participants', async () => {
    const open1 = await request(app).post('/board/messages/channels/dm').set(boardAuth(alice.member_id)).send({ target_member_id: bob.member_id });
    expect(open1.status).toBe(200);
    expect(open1.body.created).toBe(true);
    const dmId = open1.body.channel_id;

    const open2 = await request(app).post('/board/messages/channels/dm').set(boardAuth(bob.member_id)).send({ target_member_id: alice.member_id });
    expect(open2.body.channel_id).toBe(dmId); // same channel, order-independent
    expect(open2.body.created).toBe(false);

    const outsider = await request(app).get(`/board/messages/channels/${dmId}/messages`).set(boardAuth(carol.member_id));
    expect(outsider.status).toBe(403);
  });

  it('role-gates custom-channel creation', async () => {
    const ok = await request(app).post('/board/messages/channels').set(boardAuth(alice.member_id)).send({ kind: 'topic', name: 'q3-launch' });
    expect(ok.status).toBe(201);

    const denied = await request(app).post('/board/messages/channels').set(boardAuth(carol.member_id)).send({ kind: 'topic', name: 'nope' });
    expect(denied.status).toBe(403);
  });

  it('enforces allowed_roles on invite', async () => {
    const created = await request(app)
      .post('/board/messages/channels')
      .set(boardAuth(alice.member_id))
      .send({ kind: 'topic', name: 'leadership', allowed_roles: [financeRole.key] });
    const cid = created.body.channel.channel_id;

    const inviteBob = await request(app).post(`/board/messages/channels/${cid}/members`).set(boardAuth(alice.member_id)).send({ member_id: bob.member_id });
    expect(inviteBob.status).toBe(201); // bob holds the finance role → allowed

    const inviteCarol = await request(app).post(`/board/messages/channels/${cid}/members`).set(boardAuth(alice.member_id)).send({ member_id: carol.member_id });
    expect(inviteCarol.status).toBe(403); // carol's role is not in allowed_roles
  });

  it('rejects unauthenticated / non-board tokens', async () => {
    const noAuth = await request(app).get('/board/messages/channels');
    expect(noAuth.status).toBe(401);
  });
});
