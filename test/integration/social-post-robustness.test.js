import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// Two 500s found while exercising prod. Neither is reachable from the app (it sends FormData and
// never requests /mine), but both turn a caller mistake into "the server is broken", which is
// exactly what sent us hunting a phantom post-pipeline outage.
describe('social-post — robustness', () => {
    // multer only populates req.files for a MULTIPART body. With a JSON body it is undefined, so
    // `req.files.entries()` threw a TypeError and every text-only JSON post 500'd.
    it('accepts a text-only post over a JSON body (req.files is undefined there)', async () => {
        const user = await createUser({ email: 'poster@example.com' });
        await request(app).post('/social-profile/setup').set(authHeader(user))
            .send({ handle: 'poster', display_name: 'Poster' });

        const res = await request(app)
            .post('/social-post/create')
            .set(authHeader(user))
            .send({ caption_text: 'hello from json', status: 'published' });

        expect(res.status).not.toBe(500);
        expect(res.body.successful).toBe(true);
    });

    // GET /:id is the catch-all, so an unmatched path (e.g. the /mine route that does not exist)
    // arrives as ":id". parseInt('mine') is NaN, Prisma threw on the NaN lookup, and the caller got
    // a 500. A non-numeric id is a bad request, not a server fault.
    it('returns 400 (not 500) for a non-numeric post id', async () => {
        const res = await request(app).get('/social-post/mine');
        expect(res.status).toBe(400);
        expect(res.body.successful).toBe(false);
    });

    it('still serves a real post by numeric id', async () => {
        const user = await createUser({ email: 'poster2@example.com' });
        await request(app).post('/social-profile/setup').set(authHeader(user))
            .send({ handle: 'poster2', display_name: 'Poster Two' });
        const created = await request(app).post('/social-post/create').set(authHeader(user))
            .send({ caption_text: 'findable', status: 'published' });

        const id = created.body.data.social_post_id;
        const res = await request(app).get(`/social-post/${id}`);

        expect(res.status).toBe(200);
        expect(res.body.data.caption_text).toBe('findable');
    });
});
