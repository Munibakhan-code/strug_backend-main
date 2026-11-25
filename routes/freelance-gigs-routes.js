import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Reusable "public author info" select — profile picture lives on
// social_profile.profile_pic_url, not on the user model directly.
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
 * Create a new gig
 * POST /freelance-gigs
 */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const {
            category,
            subcategory,
            title,
            description,
            images,
            packages,
        } = req.body;

        // Check if freelancer profile exists
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: {
                user_id: req.user.user_id,
            },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found. Please create your profile first.',
            });
        }

        // Validation
        if (!category || !category.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'category is required.',
            });
        }

        if (!subcategory || !subcategory.trim()) {
            return res.status(400).json({
                successful: false,
                message: 'subcategory is required.',
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

        // Validate packages
        if (!packages || !Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({
                successful: false,
                message: 'At least one package is required.',
            });
        }

        // Validate each package
        const validPackageTypes = ['BASIC', 'STANDARD', 'PREMIUM'];
        for (const pkg of packages) {
            if (!pkg.package_type || !validPackageTypes.includes(pkg.package_type)) {
                return res.status(400).json({
                    successful: false,
                    message: `Invalid package_type. Must be one of: ${validPackageTypes.join(', ')}`,
                });
            }
            if (!pkg.price || isNaN(pkg.price) || pkg.price <= 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'Each package must have a valid price greater than 0.',
                });
            }
            if (!pkg.description || !pkg.description.trim()) {
                return res.status(400).json({
                    successful: false,
                    message: 'Each package must have a description.',
                });
            }
            // Check for duplicate package types
            const duplicate = packages.filter(p => p.package_type === pkg.package_type).length > 1;
            if (duplicate) {
                return res.status(400).json({
                    successful: false,
                    message: `Duplicate package_type: ${pkg.package_type}`,
                });
            }
        }

        // Create gig
        const gig = await prisma.gig.create({
            data: {
                freelancer_profile_id: freelancerProfile.id,
                Freelance_Category: category.trim(),
                Freelance_SubCategory: subcategory.trim(),
                title: title.trim(),
                description: description.trim(),
                images: images || [],
                packages: packages,
                status: 'DRAFT', // Default status
            },
        });

        return res.status(201).json({
            successful: true,
            message: 'Gig created successfully.',
            data: gig,
        });
    } catch (error) {
        console.error('Create Gig Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to create gig.',
        });
    }
});

/**
 * Get my gigs (freelancer's own gigs)
 * GET /freelance-gigs/my-gigs
 */
router.get('/my-gigs', authenticateToken, async (req, res) => {
    try {
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: {
                user_id: req.user.user_id,
            },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        const gigs = await prisma.gig.findMany({
            where: {
                freelancer_profile_id: freelancerProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
            orderBy: {
                created_at: 'desc',
            },
            include: {
                _count: {
                    select: {
                        reviews: true,
                        orders: true,
                    },
                },
            },
        });

        const gigsWithRatings = await Promise.all(
            gigs.map(async (gig) => {
                const avg = await prisma.review.aggregate({
                    where: {
                        gig_id: gig.id,
                    },
                    _avg: {
                        rating: true,
                    },
                });

                return {
                    ...gig,
                    averageRating: avg._avg.rating ?? 0,
                    totalReviews: gig._count.reviews,
                    totalOrders: gig._count.orders,
                };
            })
        );

        return res.json({
            successful: true,
            data: gigsWithRatings,
        });
    } catch (error) {
        console.error('Get My Gigs Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch your gigs.',
        });
    }
});

/**
 * Get all active gigs (public view) 
 * GET /freelance-gigs
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const {
            category,
            subcategory,
            search,
            status,
            limit = 6,  // Default 6 items per page
            offset = 0,
            sortBy = 'created_at',
            sortOrder = 'desc'
        } = req.query;

        const where = {
            status: 'ACTIVE',
        };

        if (category) {
            where.Freelance_Category = {
                equals: category,
                mode: 'insensitive',
            };
        }

        if (subcategory) {
            where.Freelance_SubCategory = {
                equals: subcategory,
                mode: 'insensitive',
            };
        }

        if (search) {
            where.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
            ];
        }

        if (status && ['ACTIVE', 'PAUSED', 'DRAFT'].includes(status)) {
            where.status = status;
        }

        const take = parseInt(limit) || 6;
        const skip = parseInt(offset) || 0;

        // Build orderBy
        let orderBy = {};
        switch (sortBy) {
            case 'reviews':
                orderBy = {
                    reviews: {
                        _count: sortOrder
                    }
                };
                break;
            case 'orders':
                orderBy = {
                    orders: {
                        _count: sortOrder
                    }
                };
                break;
            case 'created_at':
            default:
                orderBy = {
                    created_at: sortOrder === 'asc' ? 'asc' : 'desc'
                };
                break;
        }

        // Get total count for pagination
        const total = await prisma.gig.count({ where });

        const gigs = await prisma.gig.findMany({
            where,
            take,
            skip,
            orderBy: orderBy,
            include: {
                freelancer_profile: {
                    include: {
                        user: {
                            select: publicUserSelect,
                        },
                    },
                },
                _count: {
                    select: {
                        reviews: true,
                        orders: true,
                    },
                },
            },
        });

        // Get ratings for each gig
        let gigsWithRatings = await Promise.all(
            gigs.map(async (gig) => {
                const avg = await prisma.review.aggregate({
                    where: {
                        gig_id: gig.id,
                    },
                    _avg: {
                        rating: true,
                    },
                });

                return {
                    ...gig,
                    averageRating: avg._avg.rating ?? 0,
                    totalReviews: gig._count.reviews,
                    totalOrders: gig._count.orders,
                };
            })
        );

        return res.json({
            successful: true,
            data: gigsWithRatings,
            pagination: {
                total,
                limit: take,
                offset: skip,
                totalPages: Math.ceil(total / take),
            },
        });
    } catch (error) {
        console.error('Get Gigs Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch gigs.',
        });
    }
});


/**
 * Get gig by ID
 * GET /freelance-gigs/:id
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const gigId = parseInt(req.params.id);

        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid gig ID.',
            });
        }

        const gig = await prisma.gig.findUnique({
            where: {
                id: gigId,
            },
            include: {
                freelancer_profile: {
                    include: {
                        user: {
                            select: publicUserSelect,
                        },
                    },
                },
                // Order -> review is a singular relation (review_id is unique on Order),
                // not a "reviews" list, so this must be `review`, not `reviews`.
                orders: {
                    where: {
                        status: 'COMPLETED',
                    },
                    select: {
                        review: {
                            select: {
                                rating: true,
                                review: true,
                                buyer_profile: {
                                    include: {
                                        user: {
                                            select: {
                                                username: true,
                                                social_profiles: {
                                                    select: {
                                                        profile_pic_url: true,
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                _count: {
                    select: {
                        reviews: true,
                        orders: true,
                    },
                },
            },
        });

        if (!gig) {
            return res.status(404).json({
                successful: false,
                message: 'Gig not found.',
            });
        }

        // Calculate average rating from each order's single review (skip orders
        // that were completed but never reviewed).
        let averageRating = 0;

        if (gig.orders) {
            const allReviews = gig.orders
                .map(order => order.review)
                .filter(Boolean);

            if (allReviews.length > 0) {
                const sum = allReviews.reduce(
                    (acc, review) => acc + review.rating,
                    0
                );
                averageRating = sum / allReviews.length;
            }
        }

        return res.json({
            successful: true,
            data: {
                ...gig,
                averageRating,
                totalReviews: gig._count.reviews,
                totalOrders: gig._count.orders,
            },
        });
    } catch (error) {
        console.error('Get Gig Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to fetch gig.',
        });
    }
});

/**
 * Update gig
 * PUT /freelance-gigs/:id
 */
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const gigId = parseInt(req.params.id);

        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid gig ID.',
            });
        }

        // Get freelancer profile
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: {
                user_id: req.user.user_id,
            },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        // Check if gig exists and belongs to the freelancer
        const existingGig = await prisma.gig.findFirst({
            where: {
                id: gigId,
                freelancer_profile_id: freelancerProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
        });

        if (!existingGig) {
            return res.status(404).json({
                successful: false,
                message: 'Gig not found or you do not have permission to edit it.',
            });
        }

        const {
            category,
            subcategory,
            title,
            description,
            images,
            packages,
            status,
        } = req.body;

        // Validate status if provided
        const validStatuses = ['ACTIVE', 'PAUSED', 'DRAFT'];
        if (status && !validStatuses.includes(status)) {
            return res.status(400).json({
                successful: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
        }

        // Validate packages if provided
        if (packages) {
            if (!Array.isArray(packages) || packages.length === 0) {
                return res.status(400).json({
                    successful: false,
                    message: 'At least one package is required.',
                });
            }

            const validPackageTypes = ['BASIC', 'STANDARD', 'PREMIUM'];
            for (const pkg of packages) {
                if (!pkg.package_type || !validPackageTypes.includes(pkg.package_type)) {
                    return res.status(400).json({
                        successful: false,
                        message: `Invalid package_type. Must be one of: ${validPackageTypes.join(', ')}`,
                    });
                }
                if (!pkg.price || isNaN(pkg.price) || pkg.price <= 0) {
                    return res.status(400).json({
                        successful: false,
                        message: 'Each package must have a valid price greater than 0.',
                    });
                }
                if (!pkg.description || !pkg.description.trim()) {
                    return res.status(400).json({
                        successful: false,
                        message: 'Each package must have a description.',
                    });
                }
            }
        }

        // Update gig
        const updatedGig = await prisma.gig.update({
            where: {
                id: gigId,
            },
            data: {
                Freelance_Category: category?.trim() || existingGig.Freelance_Category,
                Freelance_SubCategory: subcategory?.trim() || existingGig.Freelance_SubCategory,
                title: title?.trim() || existingGig.title,
                description: description?.trim() || existingGig.description,
                images: images || existingGig.images,
                packages: packages || existingGig.packages,
                status: status || existingGig.status,
            },
        });

        return res.json({
            successful: true,
            message: 'Gig updated successfully.',
            data: updatedGig,
        });
    } catch (error) {
        console.error('Update Gig Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update gig.',
        });
    }
});

/**
 * Delete gig (soft delete)
 * DELETE /freelance-gigs/:id
 */
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const gigId = parseInt(req.params.id);

        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid gig ID.',
            });
        }

        // Get freelancer profile
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: {
                user_id: req.user.user_id,
            },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        // Check if gig exists and belongs to the freelancer
        const existingGig = await prisma.gig.findFirst({
            where: {
                id: gigId,
                freelancer_profile_id: freelancerProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
        });

        if (!existingGig) {
            return res.status(404).json({
                successful: false,
                message: 'Gig not found or you do not have permission to delete it.',
            });
        }

        // Soft delete by updating status
        const deletedGig = await prisma.gig.update({
            where: {
                id: gigId,
            },
            data: {
                status: 'DELETED',
            },
        });

        return res.json({
            successful: true,
            message: 'Gig deleted successfully.',
            data: deletedGig,
        });
    } catch (error) {
        console.error('Delete Gig Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to delete gig.',
        });
    }
});

/**
 * Change gig status
 * PATCH /freelance-gigs/:id/status
 */
router.patch('/:id/status', authenticateToken, async (req, res) => {
    try {
        const gigId = parseInt(req.params.id);
        const { status } = req.body;

        if (isNaN(gigId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid gig ID.',
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

        // Get freelancer profile
        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: {
                user_id: req.user.user_id,
            },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        // Check if gig exists and belongs to the freelancer
        const existingGig = await prisma.gig.findFirst({
            where: {
                id: gigId,
                freelancer_profile_id: freelancerProfile.id,
                NOT: {
                    status: 'DELETED',
                },
            },
        });

        if (!existingGig) {
            return res.status(404).json({
                successful: false,
                message: 'Gig not found or you do not have permission to update it.',
            });
        }

        const updatedGig = await prisma.gig.update({
            where: {
                id: gigId,
            },
            data: {
                status,
            },
        });

        return res.json({
            successful: true,
            message: `Gig status updated to ${status}.`,
            data: updatedGig,
        });
    } catch (error) {
        console.error('Update Gig Status Error:', error);
        return res.status(500).json({
            successful: false,
            message: 'Failed to update gig status.',
        });
    }
});

export default router;