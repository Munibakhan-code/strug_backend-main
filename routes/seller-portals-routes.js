import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Which registration table proves a user has "applied as" each seller portal. Several
// portals share one base dashboard (e.g. all food-family portals use food_vendor), so they
// map to the same table. Verticals without a clear registration record are omitted and
// default to "not applied" (greyed in the hub) — clicking still opens the apply gate.
//   model name -> the user-FK column on that model
const TABLE_USER_FIELD = {
	food_vendor: 'owner_id',
	store_profile: 'user_id',
	channel: 'user_id',
	driver_profile: 'user_id',
	appointment_service_providers: 'service_provider_user_id',
};

// nav id -> registration table. Keep nav ids in sync with the BECOME_GROUPS list on the FE.
const PORTAL_TABLE = {
	// Food family
	'sd-food': 'food_vendor', 'sd-groceries': 'food_vendor', 'sd-flowers': 'food_vendor',
	'sd-catering': 'food_vendor', 'sd-mealkit': 'food_vendor', 'sd-restbookings': 'food_vendor',
	// Shop family
	'sd-ecommerce': 'store_profile', 'sd-usedproducts': 'store_profile', 'sd-digproducts': 'store_profile',
	'sd-listdiscounts': 'store_profile', 'sd-authors': 'store_profile',
	// Create & stream
	'sd-creator': 'channel', 'sd-streamer': 'channel',
	// Drive & deliver — both now back onto the unified driver_profile table (previously
	// sd-courier wrongly checked delivery_driver, which was never the courier's real
	// registration record). PORTAL_CAPABILITY_FILTER below is what actually tells them apart.
	'sd-drive': 'driver_profile', 'sd-courier': 'driver_profile',
	// Services (booking engine)
	'sd-services': 'appointment_service_providers', 'sd-proservices': 'appointment_service_providers',
	'sd-automotive': 'appointment_service_providers', 'sd-decor': 'appointment_service_providers',
	'sd-doctors': 'appointment_service_providers', 'sd-wedding': 'appointment_service_providers',
	'sd-instructor': 'appointment_service_providers', 'sd-freelancer': 'appointment_service_providers',
};

// Extra where-clause for nav ids whose registration table is now shared with another portal
// (driver_profile backs both sd-drive and sd-courier; appointment_service_providers backs
// sd-services/sd-proservices/sd-automotive/sd-decor/sd-doctors/sd-wedding/sd-instructor/
// sd-freelancer) — the capability extension row / discriminator column is what actually
// distinguishes them, so a row created for one portal doesn't light up all the others.
const PORTAL_CAPABILITY_FILTER = {
	'sd-drive': { OR: [{ vehicle: { some: {} } }, { license_number: { not: null } }, { active_trip: { some: {} } }] },
	'sd-courier': { driver_courier_profile: { isNot: null } },
	// Only sd-automotive / sd-doctors write appointment_service_providers rows through the app today
	// (tagged with service_type at creation); the other nav ids sharing this table don't have a
	// real apply flow onto it yet, so they stay unfiltered.
	'sd-automotive': { service_type: 'sd-automotive' },
	'sd-doctors': { service_type: 'sd-doctors' },
};

/**
 * GET /seller-portals/me/status
 * Returns { statuses: { "<sd-navId>": boolean } } — true where the user has a registration
 * record for that portal's vertical. Each table is checked once (in its own try/catch so a
 * single drift/mismap can't 500 the whole response), then fanned out to the nav ids.
 */
router.get('/me/status', authenticateToken, async (req, res, next) => {
	try {
		const userId = req.user.user_id;

		// Group nav ids by (model, capability filter) — usually 1:1 with the model, except
		// driver_profile which now backs two portals distinguished only by which capability
		// extension row exists.
		const navKey = (nav) => (PORTAL_CAPABILITY_FILTER[nav] ? `${PORTAL_TABLE[nav]}::${nav}` : PORTAL_TABLE[nav]);
		const queries = {};
		for (const nav of Object.keys(PORTAL_TABLE)) {
			const key = navKey(nav);
			if (!queries[key]) queries[key] = { model: PORTAL_TABLE[nav], filter: PORTAL_CAPABILITY_FILTER[nav] || null };
		}

		const present = {};
		await Promise.all(Object.entries(queries).map(async ([key, { model, filter }]) => {
			const field = TABLE_USER_FIELD[model];
			try {
				const where = { [field]: userId, ...(filter || {}) };
				const row = await prisma[model].findFirst({ where, select: { [field]: true } });
				present[key] = !!row;
			} catch (e) {
				present[key] = false; // unmappable / drifted — degrade to "not applied"
			}
		}));

		const statuses = {};
		for (const nav of Object.keys(PORTAL_TABLE)) statuses[nav] = !!present[navKey(nav)];

		// Décor hosts register via booking_listing (vertical=decor) and/or Decor
		// product_listing — not appointment_service_providers. OR those in so Account
		// earnings + hub status light up for real décor providers.
		try {
			const [decorBooking, decorProduct] = await Promise.all([
				prisma.booking_listing.findFirst({
					where: { owner_id: userId, vertical: 'decor' },
					select: { booking_listing_id: true },
				}),
				prisma.product_listing.findFirst({
					where: {
						seller_id: userId,
						product_type: { product_type_name: { equals: 'Decor', mode: 'insensitive' } },
					},
					select: { listing_id: true },
				}),
			]);
			if (decorBooking || decorProduct) statuses['sd-decor'] = true;
		} catch {
			/* keep table-based status */
		}

		// Wedding sellers likewise list via booking_listing (vertical=wedding) and/or
		// Wedding product_listing — not appointment_service_providers alone.
		try {
			const [weddingBooking, weddingProduct] = await Promise.all([
				prisma.booking_listing.findFirst({
					where: { owner_id: userId, vertical: 'wedding' },
					select: { booking_listing_id: true },
				}),
				prisma.product_listing.findFirst({
					where: {
						seller_id: userId,
						product_type: { product_type_name: { equals: 'Wedding', mode: 'insensitive' } },
					},
					select: { listing_id: true },
				}),
			]);
			if (weddingBooking || weddingProduct) statuses['sd-wedding'] = true;
		} catch {
			/* keep table-based status */
		}

		// Doctors publish supply via booking_listing (vertical=medical) and/or an
		// appointment_service_providers row tagged sd-doctors (Phase 0 medical unify).
		try {
			const medicalBooking = await prisma.booking_listing.findFirst({
				where: { owner_id: userId, vertical: 'medical' },
				select: { booking_listing_id: true },
			});
			if (medicalBooking) statuses['sd-doctors'] = true;
		} catch {
			/* keep table-based status */
		}

		res.json({ successful: true, data: { statuses } });
	} catch (err) { next(err); }
});

export default router;
