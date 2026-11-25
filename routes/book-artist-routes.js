// book-artist-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import Stripe from 'stripe';
import { creditArtistBookingOnPaid } from '../utils/artist-booking-settlement.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

// Reusable public artist info select
const publicArtistSelect = {
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
// Artist Profile Routes
// =========================================

/**
 * Create Artist Profile
 * POST /artist/profile
 */
router.post('/profile', authenticateToken, async (req, res) => {
    try {
        const {
            display_name,
            artist_bio,
            tagline,
            country,
            city,
            languages,
            genres,
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

        if (!Array.isArray(genres)) {
            return res.status(400).json({
                successful: false,
                message: 'genres must be an array.',
            });
        }

        const existingProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (existingProfile) {
            return res.status(409).json({
                successful: false,
                message: 'Artist profile already exists.',
            });
        }

        const artistProfile = await prisma.$transaction(async (tx) => {
            const profile = await tx.artistProfile.create({
                data: {
                    user_id: req.user.user_id,
                    display_name: display_name.trim(),
                    artist_bio: artist_bio?.trim() || null,
                    tagline: tagline?.trim() || null,
                    country: country?.trim() || null,
                    city: city?.trim() || null,
                    languages,
                    genres,
                    profile_image: profile_image || null,
                    cover_image: cover_image || null,
                    status: 'PENDING',
                },
            });

            await tx.artistWallet.create({
                data: {
                    artist_profile_id: profile.id,
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
            message: 'Artist profile created successfully.',
            data: artistProfile,
        });
    } catch (error) {
        console.error('Create Artist Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create artist profile.',
        });
    }
});

/**
 * Get My Artist Profile
 * GET /artist/profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        return res.json({
            successful: true,
            data: artistProfile,
        });
    } catch (error) {
        console.error('Get Artist Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch artist profile.',
        });
    }
});

/**
 * Update My Artist Profile
 * PUT /artist/profile
 */
router.put('/profile', authenticateToken, async (req, res) => {
    try {
        const existingProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!existingProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const {
            display_name,
            artist_bio,
            tagline,
            country,
            city,
            languages,
            genres,
            profile_image,
            cover_image,
        } = req.body;

        const updatedProfile = await prisma.artistProfile.update({
            where: { user_id: req.user.user_id },
            data: {
                display_name: display_name ?? existingProfile.display_name,
                artist_bio: artist_bio ?? existingProfile.artist_bio,
                tagline: tagline ?? existingProfile.tagline,
                country: country ?? existingProfile.country,
                city: city ?? existingProfile.city,
                languages: languages ?? existingProfile.languages,
                genres: genres ?? existingProfile.genres,
                profile_image: profile_image ?? existingProfile.profile_image,
                cover_image: cover_image ?? existingProfile.cover_image,
            },
        });

        return res.json({
            successful: true,
            message: 'Artist profile updated successfully.',
            data: updatedProfile,
        });
    } catch (error) {
        console.error('Update Artist Profile Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update artist profile.',
        });
    }
});

// =========================================
// Artist Listing Routes
// =========================================

/**
 * Create an artist listing
 * POST /artist/listings
 */
router.post('/listings', authenticateToken, async (req, res) => {
    try {
        const {
            title,
            description,
            category,
            genre,
            location,
            instant_book,
            requires_deposit,
            deposit_amount,
            cleaning_fee,
            service_fee_pct,
            images,
            packages,
        } = req.body;

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found. Please create your profile first.',
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

        if (!genre || !genre.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'genre is required.',
            });
        }

        if (!packages || !Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({
                successful: false,
                message: 'At least one package is required.',
            });
        }

        if (packages.length > 5) {
            return res.status(400).json({
                successful: false,
                message: 'Maximum 5 packages allowed per listing.',
            });
        }

        for (const pkg of packages) {
            if (!pkg.title || !pkg.title.trim()) {
                return res.status(400).json({
                    successful: false,
                    message: 'Each package must have a title.',
                });
            }
            if (!pkg.duration_minutes || isNaN(pkg.duration_minutes) || pkg.duration_minutes <= 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Each package must have a valid duration greater than 0.',
                });
            }
            if (!pkg.price || isNaN(pkg.price) || pkg.price <= 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Each package must have a valid price greater than 0.',
                });
            }
        }

        const listing = await prisma.artistListing.create({
            data: {
                artist_profile_id: artistProfile.id,
                title: title.trim(),
                description: description.trim(),
                category: category.trim(),
                genre: genre.trim(),
                location: location?.trim() || null,
                instant_book: instant_book || false,
                requires_deposit: requires_deposit || false,
                deposit_amount: deposit_amount || null,
                cleaning_fee: cleaning_fee || null,
                service_fee_pct: service_fee_pct || null,
                images: images || [],
                status: 'DRAFT',
                packages: {
                    create: packages.map(pkg => ({
                        title: pkg.title.trim(),
                        description: pkg.description?.trim() || null,
                        duration_minutes: pkg.duration_minutes,
                        price: pkg.price,
                        is_active: pkg.is_active !== undefined ? pkg.is_active : true,
                    })),
                },
            },
            include: {
                packages: true,
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Listing created successfully.',
            data: listing,
        });
    } catch (error) {
        console.error('Create Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create listing.',
        });
    }
});

/**
 * Get my listings (artist's own listings)
 * GET /artist/listings/my-listings
 */
router.get('/listings/my-listings', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const listings = await prisma.artistListing.findMany({
            where: {
                artist_profile_id: artistProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
            orderBy: {
                created_at: 'desc',
            },
            include: {
                packages: {
                    where: {
                        is_active: true,
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

        const listingsWithStats = await Promise.all(
            listings.map(async (listing) => {
                const avg = await prisma.artistReview.aggregate({
                    where: {
                        listing_id: listing.id,
                    },
                    _avg: {
                        rating: true,
                    },
                });

                return {
                    ...listing,
                    averageRating: avg._avg.rating ?? 0,
                };
            })
        );

        return res.json({
            successful: true,
            data: listingsWithStats,
        });
    } catch (error) {
        console.error('Get My Listings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your listings.',
        });
    }
});

/**
 * Get all active artist listings (public view)
 * GET /artist/listings
 */
router.get('/listings', authenticateToken, async (req, res) => {
    try {
        const {
            category,
            genre,
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

        if (genre) {
            where.genre = {
                equals: genre,
                mode: 'insensitive',
            };
        }

        if (search) {
            where.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } },
            ];
        }

        const take = parseInt(limit) || 10;
        const skip = parseInt(offset) || 0;

        let orderBy = {};
        switch (sortBy) {
            case 'most_ordered':
                orderBy = {
                    bookings: {
                        _count: 'desc',
                    },
                };
                break;
            case 'oldest':
                orderBy = {
                    created_at: 'asc',
                };
                break;
            case 'recent':
            default:
                orderBy = {
                    created_at: 'desc',
                };
                break;
        }

        const total = await prisma.artistListing.count({ where });

        const listings = await prisma.artistListing.findMany({
            where,
            take,
            skip,
            orderBy,
            include: {
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                packages: {
                    where: {
                        is_active: true,
                    },
                    orderBy: {
                        price: 'asc',
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
                const avg = await prisma.artistReview.aggregate({
                    where: {
                        listing_id: listing.id,
                    },
                    _avg: {
                        rating: true,
                    },
                });

                return {
                    ...listing,
                    averageRating: avg._avg.rating ?? 0,
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
        console.error('Get Listings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch listings.',
        });
    }
});

/**
 * Get listing by ID with packages
 * GET /artist/listings/:id
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

        const listing = await prisma.artistListing.findUnique({
            where: {
                id: listingId,
            },
            include: {
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                packages: {
                    where: {
                        is_active: true,
                    },
                    orderBy: {
                        price: 'asc',
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
                message: 'Listing not found.',
            });
        }

        const avg = await prisma.artistReview.aggregate({
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
        console.error('Get Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch listing.',
        });
    }
});

/**
 * Update listing
 * PUT /artist/listings/:id
 */
router.put('/listings/:id', authenticateToken, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);

        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid listing ID.',
            });
        }

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const existingListing = await prisma.artistListing.findFirst({
            where: {
                id: listingId,
                artist_profile_id: artistProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
            include: {
                packages: true,
            },
        });

        if (!existingListing) {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found or you do not have permission to edit it.',
            });
        }

        const {
            title,
            description,
            category,
            genre,
            location,
            instant_book,
            requires_deposit,
            deposit_amount,
            cleaning_fee,
            service_fee_pct,
            images,
            packages,
            status,
        } = req.body;

        const validStatuses = ['ACTIVE', 'PAUSED', 'DRAFT'];
        if (status && !validStatuses.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
        }

        const updatedListing = await prisma.$transaction(async (tx) => {
            const listing = await tx.artistListing.update({
                where: { id: listingId },
                data: {
                    title: title?.trim() || existingListing.title,
                    description: description?.trim() || existingListing.description,
                    category: category?.trim() || existingListing.category,
                    genre: genre?.trim() || existingListing.genre,
                    location: location?.trim() || existingListing.location,
                    instant_book: instant_book !== undefined ? instant_book : existingListing.instant_book,
                    requires_deposit: requires_deposit !== undefined ? requires_deposit : existingListing.requires_deposit,
                    deposit_amount: deposit_amount !== undefined ? deposit_amount : existingListing.deposit_amount,
                    cleaning_fee: cleaning_fee !== undefined ? cleaning_fee : existingListing.cleaning_fee,
                    service_fee_pct: service_fee_pct !== undefined ? service_fee_pct : existingListing.service_fee_pct,
                    images: images || existingListing.images,
                    status: status || existingListing.status,
                },
            });

            if (packages && Array.isArray(packages)) {
                if (packages.length > 5) {
                    throw new Error('Maximum 5 packages allowed per listing.');
                }

                for (const pkg of packages) {
                    if (!pkg.title || !pkg.title.trim()) {
                        throw new Error('Each package must have a title.');
                    }
                    if (!pkg.duration_minutes || isNaN(pkg.duration_minutes) || pkg.duration_minutes <= 0) {
                        throw new Error('Each package must have a valid duration greater than 0.');
                    }
                    if (!pkg.price || isNaN(pkg.price) || pkg.price <= 0) {
                        throw new Error('Each package must have a valid price greater than 0.');
                    }
                }

                await tx.artistPackage.deleteMany({
                    where: { artist_listing_id: listingId },
                });

                await tx.artistPackage.createMany({
                    data: packages.map(pkg => ({
                        artist_listing_id: listingId,
                        title: pkg.title.trim(),
                        description: pkg.description?.trim() || null,
                        duration_minutes: pkg.duration_minutes,
                        price: pkg.price,
                        is_active: pkg.is_active !== undefined ? pkg.is_active : true,
                    })),
                });
            }

            return tx.artistListing.findUnique({
                where: { id: listingId },
                include: {
                    packages: {
                        where: { is_active: true },
                        orderBy: { price: 'asc' },
                    },
                },
            });
        });

        return res.json({
            successful: true,
            message: 'Listing updated successfully.',
            data: updatedListing,
        });
    } catch (error) {
        console.error('Update Listing Error:', error);
        if (error.message === 'Maximum 5 packages allowed per listing.' ||
            error.message === 'Each package must have a title.' ||
            error.message === 'Each package must have a valid duration greater than 0.' ||
            error.message === 'Each package must have a valid price greater than 0.') {
            return res.status(400).json({
                successful: false,
                message: error.message,
            });
        }
        return res.status(500).json({
            successful: false,
            message: 'Failed to update listing.',
        });
    }
});

/**
 * Delete listing (soft delete)
 * DELETE /artist/listings/:id
 */
router.delete('/listings/:id', authenticateToken, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);

        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid listing ID.',
            });
        }

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const existingListing = await prisma.artistListing.findFirst({
            where: {
                id: listingId,
                artist_profile_id: artistProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
        });

        if (!existingListing) {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found or you do not have permission to delete it.',
            });
        }

        const deletedListing = await prisma.artistListing.update({
            where: { id: listingId },
            data: {
                status: 'DELETED',
            },
        });

        return res.json({
            successful: true,
            message: 'Listing deleted successfully.',
            data: deletedListing,
        });
    } catch (error) {
        console.error('Delete Listing Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to delete listing.',
        });
    }
});

/**
 * Update listing status (Publish/Unpublish)
 * PATCH /artist/listings/:id/status
 */
router.patch('/listings/:id/status', authenticateToken, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);
        const { status } = req.body;

        if (isNaN(listingId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid listing ID.',
            });
        }

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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const existingListing = await prisma.artistListing.findFirst({
            where: {
                id: listingId,
                artist_profile_id: artistProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
        });

        if (!existingListing) {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found or you do not have permission to update it.',
            });
        }

        // Can't publish a listing without packages
        if (status === 'ACTIVE') {
            const packages = await prisma.artistPackage.count({
                where: {
                    artist_listing_id: listingId,
                    is_active: true,
                },
            });

            if (packages === 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Cannot publish a listing without any packages.',
                });
            }
        }

        const updatedListing = await prisma.artistListing.update({
            where: {
                id: listingId,
            },
            data: {
                status: status,
            },
            include: {
                packages: {
                    where: {
                        is_active: true,
                    },
                },
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
// Artist Booking Routes
// =========================================

/**
 * Create a booking request (buyer)
 * POST /artist/bookings
 */
router.post('/bookings', authenticateToken, async (req, res) => {
    try {
        const {
            listing_id,
            package_id,
            event_name,
            event_date,
            event_time,
            expected_guests,
            event_location,
            notes,
            referral_code,
        } = req.body;

        const listingId = parseInt(listing_id);
        const packageId = parseInt(package_id);

        if (isNaN(listingId) || isNaN(packageId)) {
            return res.status(400).json({
                successful: false,
                message: 'Valid listing_id and package_id are required.',
            });
        }

        if (!event_date) {
            return res.status(400).json({
                successful: false,
                message: 'event_date is required.',
            });
        }

        if (!event_location || !event_location.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'event_location is required.',
            });
        }

        const listing = await prisma.artistListing.findUnique({
            where: { id: listingId },
            include: {
                packages: {
                    where: {
                        id: packageId,
                        is_active: true,
                    },
                },
            },
        });

        if (!listing || listing.status !== 'ACTIVE') {
            return res.status(404).json({
                successful: false,
                message: 'Listing not found or not active.',
            });
        }

        // Find the selected package from the listing's packages
        const selectedPackage = listing.packages.find(pkg => pkg.id === packageId);
        if (!selectedPackage) {
            return res.status(400).json({
                successful: false,
                message: 'Package not found or not active.',
            });
        }

        // Check if user is trying to book their own listing
        const ownArtistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (ownArtistProfile && ownArtistProfile.id === listing.artist_profile_id) {
            return res.status(400).json({
                successful: false,
                message: 'You cannot book your own listing.',
            });
        }

        // Get or create buyer profile
        const buyerProfile = await prisma.artistBuyerProfile.upsert({
            where: { user_id: req.user.user_id },
            update: {},
            create: { user_id: req.user.user_id },
        });

        // Calculate price (use package price, or deposit if required)
        let price = parseFloat(selectedPackage.price);
        if (listing.requires_deposit && listing.deposit_amount) {
            price = parseFloat(listing.deposit_amount);
        }

        // Create booking with all the provided data
        const booking = await prisma.artistBooking.create({
            data: {
                buyer_profile_id: buyerProfile.id,
                artist_profile_id: listing.artist_profile_id,
                artist_listing_id: listingId,
                package_id: packageId,
                event_name: event_name?.trim() || null,
                event_date: new Date(event_date),
                event_time: event_time?.trim() || null,
                expected_guests: expected_guests ? parseInt(expected_guests) : null,
                event_location: event_location.trim(),
                notes: notes?.trim() || null,
                referral_code: referral_code?.trim() || null,
                price: price,
                status: 'PENDING',
                payment_status: 'PENDING',
            },
            include: {
                package: true,
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Booking request created successfully. Waiting for artist approval.',
            data: booking,
        });
    } catch (error) {
        console.error('Create Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create booking request.',
        });
    }
});

/**
 * Get my bookings (as buyer)
 * GET /artist/bookings/my-bookings
 */
router.get('/bookings/my-bookings', authenticateToken, async (req, res) => {
    try {
        const buyerProfile = await prisma.artistBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.json({ successful: true, data: [] });
        }

        const bookings = await prisma.artistBooking.findMany({
            where: { buyer_profile_id: buyerProfile.id },
            include: {
                package: true,
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                review: true,
            },
            orderBy: { created_at: 'desc' },
        });

        return res.json({ successful: true, data: bookings });
    } catch (error) {
        console.error('Get My Bookings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your bookings.',
        });
    }
});

/**
 * Get received bookings (as artist)
 * GET /artist/bookings/received-bookings
 */
router.get('/bookings/received-bookings', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const bookings = await prisma.artistBooking.findMany({
            where: { artist_profile_id: artistProfile.id },
            include: {
                package: true,
                buyer_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                review: true,
            },
            orderBy: { created_at: 'desc' },
        });

        return res.json({ successful: true, data: bookings });
    } catch (error) {
        console.error('Get Received Bookings Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch received bookings.',
        });
    }
});

/**
 * Get single booking by ID (with self-heal)
 * GET /artist/bookings/:id
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

        let booking = await prisma.artistBooking.findUnique({
            where: { id: bookingId },
            include: {
                package: true,
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                review: true,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found.',
            });
        }

        // SELF-HEAL: If booking is PENDING but has a payment intent, check Stripe
        if (booking.payment_status === 'PENDING' && booking.stripe_payment_intent_id && stripe) {
            try {
                const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
                if (pi.status === 'succeeded') {
                    // Self-heal: flip PENDING->PAID AND credit the artist wallet, exactly once
                    // (shared with the canonical webhook; the atomic guard prevents a double
                    // credit if the webhook and this GET race). A bare status update here was
                    // the bug: /complete later decrements pending_balance that was never credited.
                    await creditArtistBookingOnPaid(booking);

                    // Reload the booking with all includes
                    booking = await prisma.artistBooking.findUnique({
                        where: { id: bookingId },
                        include: {
                            package: true,
                            artist_profile: {
                                include: {
                                    user: {
                                        select: publicArtistSelect,
                                    },
                                },
                            },
                            artist_listing: {
                                select: {
                                    id: true,
                                    title: true,
                                    images: true,
                                },
                            },
                            buyer_profile: {
                                include: {
                                    user: {
                                        select: publicArtistSelect,
                                    },
                                },
                            },
                            review: true,
                        },
                    });

                    console.log(`Self-healed booking ${booking.id} from PENDING to PAID`);
                }
            } catch (error) {
                console.error('Failed to verify payment status with Stripe:', error);
                // Don't fail the request, just log the error
            }
        }

        const [buyerProfile, artistProfile] = await Promise.all([
            prisma.artistBuyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.artistProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const isBuyer = buyerProfile && buyerProfile.id === booking.buyer_profile_id;
        const isArtist = artistProfile && artistProfile.id === booking.artist_profile_id;

        if (!isBuyer && !isArtist) {
            return res.status(403).json({
                successful: false,
                message: 'You do not have permission to view this booking.',
            });
        }

        return res.json({ successful: true, data: booking });
    } catch (error) {
        console.error('Get Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch booking.',
        });
    }
});

/**
 * Artist approves a booking request
 * PATCH /artist/bookings/:id/approve
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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const existingBooking = await prisma.artistBooking.findFirst({
            where: {
                id: bookingId,
                artist_profile_id: artistProfile.id,
            },
        });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to approve it.',
            });
        }

        if (existingBooking.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending bookings can be approved.',
            });
        }

        const updatedBooking = await prisma.artistBooking.update({
            where: { id: bookingId },
            data: {
                status: 'ACCEPTED',
            },
            include: {
                package: true,
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
            },
        });

        return res.json({
            successful: true,
            message: 'Booking approved. Buyer can now complete the payment.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Approve Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to approve booking.',
        });
    }
});

/**
 * Artist rejects a booking request
 * PATCH /artist/bookings/:id/reject
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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const existingBooking = await prisma.artistBooking.findFirst({
            where: {
                id: bookingId,
                artist_profile_id: artistProfile.id,
            },
        });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to reject it.',
            });
        }

        if (existingBooking.status !== 'PENDING') {
            return res.status(400).json({
                successful: false,
                message: 'Only pending bookings can be rejected.',
            });
        }

        const updatedBooking = await prisma.artistBooking.update({
            where: { id: bookingId },
            data: {
                status: 'REJECTED',
                payment_status: 'CANCELLED',
            },
            include: {
                package: true,
                artist_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
                artist_listing: {
                    select: {
                        id: true,
                        title: true,
                        images: true,
                    },
                },
                buyer_profile: {
                    include: {
                        user: {
                            select: publicArtistSelect,
                        },
                    },
                },
            },
        });

        return res.json({
            successful: true,
            message: 'Booking rejected.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Reject Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to reject booking.',
        });
    }
});

/**
 * Buyer completes payment for an approved booking
 * POST /artist/bookings/:id/pay (with idempotency guard)
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

        const buyerProfile = await prisma.artistBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const booking = await prisma.artistBooking.findFirst({
            where: {
                id: bookingId,
                buyer_profile_id: buyerProfile.id,
            },
            include: {
                artist_listing: true,
                package: true,
                artist_profile: {
                    include: {
                        user: true,
                    },
                },
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to pay for it.',
            });
        }

        if (booking.status !== 'ACCEPTED') {
            return res.status(400).json({
                successful: false,
                message: 'Booking must be accepted by the artist before payment.',
            });
        }

        // Idempotency guard - prevent double-payment
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
                listing_title: booking.artist_listing.title,
                buyer_id: req.user.user_id,
                artist_id: booking.artist_profile_id,
            },
            receipt_email: req.user.email,
            description: `Booking: ${booking.artist_listing.title} - ${booking.package.title}`,
        });

        const updatedBooking = await prisma.artistBooking.update({
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
        console.error('Payment Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to process payment.',
        });
    }
});


/**
 * Mark booking as completed (after event) - with idempotency guard
 * PATCH /artist/bookings/:id/complete
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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const booking = await prisma.artistBooking.findFirst({
            where: {
                id: bookingId,
                artist_profile_id: artistProfile.id,
            },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to complete it.',
            });
        }

        if (booking.status !== 'ACCEPTED') {
            return res.status(400).json({
                successful: false,
                message: 'Only accepted bookings can be marked as completed.',
            });
        }

        // Idempotency guard - prevent double-completion
        if (booking.status === 'COMPLETED') {
            return res.status(400).json({
                successful: false,
                message: 'This booking has already been completed.',
            });
        }

        if (booking.payment_status !== 'PAID') {
            return res.status(400).json({
                successful: false,
                message: 'Booking must be paid before it can be completed.',
            });
        }

        const [updatedBooking] = await prisma.$transaction(async (tx) => {
            // Update booking status
            const updated = await tx.artistBooking.update({
                where: { id: bookingId },
                data: {
                    status: 'COMPLETED',
                    completed_at: new Date(),
                },
            });

            // Update artist profile total bookings
            await tx.artistProfile.update({
                where: { id: booking.artist_profile_id },
                data: {
                    total_bookings: {
                        increment: 1,
                    },
                },
            });

            // Get the wallet and update pending balance to available
            const wallet = await tx.artistWallet.findUnique({
                where: { artist_profile_id: booking.artist_profile_id },
            });

            if (wallet) {
                // Move from pending to available
                await tx.artistWallet.update({
                    where: { id: wallet.id },
                    data: {
                        pending_balance: { decrement: booking.price },
                        available_balance: { increment: booking.price },
                        total_earned: { increment: booking.price },
                    },
                });

                // Update the transaction status to AVAILABLE
                await tx.artistWalletTransaction.updateMany({
                    where: {
                        wallet_id: wallet.id,
                        booking_id: booking.id,
                        type: 'BOOKING',
                    },
                    data: {
                        status: 'AVAILABLE',
                        available_at: new Date(),
                    },
                });
            }

            return [updated];
        });

        return res.json({
            successful: true,
            message: 'Booking completed successfully. Payment has been credited to your wallet.',
            data: updatedBooking,
        });
    } catch (error) {
        console.error('Complete Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to complete booking.',
        });
    }
});

/**
 * Cancel a booking (buyer or artist). Only allowed while still PENDING
 * PATCH /artist/bookings/:id/cancel
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

        const [buyerProfile, artistProfile] = await Promise.all([
            prisma.artistBuyerProfile.findUnique({ where: { user_id: req.user.user_id } }),
            prisma.artistProfile.findUnique({ where: { user_id: req.user.user_id } }),
        ]);

        const existingBooking = await prisma.artistBooking.findUnique({ where: { id: bookingId } });

        if (!existingBooking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found.',
            });
        }

        const isBuyer = buyerProfile && buyerProfile.id === existingBooking.buyer_profile_id;
        const isArtist = artistProfile && artistProfile.id === existingBooking.artist_profile_id;

        if (!isBuyer && !isArtist) {
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

        // Cancel Stripe payment intent if exists
        if (existingBooking.stripe_payment_intent_id && stripe) {
            try {
                await stripe.paymentIntents.cancel(existingBooking.stripe_payment_intent_id);
            } catch (stripeError) {
                console.error('Failed to cancel payment intent:', stripeError);
            }
        }

        const cancelledBooking = await prisma.artistBooking.update({
            where: { id: bookingId },
            data: {
                status: 'CANCELLED',
                payment_status: 'CANCELLED',
            },
        });

        return res.json({
            successful: true,
            message: 'Booking cancelled successfully.',
            data: cancelledBooking,
        });
    } catch (error) {
        console.error('Cancel Booking Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to cancel booking.',
        });
    }
});

// =========================================
// Artist Wallet Routes
// =========================================

/**
 * Get wallet details for the authenticated artist
 * GET /artist/wallet
 */
router.get('/wallet', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const wallet = await prisma.artistWallet.findUnique({
            where: { artist_profile_id: artistProfile.id },
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
        console.error('Get Wallet Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch wallet details.',
        });
    }
});

/**
 * Get wallet transactions
 * GET /artist/wallet/transactions
 */
router.get('/wallet/transactions', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const wallet = await prisma.artistWallet.findUnique({
            where: { artist_profile_id: artistProfile.id },
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
            prisma.artistWalletTransaction.findMany({
                where,
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    booking: {
                        include: {
                            artist_listing: {
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
            prisma.artistWalletTransaction.count({ where }),
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
        console.error('Get Transactions Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch transactions.',
        });
    }
});

/**
 * Create a withdrawal request
 * POST /artist/wallet/withdraw
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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const wallet = await prisma.artistWallet.findUnique({
            where: { artist_profile_id: artistProfile.id },
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
            const existingPending = await tx.artistWithdrawalRequest.findFirst({
                where: {
                    artist_profile_id: artistProfile.id,
                    status: 'PENDING',
                },
            });

            if (existingPending) {
                throw new Error('You already have a pending withdrawal request.');
            }

            const withdrawal = await tx.artistWithdrawalRequest.create({
                data: {
                    artist_profile_id: artistProfile.id,
                    wallet_id: wallet.id,
                    amount,
                    method: method.trim(),
                    account_title: account_title.trim(),
                    account_number: account_number.trim(),
                    status: 'PENDING',
                },
            });

            await tx.artistWallet.update({
                where: { id: wallet.id },
                data: {
                    available_balance: { decrement: amount },
                    total_withdrawn: { increment: amount },
                },
            });

            await tx.artistWalletTransaction.create({
                data: {
                    wallet_id: wallet.id,
                    amount,
                    type: 'WITHDRAWAL',
                    status: 'WITHDRAWN',
                    artist_profile_id: artistProfile.id,
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
        console.error('Withdrawal Error:', error);

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
 * GET /artist/wallet/withdrawals
 */
router.get('/wallet/withdrawals', authenticateToken, async (req, res) => {
    try {
        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const { status, limit = 20, offset = 0 } = req.query;

        const where = { artist_profile_id: artistProfile.id };
        if (status) where.status = status;

        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [withdrawals, total] = await Promise.all([
            prisma.artistWithdrawalRequest.findMany({
                where,
                take,
                skip,
                orderBy: { requested_at: 'desc' },
            }),
            prisma.artistWithdrawalRequest.count({ where }),
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
        console.error('Get Withdrawals Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch withdrawal requests.',
        });
    }
});

/**
 * Get a single withdrawal request by ID
 * GET /artist/wallet/withdrawals/:id
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

        const artistProfile = await prisma.artistProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!artistProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Artist profile not found.',
            });
        }

        const withdrawal = await prisma.artistWithdrawalRequest.findFirst({
            where: {
                id: withdrawalId,
                artist_profile_id: artistProfile.id,
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
        console.error('Get Withdrawal Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch withdrawal request.',
        });
    }
});

// =========================================
// Artist Review Routes
// =========================================

/**
 * Create a review for a completed booking
 * POST /artist/reviews
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

        const buyerProfile = await prisma.artistBuyerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!buyerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Buyer profile not found.',
            });
        }

        const booking = await prisma.artistBooking.findFirst({
            where: { id: bookingId, buyer_profile_id: buyerProfile.id },
            include: { review: true },
        });

        if (!booking) {
            return res.status(404).json({
                successful: false,
                message: 'Booking not found or you do not have permission to review it.',
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
            const createdReview = await tx.artistReview.create({
                data: {
                    booking_id: booking.id,
                    listing_id: booking.artist_listing_id,
                    buyer_profile_id: booking.buyer_profile_id,
                    artist_profile_id: booking.artist_profile_id,
                    rating: ratingNum,
                    review: reviewText?.trim() || null, 
                },
            });

            const allReviews = await tx.artistReview.aggregate({
                where: { artist_profile_id: booking.artist_profile_id },
                _avg: { rating: true },
                _count: { rating: true },
            });

            await tx.artistProfile.update({
                where: { id: booking.artist_profile_id },
                data: {
                    rating: allReviews._avg.rating || 0,
                    total_reviews: allReviews._count.rating || 0,
                },
            });

            return createdReview;
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
 * Get reviews for a listing
 * GET /artist/reviews/listing/:listingId
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
            prisma.artistReview.findMany({
                where: { listing_id: listingId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicArtistSelect },
                        },
                    },
                },
            }),
            prisma.artistReview.count({ where: { listing_id: listingId } }),
            prisma.artistReview.aggregate({
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
        console.error('Get Listing Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch listing reviews.',
        });
    }
});

/**
 * Get reviews for an artist profile
 * GET /artist/reviews/artist/:artistProfileId
 */
router.get('/reviews/artist/:artistProfileId', authenticateToken, async (req, res) => {
    try {
        const artistProfileId = parseInt(req.params.artistProfileId);
        if (isNaN(artistProfileId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid artist profile ID.',
            });
        }

        const { limit = 20, offset = 0 } = req.query;
        const take = parseInt(limit) || 20;
        const skip = parseInt(offset) || 0;

        const [reviews, total, aggregate] = await Promise.all([
            prisma.artistReview.findMany({
                where: { artist_profile_id: artistProfileId },
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    buyer_profile: {
                        select: {
                            id: true,
                            user: { select: publicArtistSelect },
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
            prisma.artistReview.count({ where: { artist_profile_id: artistProfileId } }),
            prisma.artistReview.aggregate({
                where: { artist_profile_id: artistProfileId },
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
        console.error('Get Artist Reviews Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch artist reviews.',
        });
    }
});

export default router;