import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

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

/**
 * Create a review for a completed order
 * POST /freelance-reviews
 * Body: { order_id, rating, review }
 *
 * Only the buyer on a COMPLETED order can review it, and only once —
 * Review.order_id is @unique in the schema so a second attempt fails
 * at the DB level too, but we check first for a clean error message.
 */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { order_id, rating, review } = req.body;

        const orderId = parseInt(order_id);
        if (isNaN(orderId)) {
            return res.status(400).json({
                successful: false,
                message: 'Valid order_id is required.',
            });
        }

        const ratingNum = parseInt(rating);
        if (!rating || isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({
                successful: false,
                message: 'rating is required and must be an integer between 1 and 5.',
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

        const freelancerOrder = await prisma.freelancerOrder.findFirst({
            where: { id: orderId, buyer_profile_id: buyerProfile.id },
            include: { review: true },
        });

        if (!freelancerOrder) {
            return res.status(404).json({
                successful: false,
                message: 'Order not found or you do not have permission to review it.',
            });
        }

        if (freelancerOrder.status !== 'COMPLETED') {
            return res.status(400).json({
                successful: false,
                message: 'Only completed orders can be reviewed.',
            });
        }

        if (freelancerOrder.review) {
            return res.status(409).json({
                successful: false,
                message: 'This order has already been reviewed.',
            });
        }

        const newReview = await prisma.review.create({
            data: {
                order_id: freelancerOrder.id,
                gig_id: freelancerOrder.gig_id,
                buyer_profile_id: freelancerOrder.buyer_profile_id,
                freelancer_profile_id: freelancerOrder.freelancer_profile_id,
                rating: ratingNum,
                review: review?.trim() || null,
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Review submitted successfully.',
            data: newReview,
        });
    } catch (error) {
        console.error('Create Review Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to submit review.',
        });
    }
});

/**
 * Get a single review by ID
 * GET /freelance-reviews/:id
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const reviewId = parseInt(req.params.id);
        if (isNaN(reviewId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid review ID.',
            });
        }

        const review = await prisma.review.findUnique({
            where: { id: reviewId },
            include: {
                buyer_profile: {
                    select: {
                        id: true,
                        user: { select: publicUserSelect },
                    },
                },
                gig: {
                    select: { id: true, title: true },
                },
                freelancer_order: {
                    select: { id: true, status: true },
                },
            },
        });

        if (!review) {
            return res.status(404).json({
                successful: false,
                message: 'Review not found.',
            });
        }

        return res.json({ successful: true, data: review });
    } catch (error) {
        console.error('Get Review Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch review.',
        });
    }
});

/**
 * Get all reviews for a gig (public)
 * GET /freelance-reviews/gig/:gigId
 * Query params: limit, offset
 */
router.get('/gig/:gigId', authenticateToken, async (req, res) => {
    try {
        const gigId = parseInt(req.params.gigId);
        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid gig ID.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.review.findMany({
                where: { gig_id: gigId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicUserSelect },
                        },
                    },
                },
            }),
            prisma.review.count({ where: { gig_id: gigId } }),
            prisma.review.aggregate({
                where: { gig_id: gigId },
                _avg: { rating: true },
            }),
        ]);

        return res.json({
            successful: true,
            data: reviews,
            averageRating: aggregate._avg.rating || 0,
            pagination: { total, limit: take, offset: skip },
        });
    } catch (error) {
        console.error('Get Gig Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch gig reviews.',
        });
    }
});

/**
 * Get all reviews for a freelancer, across all their gigs (public)
 * GET /freelance-reviews/freelancer/:freelancerProfileId
 * Query params: limit, offset
 */
router.get('/freelancer/:freelancerProfileId', authenticateToken, async (req, res) => {
    try {
        const freelancerProfileId = parseInt(req.params.freelancerProfileId);
        if (isNaN(freelancerProfileId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid freelancer profile ID.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.review.findMany({
                where: { freelancer_profile_id: freelancerProfileId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicUserSelect },
                        },
                    },
                    gig: {
                        select: { id: true, title: true },
                    },
                },
            }),
            prisma.review.count({ where: { freelancer_profile_id: freelancerProfileId } }),
            prisma.review.aggregate({
                where: { freelancer_profile_id: freelancerProfileId },
                _avg: { rating: true },
            }),
        ]);

        return res.json({
            successful: true,
            data: reviews,
            averageRating: aggregate._avg.rating || 0,
            pagination: { total, limit: take, offset: skip },
        });
    } catch (error) {
        console.error('Get Freelancer Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch freelancer reviews.',
        });
    }
});

/**
 * Update my review
 * PUT /freelance-reviews/:id
 * Body: { rating, review }
 */
// router.put('/:id', authenticateToken, async (req, res) => {
//     try {
//         const reviewId = parseInt(req.params.id);
//         if (isNaN(reviewId)) {
//             return res.status(400).json({
//                 successful: false,
//                 message: 'Invalid review ID.',
//             });
//         }

//         const buyerProfile = await prisma.buyerProfile.findUnique({
//             where: { user_id: req.user.user_id },
//         });

//         if (!buyerProfile) {
//             return res.status(404).json({
//                 successful: false,
//                 message: 'Buyer profile not found.',
//             });
//         }

//         const existingReview = await prisma.review.findFirst({
//             where: { id: reviewId, buyer_profile_id: buyerProfile.id },
//         });

//         if (!existingReview) {
//             return res.status(404).json({
//                 successful: false,
//                 message: 'Review not found or you do not have permission to edit it.',
//             });
//         }

//         const { rating, review } = req.body;

//         let ratingNum = existingReview.rating;
//         if (rating !== undefined) {
//             ratingNum = parseInt(rating);
//             if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
//                 return res.status(400).json({
//                     successful: false,
//                     message: 'rating must be an integer between 1 and 5.',
//                 });
//             }
//         }

//         const updatedReview = await prisma.review.update({
//             where: { id: reviewId },
//             data: {
//                 rating: ratingNum,
//                 review: review !== undefined ? (review?.trim() || null) : existingReview.review,
//             },
//         });

//         return res.json({
//             successful: true,
//             message: 'Review updated successfully.',
//             data: updatedReview,
//         });
//     } catch (error) {
//         console.error('Update Review Error:', error);
//         return res.status(500).json({
//             successful: false,
//             message: 'Failed to update review.',
//         });
//     }
// });

export default router;