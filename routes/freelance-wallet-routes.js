import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get wallet details for the authenticated freelancer
 * GET /freelance-wallet
 */
router.get('/', authenticateToken, async (req, res) => {
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

        const wallet = await prisma.freelancerWallet.findUnique({
            where: { freelancer_profile_id: freelancerProfile.id },
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
 * Get wallet transactions with pagination and filters
 * GET /freelance-wallet/transactions
 * Query params: type, status, limit, offset, from_date, to_date
 */
router.get('/transactions', authenticateToken, async (req, res) => {
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

        const wallet = await prisma.freelancerWallet.findUnique({
            where: { freelancer_profile_id: freelancerProfile.id },
        });

        if (!wallet) {
            return res.status(404).json({
                successful: false,
                message: 'Wallet not found.',
            });
        }

        const { 
            type, 
            status, 
            limit = 20, 
            offset = 0,
            from_date,
            to_date 
        } = req.query;

        const where = {
            wallet_id: wallet.id,
        };

        if (type) {
            where.type = type;
        }

        if (status) {
            where.status = status;
        }

        if (from_date) {
            where.created_at = {
                ...where.created_at,
                gte: new Date(from_date),
            };
        }

        if (to_date) {
            where.created_at = {
                ...where.created_at,
                lte: new Date(to_date),
            };
        }

        const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const skip = Math.max(parseInt(offset, 10) || 0, 0);

        const [transactions, total] = await Promise.all([
            prisma.freelanceWalletTransaction.findMany({
                where,
                take,
                skip,
                orderBy: { created_at: 'desc' },
                include: {
                    freelancer_order: {
                        select: {
                            id: true,
                            gig: {
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
            prisma.freelanceWalletTransaction.count({ where }),
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
 * POST /freelance-wallet/withdraw
 * Body: { amount, method, account_title, account_number }
 */
router.post('/withdraw', authenticateToken, async (req, res) => {
    try {
        const { amount, method, account_title, account_number } = req.body;

        // Validate required fields
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

        const freelancerProfile = await prisma.freelancerProfile.findUnique({
            where: { user_id: req.user.user_id },
        });

        if (!freelancerProfile) {
            return res.status(404).json({
                successful: false,
                message: 'Freelancer profile not found.',
            });
        }

        const wallet = await prisma.freelancerWallet.findUnique({
            where: { freelancer_profile_id: freelancerProfile.id },
        });

        if (!wallet) {
            return res.status(404).json({
                successful: false,
                message: 'Wallet not found.',
            });
        }

        // Create withdrawal request in a transaction. Re-check balance inside the txn via
        // updateMany(... gte amount) so concurrent withdraws cannot overdraw.
        const [withdrawalRequest] = await prisma.$transaction(async (tx) => {
            // Check if there's already a pending withdrawal request
            const existingPending = await tx.withdrawalRequest.findFirst({
                where: {
                    freelancer_profile_id: freelancerProfile.id,
                    status: 'PENDING',
                },
            });

            if (existingPending) {
                throw new Error('You already have a pending withdrawal request.');
            }

            const debited = await tx.freelancerWallet.updateMany({
                where: { id: wallet.id, available_balance: { gte: amount } },
                data: {
                    available_balance: { decrement: amount },
                    total_withdrawn: { increment: amount },
                },
            });
            if (debited.count !== 1) {
                throw new Error('Insufficient available balance.');
            }

            // Create withdrawal request
            const withdrawal = await tx.withdrawalRequest.create({
                data: {
                    freelancer_profile_id: freelancerProfile.id,
                    wallet_id: wallet.id,
                    amount,
                    method: method.trim(),
                    account_title: account_title.trim(),
                    account_number: account_number.trim(),
                    status: 'PENDING',
                },
            });

            // Create withdrawal transaction
            await tx.freelanceWalletTransaction.create({
                data: {
                    wallet_id: wallet.id,
                    amount: amount,
                    type: 'WITHDRAWAL',
                    status: 'PENDING',
                    freelancer_profile_id: freelancerProfile.id,
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
        if (error.message === 'Insufficient available balance.') {
            return res.status(400).json({
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
 * Get all withdrawal requests for the authenticated freelancer
 * GET /freelance-wallet/withdrawals
 * Query params: status, limit, offset
 */
router.get('/withdrawals', authenticateToken, async (req, res) => {
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

        const { status, limit = 20, offset = 0 } = req.query;

        const where = {
            freelancer_profile_id: freelancerProfile.id,
        };

        if (status) {
            where.status = status;
        }

        const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const skip = Math.max(parseInt(offset, 10) || 0, 0);

        const [withdrawals, total] = await Promise.all([
            prisma.withdrawalRequest.findMany({
                where,
                take,
                skip,
                orderBy: { requested_at: 'desc' },
                include: {
                    wallet: {
                        select: {
                            id: true,
                        },
                    },
                },
            }),
            prisma.withdrawalRequest.count({ where }),
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
 * GET /freelance-wallet/withdrawals/:id
 */
router.get('/withdrawals/:id', authenticateToken, async (req, res) => {
    try {
        const withdrawalId = parseInt(req.params.id);
        if (isNaN(withdrawalId)) {
            return res.status(400).json({
                successful: false,
                message: 'Invalid withdrawal ID.',
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

        const withdrawal = await prisma.withdrawalRequest.findFirst({
            where: {
                id: withdrawalId,
                freelancer_profile_id: freelancerProfile.id,
            },
            include: {
                wallet: {
                    select: {
                        id: true,
                    },
                },
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

export default router;