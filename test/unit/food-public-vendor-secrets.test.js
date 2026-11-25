import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// GET /food/vendors, /food/vendors/filter, /food/categories and /food/items are all reachable
// without a session, and every one of them serialized the food_vendor row wholesale. That put the
// vendor's Stripe Connect account id in an anonymous response for every onboarded vendor.

const prismaMock = {
	food_category: { findMany: vi.fn(), findUnique: vi.fn() },
	food_item: { findMany: vi.fn(), findUnique: vi.fn() },
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const router = (await import('../../routes/food-routes.js')).default;
const { toPublicVendor, withPublicVendorEmbed } = await import('../../routes/food-routes.js');

const app = express();
app.use(express.json());
app.use('/food', router);

const VENDOR = {
	vendor_id: 5,
	vendor_name: 'Corner Deli',
	owner_id: 77,
	stripe_account_id: 'acct_1PfakeConnectId',
	is_active: true,
};

describe('anonymous food reads do not leak the Stripe Connect account id', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('strips it from GET /food/items', async () => {
		prismaMock.food_item.findMany.mockResolvedValue([
			{ food_item_id: 10, name: 'Reuben', vendor_id: 5, food_vendor: { ...VENDOR } },
		]);
		const res = await request(app).get('/food/items?vendor_id=5');
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain('acct_1PfakeConnectId');
		expect(res.body[0].food_vendor).not.toHaveProperty('stripe_account_id');
		// The storefront maps vendors by owner_id and shows the name, so those have to survive.
		expect(res.body[0].food_vendor.owner_id).toBe(77);
		expect(res.body[0].food_vendor.vendor_name).toBe('Corner Deli');
		expect(res.body[0].name).toBe('Reuben');
	});

	it('strips it from GET /food/items/:id', async () => {
		prismaMock.food_item.findUnique.mockResolvedValue({
			food_item_id: 10, name: 'Reuben', food_vendor: { ...VENDOR },
		});
		const res = await request(app).get('/food/items/10');
		expect(res.status).toBe(200);
		expect(res.body.food_vendor).not.toHaveProperty('stripe_account_id');
	});

	it('strips it from GET /food/categories', async () => {
		prismaMock.food_category.findMany.mockResolvedValue([
			{ food_category_id: 3, name: 'Sandwiches', food_vendor: { ...VENDOR } },
		]);
		const res = await request(app).get('/food/categories?vendor_id=5');
		expect(res.status).toBe(200);
		expect(res.body[0].food_vendor).not.toHaveProperty('stripe_account_id');
	});

	it('strips it from GET /food/categories/:id', async () => {
		prismaMock.food_category.findUnique.mockResolvedValue({
			food_category_id: 3, name: 'Sandwiches', food_vendor: { ...VENDOR },
		});
		const res = await request(app).get('/food/categories/3');
		expect(res.status).toBe(200);
		expect(res.body.food_vendor).not.toHaveProperty('stripe_account_id');
	});
});

// The two vendor list routes spread the row directly rather than through an embed, so pin the
// serializer they share as well.
describe('toPublicVendor', () => {
	it('drops the Connect account id and keeps everything else', () => {
		const out = toPublicVendor(VENDOR);
		expect(out).not.toHaveProperty('stripe_account_id');
		expect(out.vendor_id).toBe(5);
		expect(out.owner_id).toBe(77);
	});

	it('leaves the caller row untouched', () => {
		const row = { ...VENDOR };
		toPublicVendor(row);
		expect(row.stripe_account_id).toBe('acct_1PfakeConnectId');
	});

	it('passes null and rows with no vendor embed straight through', () => {
		const bare = { food_item_id: 9, food_vendor: null };
		expect(toPublicVendor(null)).toBe(null);
		expect(withPublicVendorEmbed(bare)).toBe(bare);
		expect(withPublicVendorEmbed(null)).toBe(null);
	});
});
