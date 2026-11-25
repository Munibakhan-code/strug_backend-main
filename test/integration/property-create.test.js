import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// Regression: POST /property 500'd on EVERY create in prod, so no Temp Stay / real-estate
// listing could be created at all (the property table sat empty).
//
// #197 (be6e824) added a `vertical` discriminator so a listing shows only in its own feed. The
// route writes it (`vertical: vertical === 'preconstruction' || ... : null`) and the DB has the
// column (0_init: property.vertical VARCHAR(40)) — but the field went MISSING from the property
// model in schema.prisma. Prisma rejects unknown arguments, so every create threw before it ever
// reached Postgres and the handler returned the generic "Failed to create property".
//
// The DB and the route were both right; only the Prisma model was out of sync. A create that
// actually exercises `vertical` is what catches that drift — a create without it would have
// passed while prod stayed broken.
describe('POST /property — vertical discriminator (#197)', () => {
    it('creates a listing and persists the vertical', async () => {
        const user = await createUser({ email: 'host@example.com' });

        const res = await request(app)
            .post('/property')
            .set(authHeader(user))
            .send({
                property_name: 'Test Stay',
                description: 'a place',
                type: 'Entire Home',
                address: 'Toronto, ON',
                estimated_value: 150,
                status: 'active',
                vertical: 'realestate',
            });

        expect(res.status).toBe(201);
        expect(res.body.property_id).toBeTruthy();
        expect(res.body.vertical).toBe('realestate');
        expect(res.body.is_published).toBe(false);
        expect(res.body.is_verified).toBe(false);
    });

    it('publishes real-estate listings that have an address and photo', async () => {
        const user = await createUser({ email: 'agent@example.com' });

        const res = await request(app)
            .post('/property')
            .set(authHeader(user))
            .send({
                property_name: 'Agent listing',
                address: '100 Queen St W, Toronto',
                image: 'https://cdn.example.com/listing.jpg',
                vertical: 'realestate',
            });

        expect(res.status).toBe(201);
        expect(res.body.is_published).toBe(true);
        expect(res.body.authenticity?.publish_allowed).toBe(true);
    });

    it('publishes preconstruction listings that have an address and photo', async () => {
        const user = await createUser({ email: 'developer@example.com' });

        const res = await request(app)
            .post('/property')
            .set(authHeader(user))
            .send({
                property_name: 'Sky Tower',
                address: '200 Bay St, Toronto',
                image: 'https://cdn.example.com/precon.jpg',
                vertical: 'preconstruction',
            });

        expect(res.status).toBe(201);
        expect(res.body.vertical).toBe('preconstruction');
        expect(res.body.is_published).toBe(true);
    });

    it('whitelists the vertical — an unknown one is stored as NULL, not rejected', async () => {
        const user = await createUser({ email: 'host2@example.com' });

        const res = await request(app)
            .post('/property')
            .set(authHeader(user))
            .send({ property_name: 'Legacy listing', vertical: 'tempstay' });

        // 'tempstay' is not one of the two known verticals, so it falls back to NULL
        // (legacy rows read as realestate) — the create must still succeed.
        expect(res.status).toBe(201);
        expect(res.body.vertical).toBeNull();
    });
});
