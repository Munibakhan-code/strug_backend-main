import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { selectBestAd } from '../utils/ads-delivery-engine.js';
import { calculateHaversineDistance } from '../utils/ad-context-harvester.js';


const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SERVICES */
router.get('/', async (req, res) => {
  try {
    const [services, activeAd] = await Promise.all([
      prisma.services.findMany({
        orderBy: { services_id: 'desc' },
        include: {
          service_category: true,
          service_type: true,
          user_service_provider: true,
        },
      }),
      selectBestAd(req.adContext).catch(() => null)
    ]);

    let filtered = services;

    if (activeAd) {
      const adProvider = await prisma.user_service_provider.findFirst({
        where: { user_id: activeAd.advertiser_id, is_active: true },
        include: {
          services: {
            include: { service_category: true, service_type: true }
          },
          user: true
        }
      });

      if (adProvider && adProvider.services) {
        let distance = null;
        if (req.adContext?.latitude && req.adContext?.longitude && adProvider.current_lat && adProvider.current_long) {
          distance = calculateHaversineDistance(
            req.adContext.latitude,
            req.adContext.longitude,
            adProvider.current_lat,
            adProvider.current_long
          );
        }

        const promotedServiceCard = {
          ...adProvider.services,
          services_id: adProvider.services.services_id,
          service_name: activeAd.headline || adProvider.services.service_name,
          amount: activeAd.bid_amount,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || "BOOK_NOW",
          distance_km: distance,
          sponsored: true,
          is_generic_ad: false
        };

        filtered.unshift(promotedServiceCard);
      } else {
        const genericAdCard = {
          services_id: `ad_${activeAd.campaign_id}`,
          service_name: activeAd.headline || activeAd.title,
          amount: activeAd.bid_amount,
          duration: null,
          description: activeAd.description,
          service_category_id: null,
          expire_duration: null,
          service_type_id: null,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || "LEARN_MORE",
          sponsored: true,
          is_generic_ad: true,
          service_category: null,
          service_type: null,
          user_service_provider: [
            {
              provider_id: `prov_${activeAd.campaign_id}`,
              user_id: activeAd.advertiser_id,
              is_active: true,
              is_online: true,
              current_lat: null,
              current_long: null
            }
          ]
        };

        filtered.unshift(genericAdCard);
      }
    }

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});
/* GET MY SERVICES — services the authenticated user provides (profile > Services tab).
   Declared before /:services_id so "my" isn't parsed as an id. */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const providers = await prisma.user_service_provider.findMany({
      where: { user_id: req.user.user_id, services_id: { not: null } },
      include: {
        services: {
          include: { service_category: true, service_type: true },
        },
      },
    });
    const seen = new Set();
    const services = providers
      .map(p => p.services)
      .filter(s => s && !seen.has(s.services_id) && seen.add(s.services_id));
    res.json(services);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your services' });
  }
});

/* GET SERVICE BY ID */
router.get('/:services_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const services_id = Number(req.params.services_id);

    if (Number.isNaN(services_id)) {
      return res.status(400).json({ error: 'services_id must be a number' });
    }

    const service = await prisma.services.findUnique({
      where: { services_id },
      include: {
        service_category: true,
        service_type: true,
        user_service_provider: true,
      },
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(service);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

/* CREATE SERVICE */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      service_name,
      amount,
      duration,
      description,
      service_category_id,
      expire_duration,
      service_type_id,
    } = req.body;

    const service = await prisma.services.create({
      data: {
        service_name,
        amount: amount != null ? parseFloat(amount) : undefined,
        duration,
        description,
        service_category_id: service_category_id ? Number(service_category_id) : undefined,
        expire_duration,
        service_type_id: service_type_id ? Number(service_type_id) : undefined,
      },
      include: {
        service_category: true,
        service_type: true,
      },
    });

    // Link service to the provider's profile so dispatch matching works
    const provider = await prisma.user_service_provider.findFirst({
      where: { user_id: req.user.user_id },
    });
    if (provider) {
      await prisma.user_service_provider.update({
        where: { provider_id: provider.provider_id },
        data: {
          services_id: service.services_id,
          service_type_id: service.service_type_id ?? provider.service_type_id,
          service_category_id: service.service_category_id ?? provider.service_category_id,
        },
      });
    }

    res.status(201).json(service);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service' });
  }
});

/* UPDATE SERVICE */
router.put('/:services_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const services_id = Number(req.params.services_id);

    if (Number.isNaN(services_id)) {
      return res.status(400).json({ error: 'services_id must be a number' });
    }

    const {
      service_name,
      amount,
      duration,
      description,
      service_category_id,
      expire_duration,
      service_type_id,
    } = req.body;

    const existing = await prisma.services.findUnique({
      where: { services_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const updated = await prisma.services.update({
      where: { services_id },
      data: {
        service_name: service_name ?? existing.service_name,
        amount: amount ?? existing.amount,
        duration: duration ?? existing.duration,
        description: description ?? existing.description,
        service_category_id: service_category_id ?? existing.service_category_id,
        expire_duration: expire_duration ?? existing.expire_duration,
        service_type_id: service_type_id ?? existing.service_type_id,
      },
      include: {
        service_category: true,
        service_type: true,
        user_service_provider: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

/* DELETE SERVICE */
router.delete('/:services_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const services_id = Number(req.params.services_id);

    if (Number.isNaN(services_id)) {
      return res.status(400).json({ error: 'services_id must be a number' });
    }

    await prisma.services.delete({
      where: { services_id },
    });

    res.json({ message: 'Service deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
