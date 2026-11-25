import prisma from '../utils/prisma-client.js';

// Verifies the authenticated user has an active provider record for the given service_type_id.
// Attaches req.provider for use in the route handler.
export const isProvider = (serviceTypeId) => async (req, res, next) => {
    try {
        const provider = await prisma.user_service_provider.findFirst({
            where: {
                user_id: req.user.user_id,
                service_type_id: serviceTypeId,
                is_active: true,
            },
        });
        if (!provider) {
            return res.status(403).json({ successful: false, error: 'Not registered as this provider type' });
        }
        req.provider = provider;
        next();
    } catch (err) {
        res.status(500).json({ successful: false, error: 'Provider check failed' });
    }
};
