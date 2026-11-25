import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';
import { selectBestAd } from '../utils/ads-delivery-engine.js';



const router = express.Router();

/* GET ALL PLACES */
router.get('/', async (req, res) => {
    try {
        const [places, activeAd] = await Promise.all([
            prisma.place.findMany({
                orderBy: { place_id: 'desc' },
                include: {
                    user: true,
                    event_type: true,
                    place_pics: true
                },
            }),
            selectBestAd(req.adContext).catch(() => null)
        ]);

        let filtered = places;

        if (activeAd) {
            const adPlace = await prisma.place.findFirst({
                where: { user_id: activeAd.advertiser_id },
                include: {
                    event_type: true,
                    place_pics: true
                }
            });

            if (adPlace) {
                const promotedVenueCard = {
                    ...adPlace,
                    place_id: adPlace.place_id,
                    description: activeAd.description || adPlace.description,
                    price_per_hour: activeAd.bid_amount,
                    is_ad: true,
                    campaign_id: activeAd.campaign_id,
                    target_url: activeAd.target_url,
                    cta_text: activeAd.cta_text || "BOOK_NOW",
                    instant_booking: true,
                    sponsored: true,
                    custom_map_pin: {
                        color: "#ef4444",
                        glow: true
                    },
                    is_generic_ad: false
                };

                filtered.unshift(promotedVenueCard);
            } else {
                const genericAdCard = {
                    place_id: `ad_${activeAd.campaign_id}`,
                    user_id: activeAd.advertiser_id,
                    location_lat: null,
                    location_long: null,
                    location_address: null,
                    location_place_id: null,
                    price_per_hour: activeAd.bid_amount,
                    description: activeAd.description,
                    event_type_id: null,
                    instant_booking: true,
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
                    event_type: null,
                    place_pics: [
                        {
                            place_pics_id: `pic_${activeAd.campaign_id}`,
                            place_id: null,
                            place_pic_url: activeAd.media_url,
                            event_type_id: null
                        }
                    ]
                };

                filtered.unshift(genericAdCard);
            }
        }

        res.json(filtered);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch places' });
    }
});

/* GET PLACE BY ID */
router.get('/:place_id', async (req, res) => {
    try {
        const place_id = Number(req.params.place_id);
        if (Number.isNaN(place_id)) return res.status(400).json({ error: 'place_id must be a number' });

        const place = await prisma.place.findUnique({
            where: { place_id },
            include: {
                user: true,
                event_type: true,
                place_pics: true
            },
        });

        if (!place) return res.status(404).json({ error: 'Place not found' });
        res.json(place);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch place' });
    }
});

/* GET PLACES BY USER ID */
router.get('/user/:user_id', async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const places = await prisma.place.findMany({
            where: { user_id },
            include: {
                event_type: true,
                place_pics: true
            },
        });
        res.json(places);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch user places' });
    }
});

/* CREATE PLACE */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { user_id, location_lat, location_long, location_address, location_place_id, price_per_hour, description, event_type_id, instant_booking } = req.body;

        const place = await prisma.place.create({
            data: {
                user_id,
                location_lat,
                location_long,
                location_address,
                location_place_id,
                price_per_hour,
                description,
                event_type_id,
                instant_booking: instant_booking === true || instant_booking === 'true',
            },
            include: {
                user: true,
                event_type: true
            },
        });

        res.status(201).json(place);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create place' });
    }
});

/* UPDATE PLACE */
router.put('/:place_id', authenticateToken, async (req, res) => {
    try {
        const place_id = Number(req.params.place_id);
        if (Number.isNaN(place_id)) return res.status(400).json({ error: 'place_id must be a number' });

        const { user_id, location_lat, location_long, location_address, location_place_id, price_per_hour, description, event_type_id, instant_booking } = req.body;

        const existing = await prisma.place.findUnique({ where: { place_id } });
        if (!existing) return res.status(404).json({ error: 'Place not found' });

        const updated = await prisma.place.update({
            where: { place_id },
            data: {
                user_id: user_id ?? existing.user_id,
                location_lat: location_lat ?? existing.location_lat,
                location_long: location_long ?? existing.location_long,
                location_address: location_address ?? existing.location_address,
                location_place_id: location_place_id ?? existing.location_place_id,
                price_per_hour: price_per_hour ?? existing.price_per_hour,
                description: description ?? existing.description,
                event_type_id: event_type_id ?? existing.event_type_id,
                ...(instant_booking !== undefined && { instant_booking: instant_booking === true || instant_booking === 'true' }),
            },
            include: {
                user: true,
                event_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update place' });
    }
});

/* DELETE PLACE */
router.delete('/:place_id', authenticateToken, async (req, res) => {
    try {
        const place_id = Number(req.params.place_id);
        if (Number.isNaN(place_id)) return res.status(400).json({ error: 'place_id must be a number' });

        await prisma.place.delete({ where: { place_id } });
        res.json({ message: 'Place deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete place' });
    }
});

export default router;
