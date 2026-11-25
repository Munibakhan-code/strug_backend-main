import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import Stripe from 'stripe';
import { normalizeReferralCode } from '../utils/referral-settlement.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const router = express.Router();

const publicUserSelect = {
    user_id: true,
    username: true,
    name: true,
    social_profiles: {
        select: {
            profile_pic_url: true,
            display_name: true,
        },
    },
};

// How long funds sit as PENDING in the freelancer's wallet before they
// become AVAILABLE for withdrawal. Adjust to match your business rule.
const WALLET_CLEARANCE_DAYS = 7;

/**
 * Create a freelancer order with Stripe payment intent
 * POST /freelance-orders
 * Body: { gig_id, package_type, requirements, requirement_files, payment_method }
 */
router.post('/', authenticateToken, async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ successful: false, message: 'Stripe not configured' });
        }
        const { 
            gig_id, 
            package_type, 
            requirements, 
            requirement_files,
            payment_method = 'card',
            referral_code,
        } = req.body;
        const orderReferralCode = normalizeReferralCode(referral_code);

        const gigId = parseInt(gig_id);
        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Valid gig_id is required.',
            });
        }

        const validPackageTypes = ['BASIC', 'STANDARD', 'PREMIUM'];
        if (!package_type || !validPackageTypes.includes(package_type)) {
            return res.status(400).json({
                successful: false,
                message: `package_type is required and must be one of: ${validPackageTypes.join(', ')}`,
            });
        }

        // Load the gig and confirm it's actually orderable
        const gig = await prisma.gig.findUnique({
            where: { id: gigId },
        });

        if (!gig || gig.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Gig not found.',
            });
        }

        if (gig.status !== 'ACTIVE') {
            return res.status(400).json({
                successful: false,
                message: 'This gig is not currently accepting orders.',
            });
        }

        // Prevent a freelancer from ordering their own gig
        const ownFreelancerProfile = await prisma.freelancerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });
        if (ownFreelancerProfile && ownFreelancerProfile.id === gig.freelancer_profile_id) {
            return res.status(400).json({
                successful: false,
                message: 'You cannot order your own gig.',
            });
        }

        // gig.packages is stored as Json — pull the price for the requested tier
        const packages = Array.isArray(gig.packages) ? gig.packages : [];
        const selectedPackage = packages.find(pkg => pkg.package_type === package_type);

        if (!selectedPackage) {
            return res.status(400).json({
                successful: false,
                message: `This gig does not offer a ${package_type} package.`,
            });
        }

        if (requirement_files && !Array.isArray(requirement_files)) {
            return res.status(400).json({
                successful: false,
                message: 'requirement_files must be an array.',
            });
        }

        // First order creates the buyer profile; later orders reuse it.
        const buyerProfile = await prisma.buyerProfile.upsert({
            where: { user_id: req.user.user_id },
            update: {},
            create: { user_id: req.user.user_id },
        });
        
        console.log(`Buyer profile ID: ${buyerProfile.id} for user ${req.user.user_id}`);

        const priceInCents = Math.round(selectedPackage.price * 100);

        // Create Stripe Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: priceInCents,
            currency: 'usd',
            payment_method_types: ['card'],
            metadata: {
                gig_id: gig.id,
                gig_title: gig.title,
                buyer_id: req.user.user_id,
                package_type: package_type,
            },
            receipt_email: req.user.email,
            description: `Gig: ${gig.title} - ${package_type} package`,
        });

        console.log(`Created Stripe Payment Intent: ${paymentIntent.id} for order of gig ${gig.id}`);
        // Create the freelancer order in PENDING status with Stripe payment intent ID
        const freelancerOrder = await prisma.freelancerOrder.create({
            data: {
                buyer_profile_id: buyerProfile.id,
                freelancer_profile_id: gig.freelancer_profile_id,
                gig_id: gig.id,
                package_type,
                price: selectedPackage.price,
                requirements: requirements?.trim() || null,
                requirement_files: requirement_files || null,
                status: 'PENDING',
                stripe_payment_intent_id: paymentIntent.id,
                payment_status: 'PENDING',
                referral_code: orderReferralCode,
            },
        });
        console.log(`Created freelancer order ID: ${freelancerOrder.id} for gig ${gig.id}`);
        return res.status(201).json({
            successful: true,
            message: 'Order created successfully. Payment required to confirm order.',
            data: {
                order: freelancerOrder,
                client_secret: paymentIntent.client_secret,
            },
        });
    } catch (error) {
        console.error('Create Order Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create order.',
        });
    }
});

/**
 * Get my orders (as buyer)
 * GET /freelance-orders/my-orders
 */
router.get('/my-orders', authenticateToken, async (req, res) => {
    try {
        const buyerProfile = await prisma.buyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.json({ successful: true, data: [] });
        }

        const orders = await prisma.freelancerOrder.findMany({
            where: { buyer_profile_id: buyerProfile.id },
            include: {
                gig: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                        status: true,
                    },
                },
                freelancer_profile: {
                    select: {
                        id: true,
                        display_name: true,
                        user: { select: publicUserSelect },
                    },
                },
                review: true,
            },
            orderBy: { created_at: 'desc' },
        });

        return res.json({ successful: true, data: orders });
    } catch (error) {
        console.error('Get My Orders Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your orders.',
        });
    }
});

/**
 * Get orders received (as freelancer)
 * GET /freelance-orders/received-orders
 */
router.get('/received-orders', authenticateToken, async (req, res) => {
    try {
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        const orders = await prisma.freelancerOrder.findMany({
            where: { freelancer_profile_id: freelancerProfile.id },
            include: {
                gig: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                        status: true,
                    },
                },
                buyer_profile: {
                    select: {
                        id: true,
                        user: { select: publicUserSelect },
                    },
                },
                review: true,
            },
            orderBy: { created_at: 'desc' },
        });

        return res.json({ successful: true, data: orders });
    } catch (error) {
        console.error('Get Received Orders Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch received orders.',
        });
    }
});

/**
 * Get single freelancer order by ID
 * GET /freelance-orders/:id
 * Accessible by either the buyer or the freelancer on the order.
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        if (isNaN(orderId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid order ID.',
            });
        }

        const freelancerOrder = await prisma.freelancerOrder.findUnique({
            where: { id: orderId },
            include: {
                gig: true,
                buyer_profile: {
                    select: {
                        id: true,
                        user: { select: publicUserSelect },
                    },
                },
                freelancer_profile: {
                    select: {
                        id: true,
                        display_name: true,
                        user: { select: publicUserSelect },
                    },
                },
                review: true,
                wallet_transactions: true,
            },
        });

        if (!freelancerOrder) {
            return res.status(404).json({
                successful: false,
                message: 'Order not found.',
            });
        }

        // Authorization: caller must be the buyer or the freelancer on this order
        const [buyerProfile, freelancerProfile] = await Promise.all([
            prisma.buyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.freelancerProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const isBuyer = buyerProfile && buyerProfile.id === freelancerOrder.buyer_profile_id;
        const isFreelancer = freelancerProfile && freelancerProfile.id === freelancerOrder.freelancer_profile_id;

        if (!isBuyer && !isFreelancer) {
            return res.status(403).json({
                successful: false,
                message: 'You do not have permission to view this order.',
            });
        }

        return res.json({ successful: true, data: freelancerOrder });
    } catch (error) {
        console.error('Get Order Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch order.',
        });
    }
});

/**
 * Freelancer updates order progress
 * PATCH /freelance-orders/:id/status
 * Body: { status: 'IN_PROGRESS' | 'DELIVERED' }
 */
router.patch('/:id/status', authenticateToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { status } = req.body;

        if (isNaN(orderId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid order ID.',
            });
        }

        const allowedStatuses = ['IN_PROGRESS', 'DELIVERED'];
        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `status is required and must be one of: ${allowedStatuses.join(', ')}`,
            });
        }

        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        const existingOrder = await prisma.freelancerOrder.findFirst({
            where: { id: orderId, freelancer_profile_id: freelancerProfile.id },
        });

        if (!existingOrder) {
            return res.status(404).json({
                successful: false,
                message: 'Order not found or you do not have permission to update it.',
            });
        }

        // Simple forward-only transition guard
        const transitions = {
            PENDING: ['IN_PROGRESS'],
            IN_PROGRESS: ['DELIVERED'],
        };
        const allowedNext = transitions[existingOrder.status] || [];
        if (!allowedNext.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `Cannot move order from ${existingOrder.status} to ${status}.`,
            });
        }

        const updatedOrder = await prisma.freelancerOrder.update({
            where: { id: orderId },
            data: { status },
        });

        return res.json({
            successful: true,
            message: `Order status updated to ${status}.`,
            data: updatedOrder,
        });
    } catch (error) {
        console.error('Update Order Status Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update order status.',
        });
    }
});

/**
 * Buyer marks a delivered order as completed.
 * Credits the freelancer's wallet (pending balance) for the order amount.
 * PATCH /freelance-orders/:id/complete
 */
router.patch('/:id/complete', authenticateToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        if (isNaN(orderId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid order ID.',
            });
        }

        const buyerProfile = await prisma.buyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const existingOrder = await prisma.freelancerOrder.findFirst({
            where: { id: orderId, buyer_profile_id: buyerProfile.id },
        });

        if (!existingOrder) {
            return res.status(404).json({
                successful: false,
                message: 'Order not found or you do not have permission to complete it.',
            });
        }

        if (existingOrder.status !== 'DELIVERED') {
            return res.status(400).json({
                successful: false,
                message: 'Only delivered orders can be marked as completed.',
            });
        }

        const availableAt = new Date();
        availableAt.setDate(availableAt.getDate() + WALLET_CLEARANCE_DAYS);

        // Update the order and credit the wallet atomically
        const [updatedOrder] = await prisma.$transaction(async (tx) => {
            const updated = await tx.freelancerOrder.update({
                where: { id: orderId },
                data: {
                    status: 'COMPLETED',
                    is_completed: true,
                    completed_at: new Date(),
                },
            });

            const wallet = await tx.freelancerWallet.upsert({
                where: { freelancer_profile_id: existingOrder.freelancer_profile_id },
                update: {},
                create: { freelancer_profile_id: existingOrder.freelancer_profile_id },
            });

            await tx.freelanceWalletTransaction.create({
                data: {
                    wallet_id: wallet.id,
                    order_id: existingOrder.id,
                    buyer_profile_id: existingOrder.buyer_profile_id,
                    freelancer_profile_id: existingOrder.freelancer_profile_id,
                    amount: existingOrder.price,
                    type: 'ORDER',
                    status: 'PENDING',
                    available_at: availableAt,
                },
            });

            await tx.freelancerWallet.update({
                where: { id: wallet.id },
                data: {
                    pending_balance: { increment: existingOrder.price },
                    total_earned: { increment: existingOrder.price },
                },
            });

            return [updated];
        });

        return res.json({
            successful: true,
            message: 'Order marked as completed. Funds are pending clearance in the freelancer wallet.',
            data: updatedOrder,
        });
    } catch (error) {
        console.error('Complete Order Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to complete order.',
        });
    }
});

/**
 * Cancel an order (buyer or freelancer). Only allowed while still PENDING
 * PATCH /freelance-orders/:id/cancel
 */
router.patch('/:id/cancel', authenticateToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        if (isNaN(orderId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid order ID.',
            });
        }

        const [buyerProfile, freelancerProfile] = await Promise.all([
            prisma.buyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.freelancerProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const existingOrder = await prisma.freelancerOrder.findUnique({ where: { id: orderId } });

        if (!existingOrder) {
            return res.status(404).json({
                successful: false,
                message: 'Order not found.',
            });
        }

        const isBuyer = buyerProfile && buyerProfile.id === existingOrder.buyer_profile_id;
        const isFreelancer = freelancerProfile && freelancerProfile.id === existingOrder.freelancer_profile_id;

        if (!isBuyer && !isFreelancer) {
            return res.status(403).json({
                successful: false,
                message: 'You do not have permission to cancel this order.',
            });
        }

        if (existingOrder.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending orders can be cancelled.',
            });
        }

        // Cancel Stripe payment intent if exists
        if (existingOrder.stripe_payment_intent_id && stripe) {
            try {
                await stripe.paymentIntents.cancel(existingOrder.stripe_payment_intent_id);
            } catch (stripeError) {
                console.error('Failed to cancel payment intent:', stripeError);
                // Continue with order cancellation even if Stripe cancellation fails
            }
        }

        const cancelledOrder = await prisma.freelancerOrder.update({
            where: { id: orderId },
            data: { 
                status: 'CANCELLED',
                payment_status: 'CANCELLED',
            },
        });

        return res.json({
            successful: true,
            message: 'Order cancelled successfully.',
            data: cancelledOrder,
        });
    } catch (error) {
        console.error('Cancel Order Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to cancel order.',
        });
    }
});

export default router;