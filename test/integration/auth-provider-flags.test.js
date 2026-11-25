import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { app } from '../../app.js';
import { encryptSearch } from '../../utils/crypto.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// Regression for #187/#190: the login payload must echo the persisted provider flags
// (is_seller / is_creator) so the seller dashboards + Become-a-Provider hub don't re-show
// the "become a provider" gate after a returning user logs back in. Previously the login
// response omitted is_seller entirely, so getUser().is_seller was undefined on every fresh
// session and the ecommerce dashboard kept re-prompting to register.
describe('POST /auth/login — provider flag echo', () => {
  async function makeUser(overrides) {
    const password = 'TestPass123';
    const email = `flags-${Date.now()}-${Math.random().toString(36).slice(2)}@strug.test`;
    // Real accounts store email as deterministic ciphertext (registration encryptSearch's it);
    // login looks up by encryptSearch(login), so the seeded row must match that form.
    const u = await createUser({ email: encryptSearch(email), password: await bcrypt.hash(password, 10), ...overrides });
    return { u, email, password };
  }

  it('returns is_seller:true for a user who has applied as a seller', async () => {
    const { email, password } = await makeUser({ is_seller: true });
    const res = await request(app).post('/auth/login').send({ login: email, password }).expect(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.user.is_seller).toBe(true);
    expect(res.body.user.is_creator).toBe(false);
  });

  it('returns is_creator:true for a creator', async () => {
    const { email, password } = await makeUser({ is_creator: true });
    const res = await request(app).post('/auth/login').send({ login: email, password }).expect(200);
    expect(res.body.user.is_creator).toBe(true);
    expect(res.body.user.is_seller).toBe(false);
  });

  it('returns both flags false for a plain user (no re-prompt regression)', async () => {
    const { email, password } = await makeUser({});
    const res = await request(app).post('/auth/login').send({ login: email, password }).expect(200);
    expect(res.body.user.is_seller).toBe(false);
    expect(res.body.user.is_creator).toBe(false);
  });
});
