import prisma from '../utils/prisma-client.js';

// Verifies the authenticated user has been activated as a shop seller.
export const isSeller = async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { user_id: req.user.user_id },
            select: { is_seller: true },
        });
        if (!user?.is_seller) {
            // Do NOT auto-grant here — that let any authenticated user silently self-promote to
            // seller just by hitting a seller-gated route. Seller access is granted only through
            // onboarding (create a store_profile) or an admin (PATCH /user/:id/activate-seller).
            return res.status(403).json({
                successful: false,
                error: 'Seller access required. Set up your store to start selling.',
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ successful: false, error: 'Seller check failed' });
    }
};
