import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// Epic 10 (b): the notification panel's per-row ✕ (dismiss) deletes the row for good. Prior to
// this route there was no way to remove a notification — only mark it read — so a dismissed row
// reappeared on the next refetch. Deletion is scoped by user_id so it can't touch another user's
// rows, and is idempotent (a second delete 404s, which the client reads as "already gone").
describe('DELETE /notifications/:id — dismiss', () => {
  const makeNotif = (userId, over = {}) =>
    db.notification.create({
      data: { user_id: userId, vertical: 'payments', type: 'payout.paid', urgency: 'ambient', title: 'Payout sent', ...over },
    });

  it('deletes the caller’s own row and it stops coming back', async () => {
    const user = await createUser({});
    const n = await makeNotif(user.user_id);

    await request(app).delete(`/notifications/${n.notification_id}`).set(authHeader(user)).expect(200);

    const list = await request(app).get('/notifications').set(authHeader(user)).expect(200);
    expect(list.body.items.find((i) => i.notification_id === n.notification_id)).toBeUndefined();
    expect(await db.notification.findUnique({ where: { notification_id: n.notification_id } })).toBeNull();
  });

  it('cannot delete another user’s row (404, row survives)', async () => {
    const owner = await createUser({});
    const attacker = await createUser({});
    const n = await makeNotif(owner.user_id);

    await request(app).delete(`/notifications/${n.notification_id}`).set(authHeader(attacker)).expect(404);
    expect(await db.notification.findUnique({ where: { notification_id: n.notification_id } })).not.toBeNull();
  });

  it('404s on an already-dismissed row (idempotent)', async () => {
    const user = await createUser({});
    const n = await makeNotif(user.user_id);
    await request(app).delete(`/notifications/${n.notification_id}`).set(authHeader(user)).expect(200);
    await request(app).delete(`/notifications/${n.notification_id}`).set(authHeader(user)).expect(404);
  });

  it('400s on a non-numeric id', async () => {
    const user = await createUser({});
    await request(app).delete('/notifications/not-a-number').set(authHeader(user)).expect(400);
  });

  it('requires auth', async () => {
    await request(app).delete('/notifications/1').expect(401);
  });
});
