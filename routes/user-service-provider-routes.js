import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { applyVerticalIdentity, verticalIdentityUserInclude } from '../utils/vertical-identity.js';

const router = express.Router();

// A provider shown in the services vertical displays their `services` vertical identity.
// SECURITY: never spread the full `user` row into a provider listing — it carries plaintext
// email + KYC (document_verification_document_url) + DOB (the global Prisma omit only strips
// password). Select ONLY the public display fields applyVerticalIdentity needs.
const providerPublicUserSelect = {
    select: {
        user_id: true,
        name: true,
        ...verticalIdentityUserInclude, // vertical_profiles + social_profiles (public display only)
    },
};

/* GET ALL SERVICE PROVIDERS */
router.get('/', authenticateToken, async (_req, res) => {
    try {
        const providers = await prisma.user_service_provider.findMany({
            orderBy: { provider_id: 'desc' },
            include: {
                user: providerPublicUserSelect,
                services: true,
                service_type: true
            },
        });
        providers.forEach((p) => applyVerticalIdentity(p.user, 'services'));
        res.json(providers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch service providers' });
    }
});

/* GET PROVIDER BY ID */
router.get('/:provider_id', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        const provider = await prisma.user_service_provider.findUnique({
            where: { provider_id },
            include: {
                user: providerPublicUserSelect,
                services: true,
                service_type: true
            },
        });

        if (!provider) return res.status(404).json({ error: 'Service provider not found' });
        applyVerticalIdentity(provider.user, 'services');
        res.json(provider);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch service provider' });
    }
});

/* GET PROVIDERS BY USER ID */
router.get('/user/:user_id', async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const providers = await prisma.user_service_provider.findMany({
            where: { user_id },
            include: {
                services: true,
                service_type: true
            },
        });
        res.json(providers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch providers for user' });
    }
});

/* CREATE SERVICE PROVIDER */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { services_id, user_id, service_type_id, service_category_id } = req.body;

        const provider = await prisma.user_service_provider.create({
            data: {
                services_id,
                user_id,
                service_type_id,
                service_category_id: service_category_id ? Number(service_category_id) : undefined,
                is_active: true, // Auto-activate without admin intervention
            },
            include: {
                user: providerPublicUserSelect,
                services: true,
                service_type: true,
                service_category: true,
            },
        });

        res.status(201).json(provider);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create service provider' });
    }
});

/* UPDATE SERVICE PROVIDER */
router.put('/:provider_id', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        // user_id is intentionally NOT read from the body — a provider record can never be
        // re-owned to another user via update (that was an ownership-transfer/IDOR vector).
        const { services_id, service_type_id, service_category_id } = req.body;

        const existing = await prisma.user_service_provider.findUnique({ where: { provider_id } });
        if (!existing) return res.status(404).json({ error: 'Service provider not found' });

        // Only the owning user may edit their provider record.
        if (existing.user_id !== req.user.user_id) return res.status(403).json({ error: 'Forbidden' });

        const updated = await prisma.user_service_provider.update({
            where: { provider_id },
            data: {
                services_id: services_id ?? existing.services_id,
                service_type_id: service_type_id ?? existing.service_type_id,
                ...(service_category_id !== undefined ? { service_category_id: service_category_id ? Number(service_category_id) : null } : {}),
            },
            include: {
                user: providerPublicUserSelect,
                services: true,
                service_type: true,
                service_category: true,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update service provider' });
    }
});

/* DELETE SERVICE PROVIDER */
router.delete('/:provider_id', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        const existing = await prisma.user_service_provider.findUnique({ where: { provider_id } });
        if (!existing) return res.status(404).json({ error: 'Service provider not found' });

        // Only the owning user (or an admin) may delete a provider record.
        const admin = await prisma.admin.findFirst({ where: { user_id: req.user.user_id } });
        if (existing.user_id !== req.user.user_id && !admin) return res.status(403).json({ error: 'Forbidden' });

        await prisma.user_service_provider.delete({ where: { provider_id } });
        res.json({ message: 'Service provider deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete service provider' });
    }
});

/* ACTIVATE PROVIDER (admin only) */
router.patch('/:provider_id/activate', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        const admin = await prisma.admin.findFirst({ where: { user_id: req.user.user_id } });
        if (!admin) return res.status(403).json({ error: 'Admin access required' });

        const provider = await prisma.user_service_provider.update({
            where: { provider_id },
            data: { is_active: true },
        });
        res.json({ successful: true, message: 'Provider activated', provider });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to activate provider' });
    }
});

/* DEACTIVATE PROVIDER (admin only) */
router.patch('/:provider_id/deactivate', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        const admin = await prisma.admin.findFirst({ where: { user_id: req.user.user_id } });
        if (!admin) return res.status(403).json({ error: 'Admin access required' });

        const provider = await prisma.user_service_provider.update({
            where: { provider_id },
            data: { is_active: false },
        });
        res.json({ successful: true, message: 'Provider deactivated', provider });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to deactivate provider' });
    }
});

/* UPDATE PROVIDER LOCATION + ONLINE STATUS */
router.patch('/:provider_id/status', authenticateToken, async (req, res) => {
    try {
        const provider_id = Number(req.params.provider_id);
        if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

        const { is_online, current_lat, current_long } = req.body;

        const provider = await prisma.user_service_provider.update({
            where: { provider_id },
            data: {
                is_online: is_online ?? undefined,
                current_lat: current_lat ?? undefined,
                current_long: current_long ?? undefined,
                last_ping: new Date(),
            },
        });
        res.json({ successful: true, provider });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update provider status' });
    }
});

export default router;
