import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { notify } from '../services/notify.js';
import { haversineKm } from '../utils/ride-fare.js';
import { effectivePrice } from '../utils/discount.js';
import { computeCustomerSegments } from '../utils/customer-analytics.js';
import {
    loadOrderForEmail,
    queueShopOrderPlacedEmails,
    queueDigitalDeliveryEmail,
    isDigitalOrder,
    queueShopOrderStatusEmail,
} from '../utils/product-order-email.js';
import { RANGE_DAYS, resolveRangeParam, resolveRange, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { storeAcceptingOrders, hasSufficientStock } from '../utils/shop-availability.js';
import { decrementListingStockForOrder, loadVariationForShopOrder } from '../utils/shop-order-stock.js';
import { emitProductOrderStatusUpdate } from '../utils/shop-order-socket.js';
import { buildProductOrderUpdateData, repricingFields } from '../utils/shop-order-update.js';
import { redeemPromotion, validatePromotionForUser } from '../utils/promotion.js';
import { normalizeReferralCode, settleReferralThenRecruit } from '../utils/referral-settlement.js';
import { creditRecruiterShares } from '../utils/recruiter-share.js';
import { PLATFORM_FEE_PERCENTAGE } from '../utils/tax-config.js';
import { isMarkdownWindowActive } from '../utils/discount-feed.js';
import { dispatchDeliveryOrder, reofferDeliveryOrderAfterDecline } from '../utils/delivery-dispatch.js';
import { resolveDeliveryDriverForUser } from '../utils/driver-identity.js';

const router = express.Router();

/* GET ALL PRODUCT ORDERS — seller-scoped via JWT */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const orders = await prisma.product_order.findMany({
            where: { seller_id: req.user.user_id },
            orderBy: { order_id: 'desc' },
            take,
            include: {
                user_product_order_buyer_idTouser: true,
                product_type: true,
                product_variation: { include: { product_listing: true } },
                checkouts: true
            },
        });
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product orders' });
    }
});

/* GET AVAILABLE PRODUCT ORDERS FOR DELIVERY DRIVERS
   Declared before '/:order_id' so the literal path is not captured by the
   bare param route. */
router.get('/available', authenticateToken, async (req, res) => {
    try {
        const driverRecord = await resolveDeliveryDriverForUser(req.user.user_id);
        if (!driverRecord) return res.status(403).json({ error: 'Not a registered delivery driver' });

        const driverLat = parseFloat(req.query.lat) || driverRecord.current_lat || null;
        const driverLong = parseFloat(req.query.long) || driverRecord.current_long || null;
        const radius = parseFloat(req.query.radius_km) || 15;

        const orders = await prisma.product_order.findMany({
            where: {
                status: 'confirmed',
                ispaid: true,
                driver_id: null,
                delivery_lat: { not: null },
                delivery_lng: { not: null },
            },
            orderBy: { order_id: 'desc' },
            take: 100,
            include: {
                user_product_order_seller_idTouser: {
                    select: {
                        name: true,
                        username: true,
                        storeProfile: true,
                    }
                },
                product_variation: {
                    include: {
                        product_listing: true
                    }
                }
            }
        });

        let filtered = orders;
        if (driverLat !== null && driverLong !== null) {
            filtered = orders.filter(order => {
                const sellerProfile = order.user_product_order_seller_idTouser?.storeProfile;
                const sellerLat = sellerProfile?.lat ?? null;
                const sellerLng = sellerProfile?.lng ?? null;

                if (sellerLat == null || sellerLng == null) return true;

                const dist = haversineKm(driverLat, driverLong, sellerLat, sellerLng);
                return dist !== null && dist <= radius;
            });
        }

        return res.json({ successful: true, count: filtered.length, data: filtered });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch available product orders' });
    }
});

/* GET PRODUCT ORDER BY ID — buyer or seller only */
router.get('/:order_id', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const order = await prisma.product_order.findUnique({
            where: { order_id },
            include: {
                user_product_order_buyer_idTouser: true,
                user_product_order_seller_idTouser: true,
                product_type: true,
                product_variation: { include: { product_listing: true } },
                checkouts: true
            },
        });

        if (!order) return res.status(404).json({ error: 'Product order not found' });

        const uid = req.user.user_id;
        if (order.buyer_id !== uid && order.seller_id !== uid) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json(order);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product order' });
    }
});

/* GET ORDERS BY BUYER — scoped to JWT user */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
    try {
        const buyer_id = req.user.user_id;

        const orders = await prisma.product_order.findMany({
            where: { buyer_id },
            orderBy: { date: 'desc' },
            include: {
                user_product_order_seller_idTouser: true,
                product_type: true,
                product_variation: { include: { product_listing: true } },
            },
        });
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders for buyer' });
    }
});

/* GET ORDERS BY SELLER — scoped to JWT user */
router.get('/seller/:seller_id', authenticateToken, async (req, res) => {
    try {
        const seller_id = req.user.user_id;

        const orders = await prisma.product_order.findMany({
            where: { seller_id },
            orderBy: { date: 'desc' },
            include: {
                user_product_order_buyer_idTouser: true,
                product_type: true,
                product_variation: { include: { product_listing: true } },
            },
        });
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders for seller' });
    }
});

/* CREATE PRODUCT ORDER — buyer_id set from JWT; ispaid always false on creation */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const {
            variation_id,
            qty,
            payment_method, 
            product_type_id, 
            checkout_id, 
            payment_intent_id,
            delivery_lat,
            delivery_lng,
            delivery_address,
            delivery_instructions,
            delivery_fee,
            platform_fee,
            tax,
            promo_code,
            referral_code,
        } = req.body;
        const orderReferralCode = normalizeReferralCode(referral_code);

        // Money-safety: never trust the client-sent `total`. Price the order
        // from the authoritative variation price on the server. Fees are floored
        // at zero so they can only add to the charge, never discount it.
        const quantity = Math.max(1, parseInt(qty, 10) || 1);
        const deliveryFee = Math.max(0, parseFloat(delivery_fee) || 0);
        const platformFee = Math.max(0, parseFloat(platform_fee) || 0);
        const taxAmount = Math.max(0, parseFloat(tax) || 0);

        // A real product order must reference a real product variation. This both prices
        // the order server-side and tells us the authoritative seller. Without it, the old
        // code fell back to a client-sent total + client-sent seller_id — which let any
        // logged-in user mint a "$any" order naming an arbitrary account (even a non-seller)
        // as the recipient, firing it a "new order — prepare and ship" email.
        if (!variation_id) {
            return res.status(400).json({ error: 'variation_id is required' });
        }
        const variation = await loadVariationForShopOrder(variation_id);
        if (!variation) {
            return res.status(404).json({ error: 'Product variation not found' });
        }

        const listing = variation.product_listing;
        const storeProfile = listing?.seller?.storeProfile ?? null;
        if (!storeAcceptingOrders(storeProfile)) {
            return res.status(409).json({ error: 'This store is not accepting orders right now' });
        }
        if (!hasSufficientStock(listing?.availability, quantity)) {
            return res.status(409).json({ error: 'Insufficient stock for this product' });
        }

        // Authoritative seller = the variation's listing owner. NEVER trust a client-sent
        // seller_id (see the order-spoofing gap above).
        const sellerId = variation.product_listing?.seller_id ?? null;
        if (!sellerId) {
            return res.status(409).json({ error: 'This product has no seller' });
        }

        // Charged total is computed server-side from the authoritative variation price
        // (with any active sale window applied) + delivery + tax - validated promo.
        const saleActive = isMarkdownWindowActive(variation);
        const unitPrice = variation.price != null
            ? effectivePrice(variation.price, saleActive ? variation.discount_pct : 0)
            : null;
        if (unitPrice == null) {
            return res.status(409).json({ error: 'This product has no price' });
        }
        const merchandise = unitPrice * quantity;
        let promoDiscount = 0;
        let normalizedPromoCode = null;
        let validatedPromo = null;
        if (promo_code) {
            validatedPromo = await validatePromotionForUser({
                code: promo_code,
                userId: req.user.user_id,
                subtotal: merchandise,
                vertical: 'discounts',
            });
            if (!validatedPromo.ok) {
                return res.status(validatedPromo.status || 400).json({ error: validatedPromo.message });
            }
            promoDiscount = Number(validatedPromo.amount) || 0;
            normalizedPromoCode = validatedPromo.code;
        }
        const authoritativeTotal = Math.max(0, merchandise - promoDiscount) + deliveryFee + taxAmount;

        // Card-paid orders stay unpaid until the platform Stripe webhook confirms
        // the charge (keyed on payment_intent_id); wallet orders settle on creation.
        const isCard = String(payment_method || '').toUpperCase() === 'CARD';
        const order = await prisma.product_order.create({
            data: {
                seller_id: sellerId,
                buyer_id: req.user.user_id,
                variation_id,
                total: authoritativeTotal,
                qty: quantity,
                date: new Date(),
                ispaid: isCard ? false : true,
                payment_method,
                payment_intent_id: payment_intent_id ?? null,
                product_type_id,
                order_time: new Date(),
                checkout_id,
                delivery_lat: delivery_lat ? parseFloat(delivery_lat) : null,
                delivery_lng: delivery_lng ? parseFloat(delivery_lng) : null,
                delivery_address: delivery_address ?? null,
                delivery_instructions: delivery_instructions ?? null,
                delivery_fee: deliveryFee,
                platform_fee: platformFee,
                tax: taxAmount,
                promo_code: normalizedPromoCode,
                promo_discount: promoDiscount,
                referral_code: orderReferralCode,
            },
            include: {
                user_product_order_buyer_idTouser: true,
                user_product_order_seller_idTouser: true,
                product_type: true,
                product_variation: true
            },
        });

        if (validatedPromo?.ok) {
            await redeemPromotion({
                promotionId: validatedPromo.promo.promotion_id,
                userId: req.user.user_id,
                amount: promoDiscount,
                orderId: order.order_id,
                orderRef: `product_order:${order.order_id}`,
            }).catch((err) => console.error('[product-order] promo redeem failed', err));
        }

        // Reconcile a charge the webhook recorded as an orphan before this row existed.
        let paidNow = order.ispaid;
        if (payment_intent_id) {
            const orphan = await prisma.stripe_orphan_payment.findUnique({ where: { payment_intent_id } }).catch(() => null);
            if (orphan && orphan.status === 'unreconciled') {
                await prisma.product_order.update({ where: { order_id: order.order_id }, data: { ispaid: true } });
                await prisma.stripe_orphan_payment.update({ where: { payment_intent_id }, data: { status: 'reconciled' } });
                paidNow = true;
            }
        }

        // Only tell the seller to "prepare and ship" once the order is actually paid.
        // Card orders start unpaid (awaiting the Stripe webhook) and get this email on
        // payment confirmation instead — so an abandoned/unpaid checkout never pings a
        // seller about a sale that never happened.
        if (paidNow) {
            const fullOrder = await loadOrderForEmail(order.order_id);
            if (fullOrder) queueShopOrderPlacedEmails(fullOrder);
            await decrementListingStockForOrder(listing?.listing_id, quantity);
            await settleReferralThenRecruit({
                referralCode: order.referral_code ?? orderReferralCode,
                buyerUserId: order.buyer_id,
                recruitParticipantUserIds: [order.seller_id],
                subtotal: order.platform_fee ? order.platform_fee / PLATFORM_FEE_PERCENTAGE : (order.total || 0),
                platformTake: order.platform_fee || (order.total || 0) * PLATFORM_FEE_PERCENTAGE,
                orderType: 'product',
                orderRef: order.order_id,
                creditRecruiterShares,
            });
        }

        res.status(201).json(order);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create product order' });
    }
});

/* PATCH /product-order/:order_id/confirm — seller confirms order */
router.patch('/:order_id/confirm', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        const order = await prisma.product_order.findUnique({
            where: { order_id },
            include: { product_type: true },
        });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.seller_id !== req.user.user_id)
            return res.status(403).json({ error: 'Forbidden' });
        const updated = await prisma.product_order.update({
            where: { order_id },
            data: isDigitalOrder(order)
                ? { status: 'fulfilled' }
                : { status: 'confirmed' },
            include: {
                user_product_order_buyer_idTouser: {
                    select: { name: true, email: true, language: true },
                },
                user_product_order_seller_idTouser: {
                    include: { storeProfile: true }
                },
                product_type: true,
                product_variation: { include: { product_listing: true } },
            },
        });
        if (isDigitalOrder(updated)) {
            // Digital goods have no physical delivery — email the download/access and stop.
            queueDigitalDeliveryEmail(updated);
        } else {
            const io = req.app.get('io');

            // Dispatch to the single nearest online driver (with offer/timeout/decline
            // handling) rather than broadcasting to every nearby driver and racing first-claim.
            const sellerProfile = updated.user_product_order_seller_idTouser?.storeProfile;
            if (updated.ispaid && updated.delivery_lat && updated.delivery_lng && sellerProfile?.lat && sellerProfile?.lng) {
                dispatchDeliveryOrder(io, 'product_order', updated.order_id).catch((err) =>
                    console.error('[product-order] dispatch failed:', err.message));
            }

            queueShopOrderStatusEmail(updated, 'confirmed');
            emitProductOrderStatusUpdate(io, updated, { status: updated.status });
        }
        res.json({ successful: true, data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to confirm order' });
    }
});

/* PATCH /product-order/:order_id/ship — seller marks order as shipped */
router.patch('/:order_id/ship', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        const { tracking_number } = req.body;
        const order = await prisma.product_order.findUnique({ where: { order_id } });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.seller_id !== req.user.user_id)
            return res.status(403).json({ error: 'Forbidden' });
        const updated = await prisma.product_order.update({
            where: { order_id },
            data: { status: 'shipped', tracking_number: tracking_number ?? null },
            include: {
                user_product_order_buyer_idTouser: {
                    select: { name: true, email: true, language: true },
                },
                product_variation: { include: { product_listing: true } },
            },
        });
        queueShopOrderStatusEmail(updated, 'shipped', {
            tracking_number: updated.tracking_number,
        });
        const io = req.app.get('io');
        emitProductOrderStatusUpdate(io, updated, { status: 'shipped' });
        res.json({ successful: true, data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark order as shipped' });
    }
});

/* PATCH /product-order/:order_id/fulfill — seller marks order as fulfilled/delivered */
router.patch('/:order_id/fulfill', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        const order = await prisma.product_order.findUnique({
            where: { order_id },
            include: { product_type: true },
        });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.seller_id !== req.user.user_id)
            return res.status(403).json({ error: 'Forbidden' });
        const digital = isDigitalOrder(order);
        if (!digital && order.status !== 'shipped')
            return res.status(400).json({ error: 'Order must be shipped before fulfillment' });
        if (digital && !['confirmed', 'shipped'].includes(order.status || ''))
            return res.status(400).json({ error: 'Digital order must be confirmed before delivery' });
        const updated = await prisma.product_order.update({
            where: { order_id },
            data: { status: 'fulfilled' },
            include: {
                user_product_order_buyer_idTouser: {
                    select: { name: true, email: true, language: true },
                },
                product_type: true,
                product_variation: { include: { product_listing: true } },
            },
        });
        if (digital) {
            queueDigitalDeliveryEmail(updated);
        } else {
            queueShopOrderStatusEmail(updated, 'fulfilled');
        }
        const io = req.app.get('io');
        emitProductOrderStatusUpdate(io, updated, { status: 'fulfilled' });
        res.json({ successful: true, data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fulfill order' });
    }
});

/* UPDATE PRODUCT ORDER — buyer or seller only; ispaid/buyer_id/seller_id not updatable */
router.put('/:order_id', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const existing = await prisma.product_order.findUnique({ where: { order_id } });
        if (!existing) return res.status(404).json({ error: 'Product order not found' });

        const uid = req.user.user_id;
        if (existing.buyer_id !== uid && existing.seller_id !== uid) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // The order total is priced at creation and never recomputed here, so changing what was
        // bought would leave the buyer holding more (or dearer) goods than they paid for.
        const repricing = repricingFields(existing, req.body);
        if (repricing.length > 0) {
            return res.status(400).json({
                error: `Cannot change ${repricing.join(', ')} on an existing order — the total is priced at checkout and is not recalculated. Cancel this order and place a new one.`,
            });
        }

        const updated = await prisma.product_order.update({
            where: { order_id },
            data: buildProductOrderUpdateData(existing, req.body),
            include: {
                user_product_order_buyer_idTouser: true,
                user_product_order_seller_idTouser: true,
                product_type: true,
                product_variation: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update product order' });
    }
});

/* DELETE PRODUCT ORDER — buyer or seller only */
router.delete('/:order_id', authenticateToken, async (req, res) => {
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const existing = await prisma.product_order.findUnique({ where: { order_id } });
        if (!existing) return res.status(404).json({ error: 'Product order not found' });

        const uid = req.user.user_id;
        if (existing.buyer_id !== uid && existing.seller_id !== uid) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await prisma.product_order.delete({ where: { order_id } });
        res.json({ message: 'Product order deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete product order' });
    }
});

/* Resolve the delivery-capable driver_profile row for the authenticated user, or null. */
async function getRequestingDriver(req) {
    return resolveDeliveryDriverForUser(req.user.user_id);
}

/* PATCH /product-order/:order_id/accept — driver accepts order */
router.patch('/:order_id/accept', authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        // Driver identity comes from the JWT, never the request body.
        const driver = await getRequestingDriver(req);
        if (!driver) return res.status(403).json({ error: 'Not a registered delivery driver' });

        // Dispatch assigns driver_id to the offered candidate (not null) as soon as an order
        // is confirmed, so accepting means matching *your own* live offer, not claiming a bare row.
        const claim = await prisma.product_order.updateMany({
            where: { order_id, driver_id: driver.driver_id, status: 'confirmed', offer_expires_at: { gt: new Date() } },
            data: { status: 'driver_assigned', offer_expires_at: null },
        });
        if (claim.count === 0) {
            const exists = await prisma.product_order.findUnique({ where: { order_id }, select: { order_id: true } });
            if (!exists) return res.status(404).json({ error: 'Order not found' });
            return res.status(409).json({ error: 'This offer is no longer available' });
        }

        const updated = await prisma.product_order.findUnique({
            where: { order_id },
            include: {
                user_product_order_buyer_idTouser: true,
                user_product_order_seller_idTouser: true,
            }
        });

        emitProductOrderStatusUpdate(io, updated, { status: 'driver_assigned', driver_id: driver.driver_id });
        res.json({ successful: true, message: 'Order accepted for delivery', data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to accept product order for delivery' });
    }
});

/* PATCH /product-order/:order_id/claim-additional — add a same-seller order to the driver's
   current run (order batching, v1). Direct driver-initiated claim, no offer_expires_at window
   (mirrors routes/food-routes.js's claim-additional). Backend support only — no frontend UI
   yet, since product_order has no driver-facing frontend at all today. */
router.patch('/:order_id/claim-additional', authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const driver = await getRequestingDriver(req);
        if (!driver) return res.status(403).json({ error: 'Not a registered delivery driver' });

        const activeOrder = await prisma.product_order.findFirst({
            where: { driver_id: driver.driver_id, status: { notIn: ['fulfilled', 'cancelled'] } },
            orderBy: { order_id: 'asc' },
        });
        if (!activeOrder) {
            return res.status(409).json({ error: 'No active order to add this one to — accept an order first.' });
        }

        let claimedOrderId;
        try {
            claimedOrderId = await prisma.$transaction(async (tx) => {
                let batch_id = activeOrder.batch_id;
                if (!batch_id) {
                    const batch = await tx.delivery_batch.create({ data: { driver_profile_id: driver.driver_id, vertical: 'product' } });
                    batch_id = batch.batch_id;
                    await tx.product_order.update({ where: { order_id: activeOrder.order_id }, data: { batch_id } });
                }

                const claimed = await tx.product_order.updateMany({
                    where: { order_id, status: 'confirmed', driver_id: null, seller_id: activeOrder.seller_id },
                    data: { status: 'driver_assigned', driver_id: driver.driver_id, batch_id, offer_expires_at: null },
                });
                if (claimed.count === 0) throw new Error('ORDER_NOT_CLAIMABLE');
                return order_id;
            });
        } catch (err) {
            if (err.message === 'ORDER_NOT_CLAIMABLE') {
                return res.status(409).json({ error: 'This order is no longer available, or is from a different seller than your current run.' });
            }
            throw err;
        }

        const updated = await prisma.product_order.findUnique({
            where: { order_id: claimedOrderId },
            include: {
                user_product_order_buyer_idTouser: true,
                user_product_order_seller_idTouser: true,
            }
        });

        emitProductOrderStatusUpdate(io, updated, { status: 'driver_assigned', driver_id: driver.driver_id });
        res.json({ successful: true, message: 'Order added to your current run', data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add product order to run' });
    }
});

/* PATCH /product-order/:order_id/decline — driver declines their current offer, moves to next nearest driver */
router.patch('/:order_id/decline', authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const driver = await getRequestingDriver(req);
        if (!driver) return res.status(403).json({ error: 'Not a registered delivery driver' });

        const order = await prisma.product_order.findUnique({ where: { order_id } });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.driver_id !== driver.driver_id) {
            return res.status(409).json({ error: 'This offer is no longer yours to decline' });
        }

        const result = await reofferDeliveryOrderAfterDecline(io, 'product_order', order_id, driver.driver_id);
        res.json({ successful: true, ...result });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to decline product order' });
    }
});

/* PATCH /product-order/:order_id/picked-up — driver marks order as picked up */
router.patch('/:order_id/picked-up', authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const driver = await getRequestingDriver(req);
        if (!driver) return res.status(403).json({ error: 'Not a registered delivery driver' });

        const order = await prisma.product_order.findUnique({ where: { order_id } });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.driver_id !== driver.driver_id)
            return res.status(403).json({ error: 'Not the assigned driver for this order' });

        const updated = await prisma.product_order.update({
            where: { order_id },
            data: { status: 'picked_up' }
        });

        emitProductOrderStatusUpdate(io, updated, { status: 'picked_up' });
        res.json({ successful: true, message: 'Order picked up', data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark order as picked up' });
    }
});

/* PATCH /product-order/:order_id/deliver — driver marks order as delivered */
router.patch('/:order_id/deliver', authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        const order_id = Number(req.params.order_id);
        if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

        const driver = await getRequestingDriver(req);
        if (!driver) return res.status(403).json({ error: 'Not a registered delivery driver' });

        const order = await prisma.product_order.findUnique({ where: { order_id } });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.driver_id !== driver.driver_id)
            return res.status(403).json({ error: 'Not the assigned driver for this order' });

        const updated = await prisma.product_order.update({
            where: { order_id },
            data: {
                status: 'fulfilled', // Match standard product order completion status
                date: new Date() // Set completion/delivery date to today
            }
        });

        emitProductOrderStatusUpdate(io, updated, { status: 'fulfilled' });
        res.json({ successful: true, message: 'Order delivered successfully', data: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to deliver order' });
    }
});

/**
 * SELLER ANALYTICS OVERVIEW (earnings + orders, range-aware)
 * GET /product-order/seller/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Unified analytics shape: summary (gross/net/count + deltas), per-day timeseries,
 * breakdown (orders by status), top (top products by revenue).
 *
 * Money model: gross = product_order.total (full buyer charge: subtotal + delivery
 * + tax). net = seller take-home = total - platform_fee (Strug's cut) - delivery_fee
 * (courier) - tax (government). Only paid orders are counted. Buckets use order_time
 * (timestamp); `date` is @db.Date (coarser) so order_time is preferred.
 */
router.get('/seller/analytics/overview', authenticateToken, async (req, res, next) => {
    try {
        const seller_id = req.user.user_id;
        const rangeParam = resolveRangeParam(req.query.range);
        const days = RANGE_DAYS[rangeParam];
        const { start, prevStart, prevEnd } = resolveRange(days);

        // Main earnings query selects ONLY scalar columns — no relation join. Inlining the
        // product_variation→product_listing join in a top-level select makes Prisma reference
        // those tables' columns even with 0 rows, which 500s if the catalogue tables are
        // drifted in prod. Product titles are resolved in a separate, guarded query below.
        const baseSelect = { order_id: true, total: true, platform_fee: true, delivery_fee: true, tax: true, qty: true, status: true, order_time: true, variation_id: true };
        const [rows, prevRows] = await Promise.all([
            prisma.product_order.findMany({
                where: { seller_id, ispaid: true, order_time: { gte: start } },
                select: baseSelect,
            }),
            prisma.product_order.findMany({
                where: { seller_id, ispaid: true, order_time: { gte: prevStart, lte: prevEnd } },
                select: { total: true, platform_fee: true, delivery_fee: true, tax: true },
            }),
        ]);

        const grossOf = o => o.total || 0;
        const netOf = o => Math.max(0, (o.total || 0) - (o.platform_fee || 0) - (o.delivery_fee || 0) - (o.tax || 0));
        const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'order_time', gross: grossOf, net: netOf, start, days });

        // breakdown: orders by status
        const statusMap = new Map();
        rows.forEach(o => { const k = o.status || 'unknown'; statusMap.set(k, (statusMap.get(k) || 0) + 1); });
        const breakdown = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

        // top products by gross revenue in range — aggregate by variation, then resolve
        // titles in a separate best-effort query (degrades to "Product" if the catalogue
        // join fails, so a drifted product_listing table can't break the whole endpoint).
        const byProduct = new Map();
        for (const o of rows) {
            const key = o.variation_id ?? `order-${o.order_id}`;
            const e = byProduct.get(key) || { id: key, variation_id: o.variation_id, gross: 0, count: 0 };
            e.gross += o.total || 0;
            e.count += o.qty || 1;
            byProduct.set(key, e);
        }
        const variationIds = [...byProduct.values()].map(e => e.variation_id).filter(v => v != null);
        const titleByVariation = new Map();
        if (variationIds.length) {
            try {
                const variations = await prisma.product_variation.findMany({
                    where: { variation_id: { in: variationIds } },
                    select: { variation_id: true, product_listing: { select: { title: true } } },
                });
                variations.forEach(v => titleByVariation.set(v.variation_id, v.product_listing?.title));
            } catch (e) { /* catalogue drift — leave titles unresolved, fall back to "Product" */ }
        }
        const top = [...byProduct.values()]
            .map(e => ({ id: e.id, title: titleByVariation.get(e.variation_id) || 'Product', subtitle: `${e.count} sold`, gross: round2(e.gross), net: round2(e.gross), count: e.count }))
            .sort((a, b) => b.gross - a.gross)
            .slice(0, 8);

        // #327 customer analytics: segments (new/returning/lapsed/churned/VIP/one-and-done)
        // need the seller's LIFETIME buyers, not just the range. Best-effort scalar query so a
        // failure here can never break the earnings endpoint.
        let customers = null;
        try {
            const lifetime = await prisma.product_order.findMany({
                where: { seller_id, ispaid: true },
                select: { buyer_id: true, total: true, order_time: true },
            });
            customers = computeCustomerSegments(
                lifetime.map(o => ({ customer_id: o.buyer_id, at: o.order_time, amount: o.total })),
            );
        } catch (e) { /* omit customers block on failure */ }

        res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top, customers } });
    } catch (err) { next(err); }
});

export default router;
