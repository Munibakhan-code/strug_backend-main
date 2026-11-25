// celebrity-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import Stripe from 'stripe';
import { normalizeReferralCode } from '../utils/referral-settlement.js';
// Bounded list queries — see utils/pagination.js for why every list endpoint needs a cap.
import { paginate } from '../utils/pagination.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

// Reusable public celebrity info select
const publicCelebritySelect = {
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

// =========================================
// Helper: Credit celebrity booking on payment
// =========================================

/**
 * Atomic helper to credit a celebrity's wallet when a payment succeeds.
 * This is used by both the webhook and the self-heal logic.
 * It safely guards against double-crediting via unique constraint on booking_id.
 */
async function creditCelebrityBookingOnPaid(booking) {
    return await prisma.$transaction(async (tx) => {
        // Check if booking is already PAID to prevent double credit
        if (booking.payment_status === 'PAID') {
            return booking;
        }

        // Update booking payment status to PAID
        const updatedBooking = await tx.celebrityBooking.update({
            where: { id: booking.id },
            data: {
                payment_status: 'PAID',
            },
        });

        // Get the celebrity wallet
        const wallet = await tx.celebrityWallet.findUnique({
            where: { celebrity_profile_id: booking.celebrity_profile_id },
        });

        if (!wallet) {
            console.error(`Wallet not found for celebrity_profile_id: ${booking.celebrity_profile_id}`);
            return updatedBooking;
        }

        // Check if transaction already exists for this booking (idempotency)
        const existingTransaction = await tx.celebrityWalletTransaction.findFirst({
            where: {
                booking_id: booking.id,
                type: 'BOOKING',
            },
        });

        if (existingTransaction) {
            console.log(`Transaction already exists for booking ${booking.id}, skipping credit`);
            return updatedBooking;
        }

        // Update wallet pending balance
        await tx.celebrityWallet.update({
            where: { id: wallet.id },
            data: {
                pending_balance: { increment: booking.price },
            },
        });

        // Create wallet transaction record
        await tx.celebrityWalletTransaction.create({
            data: {
                wallet_id: wallet.id,
                booking_id: booking.id,
                buyer_profile_id: booking.buyer_profile_id,
                celebrity_profile_id: booking.celebrity_profile_id,
                amount: booking.price,
                type: 'BOOKING',
                status: 'PENDING',
            },
        });

        console.log(`Successfully credited booking ${booking.id} to wallet ${wallet.id}`);
        return updatedBooking;
    });
}

// =========================================
// Celebrity Profile Routes
// =========================================

/**
 * Create Celebrity Profile
 * POST /celebrity/profile
 */
router.post('/profile', authenticateToken, async (req, res) => {
    try {
        const {
            display_name,
            celebrity_bio,
            tagline,
            country,
            city,
            languages,
            profile_image,
            cover_image,
        } = req.body;

        if (!display_name || !display_name.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'display_name is required.',
            });
        }

        if (!Array.isArray(languages)) {
            return res.status(400).json({
                successful: false,
                message: 'languages must be an array.',
            });
        }

        const existingProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (existingProfile) {
            return res.status(409).json({
                successful: false,
                message: 'Celebrity profile already exists.',
            });
        }

        const celebrityProfile = await prisma.$transaction(async (tx) => {
            const profile = await tx.celebrityProfile.create({
                data: {
                    user_id: req.user.user_id,
                    display_name: display_name.trim(),
                    celebrity_bio: celebrity_bio?.trim() || null,
                    tagline: tagline?.trim() || null,
                    country: country?.trim() || null,
                    city: city?.trim() || null,
                    languages,
                    profile_image: profile_image || null,
                    cover_image: cover_image || null,
                    status: 'PENDING',
                },
            });

            await tx.celebrityWallet.create({
                data: {
                    celebrity_profile_id: profile.id,
                    pending_balance: 0,
                    available_balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                },
            });

            return profile;
        });

        return res.status(201).json({
            successful: true,
            message: 'Celebrity profile created successfully.',
            data: celebrityProfile,
        });
    } catch (error) {
        console.error('Create Celebrity Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create celebrity profile.',
        });
    }
});

/**
 * Get My Celebrity Profile
 * GET /celebrity/profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        return res.json({
            successful: true,
            data: celebrityProfile,
        });
    } catch (error) {
        console.error('Get Celebrity Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity profile.',
        });
    }
});

/**
 * Update My Celebrity Profile
 * PUT /celebrity/profile
 */
router.put('/profile', authenticateToken, async (req, res) => {
    try {
        const existingProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!existingProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const {
            display_name,
            celebrity_bio,
            tagline,
            country,
            city,
            languages,
            profile_image,
            cover_image,
        } = req.body;

        const updatedProfile = await prisma.celebrityProfile.update({
            where: { user_id: req.user.user_id },
            data: {
                display_name: display_name ?? existingProfile.display_name,
                celebrity_bio: celebrity_bio ?? existingProfile.celebrity_bio,
                tagline: tagline ?? existingProfile.tagline,
                country: country ?? existingProfile.country,
                city: city ?? existingProfile.city,
                languages: languages ?? existingProfile.languages,
                profile_image: profile_image ?? existingProfile.profile_image,
                cover_image: cover_image ?? existingProfile.cover_image,
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity profile updated successfully.',
            data: updatedProfile,
        });
    } catch (error) {
        console.error('Update Celebrity Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update celebrity profile.',
        });
    }
});

// =========================================
// Celebrity Listing Routes
// =========================================

/**
 * Create a celebrity listing
 * POST /celebrity/listings
 */
router.post('/listings', authenticateToken, async (req, res) => {
    try {
        const {
            title,
            description,
            category,
            known_for,
            location,
            price_per_video,
            turnaround_days,
            photos,
        } = req.body;

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found. Please create your profile first.',
            });
        }

        // Check if listing already exists
        const existingListing = await prisma.celebrityListing.findUnique({
            where: { celebrity_profile_id: celebrityProfile.id },
        });

        if (existingListing) {
            return res.status(409).json({
                successful: false,
                message: 'Listing already exists. Use PUT to update it.',
            });
        }

        if (!title || !title.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'title is required.',
            });
        }

        if (!description || !description.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'description is required.',
            });
        }

        if (!category || !category.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'category is required.',
            });
        }

        if (!known_for || !known_for.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'known_for is required.',
            });
        }

        if (!price_per_video || isNaN(price_per_video) || price_per_video <= 0) {
            return res.status(400).json({
                successful: false,
                message: 'price_per_video must be a valid number greater than 0.',
            });
        }

        if (!turnaround_days || isNaN(turnaround_days) || turnaround_days <= 0) {
            return res.status(400).json({
                successful: false,
                message: 'turnaround_days must be a valid number greater than 0.',
            });
        }

        const listing = await prisma.celebrityListing.create({
            data: {
                celebrity_profile_id: celebrityProfile.id,
                title: title.trim(),
                description: description.trim(),
                category: category.trim(),
                known_for: known_for.trim(),
                location: location?.trim() || null,
                price_per_video: parseFloat(price_per_video),
                turnaround_days: parseInt(turnaround_days),
                photos: photos || [],
                status: 'DRAFT',
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Celebrity listing created successfully.',
            data: listing,
        });
    } catch (error) {
        console.error('Create Celebrity Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create celebrity listing.',
        });
    }
});

/**
 * Get my listing (celebrity's own listing - only one per celebrity)
 * GET /celebrity/listings/my-listing
 */
router.get('/listings/my-listing', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const listing = await prisma.celebrityListing.findUnique({
            where: {
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!listing || listing.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found.',
            });
        }

        // Get stats
        const [bookingCount, reviewAgg] = await Promise.all([
            prisma.celebrityBooking.count({
                where: { listing_id: listing.id },
            }),
            prisma.celebrityReview.aggregate({
                where: { listing_id: listing.id },
                _avg: { rating: true },
            }),
        ]);

        return res.json({
            successful: true,
            data: {
                ...listing,
                totalBookings: bookingCount,
                averageRating: reviewAgg._avg.rating ?? 0,
            },
        });
    } catch (error) {
        console.error('Get My Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your listing.',
        });
    }
});

/**
 * Get all active celebrity listings (public view)
 * GET /celebrity/listings
 */
router.get('/listings', authenticateToken, async (req, res) => {
    try {
        const {
            category,
            search,
            sortBy = 'recent',
            limit = 10,
            offset = 0,
        } = req.query;

        const where = {
            status: 'ACTIVE',
        };

        if (category && category !== 'All') {
            where.category = {
                equals: category,
                mode: 'insensitive',
            };
        }

        if (search) {
            where.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } },
                { known_for: { contains: search, mode: 'insensitive' } },
            ];
        }

        const take = parseInt(limit) || 10;
        const skip = parseInt(offset) || 0;

        let orderBy = {};
        switch (sortBy) {
            case 'price_low':
                orderBy = { price_per_video: 'asc' };
                break;
            case 'price_high':
                orderBy = { price_per_video: 'desc' };
                break;
            case 'oldest':
                orderBy = { created_at: 'asc' };
                break;
            case 'recent':
            default:
                orderBy = { created_at: 'desc' };
                break;
        }

        const total = await prisma.celebrityListing.count({ where });

        const listings = await prisma.celebrityListing.findMany({
            where,
            take,
            skip,
            orderBy,
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                _count: {
                    select: {
                        bookings: true,
                        reviews: true,
                    },
                },
            },
        });

        const listingsWithRatings = await Promise.all(
            listings.map(async (listing) => {
                const avg = await prisma.celebrityReview.aggregate({
                    where: {
                        listing_id: listing.id,
                    },
                    _avg: {
                        rating: true,
                    },
                });

                // Extract profile_image and cover_image from the celebrity_profile
                const celebrityProfile = listing.celebrity_profile || {};

                return {
                    ...listing,
                    averageRating: avg._avg.rating ?? 0,
                    // Include profile_image and cover_image at the top level for easy access
                    profile_image: celebrityProfile.profile_image || null,
                    cover_image: celebrityProfile.cover_image || null,
                };
            })
        );

        return res.json({
            successful: true,
            data: listingsWithRatings,
            pagination: {
                total,
                limit: take,
                offset: skip,
                totalPages: Math.ceil(total / take),
            },
        });
    } catch (error) {
        console.error('Get Celebrity Listings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity listings.',
        });
    }
});

/**
 * Get listing by ID
 * GET /celebrity/listings/:id
 */
router.get('/listings/:id', authenticateToken, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);

        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid listing ID.',
            });
        }

        const listing = await prisma.celebrityListing.findUnique({
            where: {
                id: listingId,
            },
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                _count: {
                    select: {
                        bookings: true,
                        reviews: true,
                    },
                },
            },
        });

        if (!listing || listing.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity listing not found.',
            });
        }

        const avg = await prisma.celebrityReview.aggregate({
            where: {
                listing_id: listingId,
            },
            _avg: {
                rating: true,
            },
        });

        return res.json({
            successful: true,
            data: {
                ...listing,
                averageRating: avg._avg.rating ?? 0,
            },
        });
    } catch (error) {
        console.error('Get Celebrity Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity listing.',
        });
    }
});

/**
 * Update listing
 * PUT /celebrity/listings
 * (celebrity can only update their own listing)
 */
router.put('/listings', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const existingListing = await prisma.celebrityListing.findUnique({
            where: {
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!existingListing || existingListing.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found.',
            });
        }

        const {
            title,
            description,
            category,
            known_for,
            location,
            price_per_video,
            turnaround_days,
            photos,
            status,
        } = req.body;

        const validStatuses = ['ACTIVE', 'PAUSED', 'DRAFT'];
        if (status && !validStatuses.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
        }

        const updatedListing = await prisma.celebrityListing.update({
            where: { id: existingListing.id },
            data: {
                title: title?.trim() || existingListing.title,
                description: description?.trim() || existingListing.description,
                category: category?.trim() || existingListing.category,
                known_for: known_for?.trim() || existingListing.known_for,
                location: location?.trim() || existingListing.location,
                price_per_video: price_per_video !== undefined ? parseFloat(price_per_video) : existingListing.price_per_video,
                turnaround_days: turnaround_days !== undefined ? parseInt(turnaround_days) : existingListing.turnaround_days,
                photos: photos || existingListing.photos,
                status: status || existingListing.status,
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity listing updated successfully.',
            data: updatedListing,
        });
    } catch (error) {
        console.error('Update Celebrity Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update celebrity listing.',
        });
    }
});

/**
 * Delete listing (soft delete)
 * DELETE /celebrity/listings
 */
router.delete('/listings', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const existingListing = await prisma.celebrityListing.findUnique({
            where: {
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!existingListing || existingListing.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found.',
            });
        }

        const deletedListing = await prisma.celebrityListing.update({
            where: { id: existingListing.id },
            data: {
                status: 'DELETED',
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity listing deleted successfully.',
            data: deletedListing,
        });
    } catch (error) {
        console.error('Delete Celebrity Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to delete celebrity listing.',
        });
    }
});

/**
 * Update listing status (Publish/Unpublish)
 * PATCH /celebrity/listings/status
 */
router.patch('/listings/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                successful: false,
                message: 'Status is required.',
            });
        }

        const validStatuses = ['ACTIVE', 'PAUSED', 'DRAFT'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const existingListing = await prisma.celebrityListing.findUnique({
            where: {
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!existingListing || existingListing.status === 'DELETED') {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found.',
            });
        }

        // Can't publish without required fields
        if (status === 'ACTIVE') {
            const listing = existingListing;
            if (!listing.title || !listing.description || !listing.category || !listing.known_for) {
                return res.status(400).json({
                    successful: false,
                    message: 'Cannot publish listing. Please ensure title, description, category, and known_for are filled.',
                });
            }
            if (!listing.price_per_video || listing.price_per_video <= 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Cannot publish listing. Please set a valid price per video.',
                });
            }
            if (!listing.turnaround_days || listing.turnaround_days <= 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Cannot publish listing. Please set a valid turnaround time.',
                });
            }
        }

        const updatedListing = await prisma.celebrityListing.update({
            where: { id: existingListing.id },
            data: {
                status: status,
            },
        });

        return res.json({
            successful: true,
            message: `Listing status updated to ${status}.`,
            data: updatedListing,
        });
    } catch (error) {
        console.error('Update Listing Status Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update listing status.',
        });
    }
});

// =========================================
// Celebrity Booking Routes
// =========================================

/**
 * Create a booking request (buyer)
 * POST /celebrity/bookings
 */
router.post('/bookings', authenticateToken, async (req, res) => {
    try {
        const {
            listing_id,
            message_type,
            recipient_name,
            request_message,
            referral_code,
        } = req.body;
        const orderReferralCode = normalizeReferralCode(referral_code);

        const listingId = parseInt(listing_id);

        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Valid listing_id is required.',
            });
        }

        if (!request_message || !request_message.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'request_message is required.',
            });
        }

        if (!message_type || !['MYSELF', 'SOMEONE_ELSE'].includes(message_type)) {
            return res.status(400).json({
                successful: false,
                message: 'message_type must be MYSELF or SOMEONE_ELSE.',
            });
        }

        if (message_type === 'SOMEONE_ELSE' && (!recipient_name || !recipient_name.trim())) {
            return res.status(400).json({
                successful: false,
                message: 'recipient_name is required when message_type is SOMEONE_ELSE.',
            });
        }

        const listing = await prisma.celebrityListing.findUnique({
            where: { id: listingId },
        });

        if (!listing || listing.status !== 'ACTIVE') {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity listing not found or not active.',
            });
        }

        // Check if user is trying to book their own listing
        const ownCelebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (ownCelebrityProfile && ownCelebrityProfile.id === listing.celebrity_profile_id) {
            return res.status(400).json({
                successful: false,
                message: 'You cannot book your own listing.',
            });
        }

        // Get or create buyer profile
        const buyerProfile = await prisma.celebrityBuyerProfile.upsert({
            where: { user_id: req.user.user_id },
            update: {},
            create: { user_id: req.user.user_id },
        });

        // Create booking (optional per-order Referral friend code).
        const booking = await prisma.celebrityBooking.create({
            data: {
                buyer_profile_id: buyerProfile.id,
                celebrity_profile_id: listing.celebrity_profile_id,
                listing_id: listingId,
                message_type: message_type,
                recipient_name: message_type === 'SOMEONE_ELSE' ? recipient_name.trim() : null,
                request_message: request_message.trim(),
                price: listing.price_per_video,
                status: 'PENDING',
                payment_status: 'PENDING',
                referral_code: orderReferralCode,
            },
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                listing: {
                    select: {
                        id: true,
                        title: true,
                        photos: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Celebrity booking request created successfully. Waiting for celebrity approval.',
            data: booking,
        });
    } catch (error) {
        console.error('Create Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create celebrity booking request.',
        });
    }
});

/**
 * Get my bookings (as buyer)
 * GET /celebrity/bookings/my-bookings
 */
router.get('/bookings/my-bookings', authenticateToken, async (req, res) => {
    try {
        const buyerProfile = await prisma.celebrityBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.json({ successful: true, data: [] });
        }

        // A buyer's booking history only grows. GET /listings on this router is already paged;
        // this one was not, so it loaded every booking the account had ever made on each open.
        const bookingWhere = { buyer_profile_id: buyerProfile.id };
        const bookings = await paginate(
            req,
            res,
            ({ take, skip }) => prisma.celebrityBooking.findMany({
                where: bookingWhere,
                take,
                skip,
                include: {
                    celebrity_profile: {
                        include: {
                            user: {
                                select: publicCelebritySelect,
                            },
                        },
                    },
                    listing: {
                        select: {
                            id: true,
                            title: true,
                            photos: true,
                        },
                    },
                    review: true,
                },
                orderBy: { created_at: 'desc' },
            }),
            { total: () => prisma.celebrityBooking.count({ where: bookingWhere }) },
        );

        return res.json({ successful: true, data: bookings });
    } catch (error) {
        console.error('Get My Celebrity Bookings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your celebrity bookings.',
        });
    }
});

/**
 * Get received bookings (as celebrity)
 * GET /celebrity/bookings/received-bookings
 */
router.get('/bookings/received-bookings', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        // Same reasoning as my-bookings: a working celebrity's inbox grows without limit.
        const receivedWhere = { celebrity_profile_id: celebrityProfile.id };
        const bookings = await paginate(
            req,
            res,
            ({ take, skip }) => prisma.celebrityBooking.findMany({
                where: receivedWhere,
                take,
                skip,
                include: {
                    buyer_profile: {
                        include: {
                            user: {
                                select: publicCelebritySelect,
                            },
                        },
                    },
                    listing: {
                        select: {
                            id: true,
                            title: true,
                            photos: true,
                        },
                    },
                    review: true,
                },
                orderBy: { created_at: 'desc' },
            }),
            { total: () => prisma.celebrityBooking.count({ where: receivedWhere }) },
        );

        return res.json({ successful: true, data: bookings });
    } catch (error) {
        console.error('Get Received Celebrity Bookings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch received celebrity bookings.',
        });
    }
});

/**
 * Get single booking by ID (with self-heal)
 * GET /celebrity/bookings/:id
 */
router.get('/bookings/:id', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        let booking = await prisma.celebrityBooking.findUnique({
            where: { id: bookingId },
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                listing: {
                    select: {
                        id: true,
                        title: true,
                        photos: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                review: true,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found.',
            });
        }

        // FIX 1: SELF-HEAL - If booking is PENDING but has a payment intent, check Stripe
        if (booking.payment_status === 'PENDING' && booking.stripe_payment_intent_id && stripe) {
            try {
                const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
                if (pi.status === 'succeeded') {
                    // Self-heal: flip PENDING->PAID AND credit the celebrity wallet, exactly once
                    await creditCelebrityBookingOnPaid(booking);

                    // Reload the booking with all includes
                    booking = await prisma.celebrityBooking.findUnique({
                        where: { id: bookingId },
                        include: {
                            celebrity_profile: {
                                include: {
                                    user: {
                                        select: publicCelebritySelect,
                                    },
                                },
                            },
                            listing: {
                                select: {
                                    id: true,
                                    title: true,
                                    photos: true,
                                },
                            },
                            buyer_profile: {
                                include: {
                                    user: {
                                        select: publicCelebritySelect,
                                    },
                                },
                            },
                            review: true,
                        },
                    });

                    console.log(`Self-healed celebrity booking ${booking.id} from PENDING to PAID`);
                }
            } catch (error) {
                console.error('Failed to verify payment status with Stripe:', error);
                // Don't fail the request, just log the error
            }
        }

        const [buyerProfile, celebrityProfile] = await Promise.all([
            prisma.celebrityBuyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.celebrityProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const isBuyer = buyerProfile && buyerProfile.id === booking.buyer_profile_id;
        const isCelebrity = celebrityProfile && celebrityProfile.id === booking.celebrity_profile_id;

        if (!isBuyer && !isCelebrity) {
            return res.status(403).json({
                successful: false,
                message: 'You do not have permission to view this booking.',
            });
        }

        return res.json({ successful: true, data: booking });
    } catch (error) {
        console.error('Get Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity booking.',
        });
    }
});

/**
 * Celebrity approves a booking request
 * PATCH /celebrity/bookings/:id/approve
 */
router.patch('/bookings/:id/approve', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const existingBooking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission to approve it.',
            });
        }

        if (existingBooking.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending bookings can be approved.',
            });
        }

        const updatedBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                status: 'ACCEPTED',
            },
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                listing: {
                    select: {
                        id: true,
                        title: true,
                        photos: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity booking approved. Buyer can now complete the payment.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Approve Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to approve celebrity booking.',
        });
    }
});

/**
 * Celebrity rejects a booking request
 * PATCH /celebrity/bookings/:id/reject
 */
router.patch('/bookings/:id/reject', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const existingBooking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission to reject it.',
            });
        }

        if (existingBooking.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending bookings can be rejected.',
            });
        }

        const updatedBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                status: 'CANCELLED',
                payment_status: 'CANCELLED',
            },
            include: {
                celebrity_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
                listing: {
                    select: {
                        id: true,
                        title: true,
                        photos: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicCelebritySelect,
                        },
                    },
                },
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity booking rejected.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Reject Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to reject celebrity booking.',
        });
    }
});

/**
 * Buyer completes payment for an approved booking
 * POST /celebrity/bookings/:id/pay
 */
router.post('/bookings/:id/pay', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const buyerProfile = await prisma.celebrityBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const booking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                buyer_profile_id: buyerProfile.id,
            },
            include: {
                listing: true,
                celebrity_profile: {
                    include: {
                        user: true,
                    },
                },
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission to pay for it.',
            });
        }

        if (booking.status !== 'ACCEPTED') {
            return res.status(400).json({
                successful: false,
                message: 'Celebrity booking must be accepted before payment.',
            });
        }

        if (booking.payment_status === 'PAID') {
            return res.status(400).json({
                successful: false,
                message: 'This booking has already been paid.',
            });
        }

        if (!stripe) {
            return res.status(503).json({ successful: false, message: 'Stripe not configured' });
        }

        const priceInCents = Math.round(parseFloat(booking.price) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: priceInCents,
            currency: 'usd',
            payment_method_types: ['card'],
            metadata: {
                booking_id: booking.id,
                listing_title: booking.listing.title,
                buyer_id: req.user.user_id,
                celebrity_id: booking.celebrity_profile_id,
                type: 'celebrity',
                purpose: 'celebrity_booking',
            },
            receipt_email: req.user.email,
            description: `Celebrity Cameo: ${booking.listing.title}`,
        });

        const updatedBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                stripe_payment_intent_id: paymentIntent.id,
            },
        });

        return res.json({
            successful: true,
            message: 'Payment intent created successfully.',
            data: {
                booking: updatedBooking,
                client_secret: paymentIntent.client_secret,
            },
        });
    } catch (error) {
        console.error('Celebrity Payment Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to process payment.',
        });
    }
});

/**
 * Celebrity marks booking as recording
 * PATCH /celebrity/bookings/:id/recording
 */
router.patch('/bookings/:id/recording', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const booking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission.',
            });
        }

        if (booking.status !== 'ACCEPTED') {
            return res.status(400).json({
                successful: false,
                message: 'Only accepted bookings can be marked as recording.',
            });
        }

        if (booking.payment_status !== 'PAID') {
            return res.status(400).json({
                successful: false,
                message: 'Booking must be paid before recording can start.',
            });
        }

        const updatedBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                status: 'RECORDING',
            },
        });

        return res.json({
            successful: true,
            message: 'Booking marked as recording.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Mark Recording Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to mark booking as recording.',
        });
    }
});

/**
 * Celebrity delivers video (upload video URL)
 * PATCH /celebrity/bookings/:id/deliver
 */
router.patch('/bookings/:id/deliver', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        const { video_url } = req.body;

        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        if (!video_url || !video_url.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'video_url is required.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const booking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission.',
            });
        }

        if (booking.status !== 'RECORDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only bookings in recording status can be delivered.',
            });
        }

        const updatedBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                video_url: video_url.trim(),
                status: 'DELIVERED',
            },
        });

        return res.json({
            successful: true,
            message: 'Video delivered successfully.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Deliver Video Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to deliver video.',
        });
    }
});

/**
 * Buyer marks booking as completed (after receiving video)
 * PATCH /celebrity/bookings/:id/complete
 */
router.patch('/bookings/:id/complete', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const buyerProfile = await prisma.celebrityBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const booking = await prisma.celebrityBooking.findFirst({
            where: {
                id: bookingId,
                buyer_profile_id: buyerProfile.id,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to complete it.',
            });
        }

        if (booking.status !== 'DELIVERED') {
            return res.status(400).json({
                successful: false,
                message: 'Only delivered bookings can be marked as completed.',
            });
        }

        if (booking.status === 'COMPLETED') {
            return res.status(400).json({
                successful: false,
                message: 'This booking has already been completed.',
            });
        }

        const updatedBooking = await prisma.$transaction(async (tx) => {
            const updated = await tx.celebrityBooking.update({
                where: { id: bookingId },
                data: {
                    status: 'COMPLETED',
                    completed_at: new Date(),
                },
            });

            // Update celebrity profile total bookings
            await tx.celebrityProfile.update({
                where: { id: booking.celebrity_profile_id },
                data: {
                    total_bookings: {
                        increment: 1,
                    },
                },
            });

            // Move pending to available in wallet
            const wallet = await tx.celebrityWallet.findUnique({
                where: { celebrity_profile_id: booking.celebrity_profile_id },
            });

            if (wallet) {
                await tx.celebrityWallet.update({
                    where: { id: wallet.id },
                    data: {
                        pending_balance: { decrement: booking.price },
                        available_balance: { increment: booking.price },
                        total_earned: { increment: booking.price },
                    },
                });

                // FIX 2: Create/update wallet transaction record
                // First check if transaction exists
                const existingTransaction = await tx.celebrityWalletTransaction.findFirst({
                    where: {
                        wallet_id: wallet.id,
                        booking_id: booking.id,
                        type: 'BOOKING',
                    },
                });

                if (existingTransaction) {
                    // Update existing transaction to AVAILABLE
                    await tx.celebrityWalletTransaction.update({
                        where: { id: existingTransaction.id },
                        data: {
                            status: 'AVAILABLE',
                            available_at: new Date(),
                        },
                    });
                } else {
                    // Create new transaction record
                    await tx.celebrityWalletTransaction.create({
                        data: {
                            wallet_id: wallet.id,
                            booking_id: booking.id,
                            buyer_profile_id: booking.buyer_profile_id,
                            celebrity_profile_id: booking.celebrity_profile_id,
                            amount: booking.price,
                            type: 'BOOKING',
                            status: 'AVAILABLE',
                            available_at: new Date(),
                        },
                    });
                }
            }

            return updated;
        });

        return res.json({
            successful: true,
            message: 'Booking completed successfully. Payment has been credited to your wallet.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Complete Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to complete celebrity booking.',
        });
    }
});

/**
 * Cancel a booking (buyer or celebrity). Only allowed while still PENDING
 * PATCH /celebrity/bookings/:id/cancel
 */
router.patch('/bookings/:id/cancel', authenticateToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid booking ID.',
            });
        }

        const [buyerProfile, celebrityProfile] = await Promise.all([
            prisma.celebrityBuyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.celebrityProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const existingBooking = await prisma.celebrityBooking.findUnique({ where: { id: bookingId } });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found.',
            });
        }

        const isBuyer = buyerProfile && buyerProfile.id === existingBooking.buyer_profile_id;
        const isCelebrity = celebrityProfile && celebrityProfile.id === existingBooking.celebrity_profile_id;

        if (!isBuyer && !isCelebrity) {
            return res.status(403).json({
                successful: false,
                message: 'You do not have permission to cancel this booking.',
            });
        }

        if (existingBooking.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending bookings can be cancelled.',
            });
        }

        if (existingBooking.stripe_payment_intent_id && stripe) {
            try {
                await stripe.paymentIntents.cancel(existingBooking.stripe_payment_intent_id);
            } catch (stripeError) {
                console.error('Failed to cancel payment intent:', stripeError);
            }
        }

        const cancelledBooking = await prisma.celebrityBooking.update({
            where: { id: bookingId },
            data: {
                status: 'CANCELLED',
                payment_status: 'CANCELLED',
            },
        });

        return res.json({
            successful: true,
            message: 'Celebrity booking cancelled successfully.',
            data: cancelledBooking,
        });
    } catch (error) {
        console.error('Cancel Celebrity Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to cancel celebrity booking.',
        });
    }
});

// =========================================
// Celebrity Wallet Routes
// =========================================

/**
 * Get wallet details
 * GET /celebrity/wallet
 */
router.get('/wallet', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const wallet = await prisma.celebrityWallet.findUnique({
            where: { celebrity_profile_id: celebrityProfile.id },
        });

        if (!wallet) {
            return res.status(404).json({
                successful: false,
                message: 'Wallet not found.',
            });
        }

        return res.json({
            successful: true,
            data: {
                pending_balance: wallet.pending_balance,
                available_balance: wallet.available_balance,
                total_earned: wallet.total_earned,
                total_withdrawn: wallet.total_withdrawn,
            },
        });
    } catch (error) {
        console.error('Get Celebrity Wallet Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch wallet details.',
        });
    }
});

/**
 * Get wallet transactions
 * GET /celebrity/wallet/transactions
 */
router.get('/wallet/transactions', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const wallet = await prisma.celebrityWallet.findUnique({
            where: { celebrity_profile_id: celebrityProfile.id },
        });

        if (!wallet) {
            return res.status(404).json({
                successful: false,
                message: 'Wallet not found.',
            });
        }

        const { type, status, limit = 20, offset = 0 } = req.query;

        const where = { wallet_id: wallet.id };
        if (type) where.type = type;
        if (status) where.status = status;

        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [transactions, total] = await Promise.all([
            prisma.celebrityWalletTransaction.findMany({
                where,
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    booking: {
                        include: {
                            listing: {
                                select: {
                                    id: true,
                                    title: true,
                                },
                            },
                            buyer_profile: {
                                select: {
                                    user: {
                                        select: {
                                            username: true,
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.celebrityWalletTransaction.count({ where }),
        ]);

        return res.json({
            successful: true,
            data: transactions,
            pagination: {
                total,
                limit: take,
                offset: skip,
            },
        });
    } catch (error) {
        console.error('Get Celebrity Transactions Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch transactions.',
        });
    }
});

/**
 * Create a withdrawal request
 * POST /celebrity/wallet/withdraw
 */
router.post('/wallet/withdraw', authenticateToken, async (req, res) => {
    try {
        const { amount, method, account_title, account_number } = req.body;

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({
                successful: false,
                message: 'Valid amount is required.',
            });
        }

        if (!method || !method.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'Withdrawal method is required.',
            });
        }

        if (!account_title || !account_title.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'Account title is required.',
            });
        }

        if (!account_number || !account_number.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'Account number is required.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const wallet = await prisma.celebrityWallet.findUnique({
            where: { celebrity_profile_id: celebrityProfile.id },
        });

        if (!wallet) {
            return res.status(404).json({
                successful: false,
                message: 'Wallet not found.',
            });
        }

        if (wallet.available_balance < amount) {
            return res.status(400).json({
                successful: false,
                message: 'Insufficient available balance.',
            });
        }

        const [withdrawalRequest] = await prisma.$transaction(async (tx) => {
            const existingPending = await tx.celebrityWithdrawalRequest.findFirst({
                where: {
                    celebrity_profile_id: celebrityProfile.id,
                    status: 'PENDING',
                },
            });

            if (existingPending) {
                throw new Error('You already have a pending withdrawal request.');
            }

            const withdrawal = await tx.celebrityWithdrawalRequest.create({
                data: {
                    celebrity_profile_id: celebrityProfile.id,
                    wallet_id: wallet.id,
                    amount,
                    method: method.trim(),
                    account_title: account_title.trim(),
                    account_number: account_number.trim(),
                    status: 'PENDING',
                },
            });

            await tx.celebrityWallet.update({
                where: { id: wallet.id },
                data: {
                    available_balance: { decrement: amount },
                    total_withdrawn: { increment: amount },
                },
            });

            await tx.celebrityWalletTransaction.create({
                data: {
                    wallet_id: wallet.id,
                    amount,
                    type: 'WITHDRAWAL',
                    status: 'WITHDRAWN',
                    celebrity_profile_id: celebrityProfile.id,
                },
            });

            return [withdrawal];
        });

        return res.status(201).json({
            successful: true,
            message: 'Withdrawal request created successfully.',
            data: withdrawalRequest,
        });
    } catch (error) {
        console.error('Celebrity Withdrawal Error:', error);

        if (error.message === 'You already have a pending withdrawal request.') {
            return res.status(409).json({
                successful: false,
                message: error.message,
            });
        }

        return res.status(500).json({
            successful: false,
            message: 'Failed to process withdrawal request.',
        });
    }
});

/**
 * Get all withdrawal requests
 * GET /celebrity/wallet/withdrawals
 */
router.get('/wallet/withdrawals', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const { status, limit = 20, offset = 0 } = req.query;

        const where = { celebrity_profile_id: celebrityProfile.id };
        if (status) where.status = status;

        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [withdrawals, total] = await Promise.all([
            prisma.celebrityWithdrawalRequest.findMany({
                where,
                take,
                skip,
                orderBy: { requested_at: 'desc' },
            }),
            prisma.celebrityWithdrawalRequest.count({ where }),
        ]);

        return res.json({
            successful: true,
            data: withdrawals,
            pagination: {
                total,
                limit: take,
                offset: skip,
            },
        });
    } catch (error) {
        console.error('Get Celebrity Withdrawals Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch withdrawal requests.',
        });
    }
});

/**
 * Get a single withdrawal request by ID
 * GET /celebrity/wallet/withdrawals/:id
 */
router.get('/wallet/withdrawals/:id', authenticateToken, async (req, res) => {
    try {
        const withdrawalId = parseInt(req.params.id);
        if (isNaN(withdrawalId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid withdrawal ID.',
            });
        }

        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const withdrawal = await prisma.celebrityWithdrawalRequest.findFirst({
            where: {
                id: withdrawalId,
                celebrity_profile_id: celebrityProfile.id,
            },
        });

        if (!withdrawal) {
            return res.status(404).json({
                successful: false,
                message: 'Withdrawal request not found or you do not have permission to view it.',
            });
        }

        return res.json({
            successful: true,
            data: withdrawal,
        });
    } catch (error) {
        console.error('Get Celebrity Withdrawal Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch withdrawal request.',
        });
    }
});

// =========================================
// Celebrity Review Routes
// =========================================

/**
 * Create a review for a completed booking
 * POST /celebrity/reviews
 */
router.post('/reviews', authenticateToken, async (req, res) => {
    try {
        const { booking_id, rating, review: reviewText } = req.body;

        const bookingId = parseInt(booking_id);
        if (isNaN(bookingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Valid booking_id is required.',
            });
        }

        const ratingNum = parseInt(rating);
        if (!rating || isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({
                successful: false,
                message: 'rating is required and must be an integer between 1 and 5.',
            });
        }

        const buyerProfile = await prisma.celebrityBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const booking = await prisma.celebrityBooking.findFirst({
            where: { id: bookingId, buyer_profile_id: buyerProfile.id },
            include: { review: true },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity booking not found or you do not have permission to review it.',
            });
        }

        if (booking.status !== 'COMPLETED') {
            return res.status(400).json({
                successful: false,
                message: 'Only completed bookings can be reviewed.',
            });
        }

        if (booking.review) {
            return res.status(409).json({
                successful: false,
                message: 'This booking has already been reviewed.',
            });
        }

        const newReview = await prisma.$transaction(async (tx) => {
            const createdReview = await tx.celebrityReview.create({
                data: {
                    booking_id: booking.id,
                    listing_id: booking.listing_id,
                    buyer_profile_id: booking.buyer_profile_id,
                    celebrity_profile_id: booking.celebrity_profile_id,
                    rating: ratingNum,
                    review: reviewText?.trim() || null,
                },
            });

            const allReviews = await tx.celebrityReview.aggregate({
                where: { celebrity_profile_id: booking.celebrity_profile_id },
                _avg: { rating: true },
                _count: { rating: true },
            });

            await tx.celebrityProfile.update({
                where: { id: booking.celebrity_profile_id },
                data: {
                    rating: allReviews._avg.rating || 0,
                    total_reviews: allReviews._count.rating || 0,
                },
            });

            return createdReview;
        });

        return res.status(201).json({
            successful: true,
            message: 'Celebrity review submitted successfully.',
            data: newReview,
        });
    } catch (error) {
        console.error('Create Celebrity Review Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to submit celebrity review.',
        });
    }
});

/**
 * Get reviews for a listing
 * GET /celebrity/reviews/listing/:listingId
 */
router.get('/reviews/listing/:listingId', authenticateToken, async (req, res) => {
    try {
        const listingId = parseInt(req.params.listingId);
        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid listing ID.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.celebrityReview.findMany({
                where: { listing_id: listingId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicCelebritySelect },
                        },
                    },
                },
            }),
            prisma.celebrityReview.count({ where: { listing_id: listingId } }),
            prisma.celebrityReview.aggregate({
                where: { listing_id: listingId },
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
        console.error('Get Celebrity Listing Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity listing reviews.',
        });
    }
});

/**
 * Get reviews for a celebrity profile
 * GET /celebrity/reviews/celebrity/:celebrityProfileId
 */
router.get('/reviews/celebrity/:celebrityProfileId', authenticateToken, async (req, res) => {
    try {
        const celebrityProfileId = parseInt(req.params.celebrityProfileId);
        if (isNaN(celebrityProfileId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid celebrity profile ID.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.celebrityReview.findMany({
                where: { celebrity_profile_id: celebrityProfileId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicCelebritySelect },
                        },
                    },
                    listing: {
                        select: {
                            id: true,
                            title: true,
                        },
                    },
                },
            }),
            prisma.celebrityReview.count({ where: { celebrity_profile_id: celebrityProfileId } }),
            prisma.celebrityReview.aggregate({
                where: { celebrity_profile_id: celebrityProfileId },
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
        console.error('Get Celebrity Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity reviews.',
        });
    }
});
/**
 * 
 * Get reviews for the authenticated celebrity (my reviews)
 * GET /celebrity/reviews/my-reviews
 */
router.get('/reviews/my-reviews', authenticateToken, async (req, res) => {
    try {
        const celebrityProfile = await prisma.celebrityProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!celebrityProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Celebrity profile not found.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.celebrityReview.findMany({
                where: { celebrity_profile_id: celebrityProfile.id },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        include: {
                            user: {
                                select: {
                                    user_id: true,
                                    username: true,
                                    name: true,
                                    social_profiles: {
                                        select: {
                                            profile_pic_url: true,
                                            display_name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                    booking: {
                        select: {
                            id: true,
                            request_message: true,
                            recipient_name: true,
                            message_type: true,
                        },
                    },
                },
            }),
            prisma.celebrityReview.count({
                where: { celebrity_profile_id: celebrityProfile.id },
            }),
            prisma.celebrityReview.aggregate({
                where: { celebrity_profile_id: celebrityProfile.id },
                _avg: { rating: true },
                _count: { rating: true },
            }),
        ]);

        return res.json({
            successful: true,
            data: reviews,
            averageRating: aggregate._avg.rating || 0,
            totalReviews: aggregate._count.rating || 0,
            pagination: {
                total,
                limit: take,
                offset: skip,
                totalPages: Math.ceil(total / take),
            },
        });
    } catch (error) {
        console.error('Get My Celebrity Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch celebrity reviews.',
        });
    }
});

export default router; 