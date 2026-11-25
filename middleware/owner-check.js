// middleware/owner-check.js
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';

/**

 */
export const isOwner = (modelName) => async (req, res, next) => {
    try {
        const id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;

        const record = await prisma[modelName].findUnique({
            where: { [`${modelName}_id`]: id }, // Dynamic ID checking
            select: { profile_id: true }
        });

        if (!record || record.profile_id !== profile_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized: Ownership verification failed." });
        }

        next();
    } catch (err) {
        res.status(500).json({ error: clientErrorMessage(err) });
    }
};