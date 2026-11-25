import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { applyVerticalIdentity, verticalIdentityUserSelect } from '../utils/vertical-identity.js';
import { selectBestAd } from '../utils/ads-delivery-engine.js';
import { calculateHaversineDistance } from '../utils/ad-context-harvester.js';


const router = express.Router();

// A host shown on a listing displays their `hosting` vertical identity.
// Public listing embeds expose only display identity fields, then apply hosting identity.
const hostUserSelect = { select: verticalIdentityUserSelect };

/* GET ALL RENTAL LISTINGS — ?public=true returns all (customer view); otherwise requires auth and filters to caller's listings */
router.get('/', async (req, res) => {
    try {
        const isPublic = req.query.public === 'true';
        let where = {};

        if (!isPublic) {
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
            where = { owner_id: decoded.user_id };
        }

        const [listings, activeAd] = await Promise.all([
            prisma.rental_listing.findMany({
                where,
                orderBy: { rental_listing_id: 'desc' },
                include: {
                    user: hostUserSelect,
                    rental_categories: true,
                    rental_type: true,
                    rental_listing_pics: true
                },
            }),
            isPublic ? selectBestAd(req.adContext).catch(() => null) : Promise.resolve(null)
        ]);

        listings.forEach((l) => applyVerticalIdentity(l.user, 'hosting'));

        let filtered = listings;

        if (activeAd) {
            const adRental = await prisma.rental_listing.findFirst({
                where: { owner_id: activeAd.advertiser_id, is_available: true },
                include: {
                    rental_categories: true,
                    rental_type: true,
                    rental_listing_pics: true
                }
            });

            if (adRental) {
                let distance = null;
                if (req.adContext?.latitude && req.adContext?.longitude && adRental.location) {
                    const parts = adRental.location.split(',');
                    const rLat = parseFloat(parts[0]);
                    const rLng = parseFloat(parts[1]);
                    if (!isNaN(rLat) && !isNaN(rLng)) {
                        distance = calculateHaversineDistance(req.adContext.latitude, req.adContext.longitude, rLat, rLng);
                    }
                }

                const promotedCard = {
                    ...adRental,
                    rental_listing_id: adRental.rental_listing_id,
                    rental_listing_name: activeAd.headline || adRental.rental_listing_name,
                    description: activeAd.description || adRental.description,
                    amount: activeAd.bid_amount,
                    is_ad: true,
                    campaign_id: activeAd.campaign_id,
                    target_url: activeAd.target_url,
                    cta_text: activeAd.cta_text || "BOOK_NOW",
                    distance_km: distance,
                    sponsored: true,
                    custom_map_pin: {
                        color: "#ef4444",
                        glow: true
                    },
                    is_generic_ad: false
                };

                filtered.unshift(promotedCard);
            } else {
                const genericAdCard = {
                    rental_listing_id: `ad_${activeAd.campaign_id}`,
                    rental_category_id: null,
                    rental_listing_name: activeAd.headline || activeAd.title,
                    owner_id: activeAd.advertiser_id,
                    description: activeAd.description,
                    amount: activeAd.bid_amount,
                    duration: null,
                    is_available: true,
                    instant_booking: true,
                    location: null,
                    rental_type_id: null,
                    is_ad: true,
                    campaign_id: activeAd.campaign_id,
                    target_url: activeAd.target_url,
                    cta_text: activeAd.cta_text || "LEARN_MORE",
                    sponsored: true,
                    custom_map_pin: {
                        color: "#ef4444",
                        glow: true
                    },
                    is_generic_ad: true,
                    rental_categories: null,
                    rental_type: null,
                    rental_listing_pics: [
                        {
                            rental_pics_id: `pic_${activeAd.campaign_id}`,
                            rental_listing_id: null,
                            url: activeAd.media_url,
                            rental_type_id: null
                        }
                    ]
                };

                filtered.unshift(genericAdCard);
            }
        }

        res.json(filtered);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental listings' });
    }
});

/* GET RENTAL LISTING BY ID */
router.get('/:rental_listing_id', async (req, res) => {
    try {
        const rental_listing_id = Number(req.params.rental_listing_id);
        if (Number.isNaN(rental_listing_id)) return res.status(400).json({ error: 'rental_listing_id must be a number' });

        const listing = await prisma.rental_listing.findUnique({
            where: { rental_listing_id },
            include: {
                user: hostUserSelect,
                rental_categories: true,
                rental_type: true,
                rental_listing_pics: true
            },
        });

        if (!listing) return res.status(404).json({ error: 'Rental listing not found' });
        applyVerticalIdentity(listing.user, 'hosting');
        res.json(listing);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental listing' });
    }
});

/* CREATE RENTAL LISTING */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { rental_category_id, rental_listing_name, description, amount, duration, is_available, location, rental_type_id, instant_booking } = req.body;

        const listing = await prisma.rental_listing.create({
            data: {
                rental_category_id,
                rental_listing_name,
                owner_id: req.user.user_id, // H2: set from JWT, never body
                description,
                amount,
                duration,
                is_available,
                location,
                rental_type_id,
                instant_booking: instant_booking ?? false,
            },
            include: {
                user: true,
                rental_categories: true,
                rental_type: true,
            },
        });

        res.status(201).json(listing);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create rental listing' });
    }
});

/* UPDATE RENTAL LISTING */
router.put('/:rental_listing_id', authenticateToken, async (req, res) => {
    try {
        const rental_listing_id = Number(req.params.rental_listing_id);
        if (Number.isNaN(rental_listing_id)) return res.status(400).json({ error: 'rental_listing_id must be a number' });

        const { rental_category_id, rental_listing_name, description, amount, duration, is_available, location, rental_type_id, instant_booking } = req.body;

        const existing = await prisma.rental_listing.findUnique({ where: { rental_listing_id } });
        if (!existing) return res.status(404).json({ error: 'Rental listing not found' });

        // H3: ownership check
        if (existing.owner_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updated = await prisma.rental_listing.update({
            where: { rental_listing_id },
            data: {
                rental_category_id: rental_category_id ?? existing.rental_category_id,
                rental_listing_name: rental_listing_name ?? existing.rental_listing_name,
                description: description ?? existing.description,
                amount: amount ?? existing.amount,
                duration: duration ?? existing.duration,
                is_available: is_available ?? existing.is_available,
                location: location ?? existing.location,
                rental_type_id: rental_type_id ?? existing.rental_type_id,
                instant_booking: instant_booking ?? existing.instant_booking,
            },
            include: {
                user: true,
                rental_categories: true,
                rental_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update rental listing' });
    }
});

/* DELETE RENTAL LISTING */
router.delete('/:rental_listing_id', authenticateToken, async (req, res) => {
    try {
        const rental_listing_id = Number(req.params.rental_listing_id);
        if (Number.isNaN(rental_listing_id)) return res.status(400).json({ error: 'rental_listing_id must be a number' });

        const existing = await prisma.rental_listing.findUnique({ where: { rental_listing_id } });
        if (!existing) return res.status(404).json({ error: 'Rental listing not found' });

        // H3: ownership check
        if (existing.owner_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await prisma.rental_listing.delete({ where: { rental_listing_id } });
        res.json({ message: 'Rental listing deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete rental listing' });
    }
});

export default router;
