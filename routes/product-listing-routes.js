import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isSeller } from '../middleware/seller-check.js';
import { clampDiscountPct } from '../utils/discount.js';
import { SHOP_API_GEO_RADIUS_KM, SHOP_LISTINGS_PUBLIC_CAP } from '../utils/shop-constants.js';
import { buildPublicShopGeoSellerFilter, rankListingsForShopGeo } from '../utils/shop-geo.js';
import {
  isNonProductListingTypeName,
  resolveProductTypeIdForListing,
} from '../utils/shop-vertical-types.js';

const router = express.Router();

/* GET ALL LISTINGS — ?public=true returns all (customer view); otherwise requires auth and filters to caller's listings */
router.get('/', async (req, res) => {
    try {
        const isPublic = req.query.public === 'true';
        const { lat, lng, type } = req.query;
        let where = {};
        let geoUserLat = null;
        let geoUserLng = null;

        if (!isPublic) {
            // Require auth for seller dashboard view
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (!token) return res.status(401).json({ error: 'Authentication required' });

            let decoded;
            try {
                const jwt = (await import('jsonwebtoken')).default;
                decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
            } catch {
                return res.status(403).json({ error: 'Invalid token' });
            }
            where = { seller_id: decoded.user_id };
        } else if (lat && lng) {
            const userLat = parseFloat(lat);
            const userLng = parseFloat(lng);
            if (Number.isFinite(userLat) && Number.isFinite(userLng)) {
                // When buyer coords are present: prefer nearby stores, but KEEP sellers who never
                // set lat/lng (they are ranked last below, not excluded). Inactive stores stay
                // hidden. Bounding box first; exact circle + ranking below.
                geoUserLat = userLat;
                geoUserLng = userLng;
                where.seller = buildPublicShopGeoSellerFilter(userLat, userLng, SHOP_API_GEO_RADIUS_KM);
            }
        }

        // Bug #94: the public storefront must never surface seller-less listings. Orphaned/seed
        // rows (seller_id = null) belong to no account, so they can't be managed or deleted from
        // any "Sell on Strug" dashboard — to a shopper they look like products that "keep coming
        // back" after a real seller deletes their own. Hide them from every customer-facing view.
        if (isPublic) {
            where.seller_id = { not: null };
            // #348: hide explicitly-deactivated stores. When geo filter already set `where.seller`
            // (Phase 7), is_active=true is included there — do not overwrite.
            if (!where.seller) {
                where.seller = {
                    OR: [
                        { storeProfile: { is: null } },
                        { storeProfile: { is_active: true } },
                    ],
                };
            }
        }

        if (type) {
            if (isNonProductListingTypeName(type)) {
                return res.status(400).json({
                    error:
                        `${type} is not a product_listing type filter (Books/Digital Products are dg-content; Discounts is a sale feed)`,
                });
            }
            where.product_type = {
                product_type_name: {
                    equals: type,
                    mode: 'insensitive'
                }
            };
        }

        const listings = await prisma.product_listing.findMany({
            where,
            orderBy: { listing_id: 'desc' },
            // PERF (bug #35): safety cap on the otherwise-unbounded public discovery scan.
            // Generous enough not to truncate results at current scale; a proper geo fix
            // would push the 20km filter into a bounding-box WHERE instead of post-fetch JS.
            take: SHOP_LISTINGS_PUBLIC_CAP,
            include: {
                product_type: true,
                product_variation: true,
                seller: {
                    select: {
                        user_id: true,
                        name: true,
                        username: true,
                        storeProfile: true,
                    }
                },
            },
        });

        let filtered = listings;
        if (isPublic && geoUserLat != null && geoUserLng != null) {
            // Nearby stores first, then sellers who never set coordinates. RANK them, don't drop
            // them: dropping meant a seller who skipped the location field disappeared completely
            // for every located buyer, with a healthy-looking dashboard and nothing in the logs.
            filtered = rankListingsForShopGeo(listings, geoUserLat, geoUserLng, SHOP_API_GEO_RADIUS_KM);
        }

        res.json(filtered);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product listings' });
    }
});

/* GET LISTING BY ID */
router.get('/:listing_id', async (req, res) => {
    try {
        const listing_id = Number(req.params.listing_id);
        if (Number.isNaN(listing_id)) return res.status(400).json({ error: 'listing_id must be a number' });

        const listing = await prisma.product_listing.findUnique({
            where: { listing_id },
            include: {
                product_type: true,
                product_variation: true,
                seller: { select: { user_id: true, name: true, username: true } },
            },
        });

        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        res.json(listing);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product listing' });
    }
});

/* CREATE LISTING */
router.post('/', authenticateToken, isSeller, async (req, res) => {
    try {
        const { name, description, image_url, availability, product_type_id, product_type_name, price, stock, discount_pct, vname, category } = req.body;
        const saleDiscount = clampDiscountPct(discount_pct) || null;
        // Browse subcategory for typed verticals (Decor/Wedding/…) — stored on variation.vname
        // so product_type_name can stay the vertical lock (e.g. "Decor").
        const browseCategory = (typeof (vname ?? category) === 'string' && String(vname ?? category).trim())
            ? String(vname ?? category).trim()
            : null;

        const typeResolved = await resolveProductTypeIdForListing(prisma, {
            product_type_id,
            product_type_name,
        });
        if (typeResolved.error) {
            return res.status(typeResolved.status).json({ error: typeResolved.error });
        }
        const resolvedTypeId = typeResolved.product_type_id;

        const listing = await prisma.product_listing.create({
            data: {
                name,
                description,
                image_url: image_url ?? null,
                availability: availability ?? (stock != null ? parseInt(stock) : null),
                product_type_id: resolvedTypeId,
                seller_id: req.user.user_id,
            },
            include: {
                product_type: true,
                product_variation: true,
                seller: { select: { user_id: true, name: true, username: true } },
            },
        });

        // Auto-create a default variation with the price if provided
        if (price != null && !isNaN(parseFloat(price))) {
            await prisma.product_variation.create({
                data: {
                    listing_id: listing.listing_id,
                    price: parseFloat(price),
                    discount_pct: saleDiscount,
                    description: 'Default',
                    ...(browseCategory ? { vname: browseCategory } : {}),
                },
            });
        }

        const full = await prisma.product_listing.findUnique({
            where: { listing_id: listing.listing_id },
            include: {
                product_type: true,
                product_variation: true,
                seller: { select: { user_id: true, name: true, username: true } },
            },
        });

        res.status(201).json(full);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create product listing' });
    }
});

/* UPDATE LISTING */
router.put('/:listing_id', authenticateToken, isSeller, async (req, res) => {
    try {
        const listing_id = Number(req.params.listing_id);
        if (Number.isNaN(listing_id)) return res.status(400).json({ error: 'listing_id must be a number' });

        const { name, description, image_url, availability, product_type_id, product_type_name, price, stock, discount_pct, discount_starts_at, discount_ends_at, vname, category } = req.body;
        const browseCategory = (vname !== undefined || category !== undefined)
            ? (typeof (vname ?? category) === 'string' ? String(vname ?? category).trim() || null : null)
            : undefined;

        const existing = await prisma.product_listing.findUnique({ where: { listing_id } });
        if (!existing) return res.status(404).json({ error: 'Listing not found' });
        if (existing.seller_id !== req.user.user_id) return res.status(403).json({ error: 'Not your listing' });

        let resolvedTypeId = product_type_id ? parseInt(product_type_id) : existing.product_type_id;
        if (product_type_name) {
            const typeResolved = await resolveProductTypeIdForListing(prisma, {
                product_type_name,
            });
            if (typeResolved.error) {
                return res.status(typeResolved.status).json({ error: typeResolved.error });
            }
            resolvedTypeId = typeResolved.product_type_id ?? existing.product_type_id;
        }

        await prisma.product_listing.update({
            where: { listing_id },
            data: {
                name: name ?? existing.name,
                description: description ?? existing.description,
                image_url: image_url !== undefined ? image_url : existing.image_url,
                availability: availability ?? (stock != null ? parseInt(stock) : existing.availability),
                product_type_id: resolvedTypeId,
            },
        });

        // Update the default variation's price and/or sale discount if provided.
        // discount_pct is handled independently of price so a seller can put an item
        // on sale (or clear the sale) without re-entering the price.
        const hasPrice = price != null && !isNaN(parseFloat(price));
        const hasDiscount = discount_pct !== undefined;
        const hasBrowseCat = browseCategory !== undefined;
        const hasWindow = discount_starts_at !== undefined || discount_ends_at !== undefined;
        if (hasPrice || hasDiscount || hasBrowseCat || hasWindow) {
            const variationData = {};
            if (hasPrice) variationData.price = parseFloat(price);
            if (hasDiscount) variationData.discount_pct = clampDiscountPct(discount_pct) || null;
            if (hasBrowseCat) variationData.vname = browseCategory;
            if (discount_starts_at !== undefined) {
                variationData.discount_starts_at = discount_starts_at
                    ? new Date(discount_starts_at)
                    : null;
            }
            if (discount_ends_at !== undefined) {
                variationData.discount_ends_at = discount_ends_at
                    ? new Date(discount_ends_at)
                    : null;
            }
            const variation = await prisma.product_variation.findFirst({ where: { listing_id } });
            if (variation) {
                await prisma.product_variation.update({
                    where: { variation_id: variation.variation_id },
                    data: variationData,
                });
            } else {
                await prisma.product_variation.create({
                    data: { listing_id, description: 'Default', ...variationData },
                });
            }
        }

        const full = await prisma.product_listing.findUnique({
            where: { listing_id },
            include: {
                product_type: true,
                product_variation: true,
                seller: { select: { user_id: true, name: true, username: true } },
            },
        });

        res.json(full);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update product listing' });
    }
});

/* DELETE LISTING */
router.delete('/:listing_id', authenticateToken, isSeller, async (req, res) => {
    try {
        const listing_id = Number(req.params.listing_id);
        if (Number.isNaN(listing_id)) return res.status(400).json({ error: 'listing_id must be a number' });

        const existing = await prisma.product_listing.findUnique({ where: { listing_id } });
        if (!existing) return res.status(404).json({ error: 'Listing not found' });
        if (existing.seller_id !== req.user.user_id) return res.status(403).json({ error: 'Not your listing' });

        // Get variation IDs for cascade cleanup
        const variations = await prisma.product_variation.findMany({
            where: { listing_id },
            select: { variation_id: true },
        });
        const variationIds = variations.map(v => v.variation_id);

        await prisma.$transaction([
            // Remove from carts
            prisma.product_cart.deleteMany({ where: { variation_id: { in: variationIds } } }),
            // Null out variation reference on historical orders (preserve order records)
            prisma.product_order.updateMany({ where: { variation_id: { in: variationIds } }, data: { variation_id: null } }),
            // Delete variations
            prisma.product_variation.deleteMany({ where: { listing_id } }),
            // Delete listing
            prisma.product_listing.delete({ where: { listing_id } }),
        ]);
        res.json({ message: 'Listing deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete product listing' });
    }
});

export default router;
