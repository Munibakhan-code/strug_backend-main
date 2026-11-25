import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SERVICE TYPES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const serviceTypes = await prisma.service_type.findMany({
      orderBy: { service_type_id: 'desc' },
      include: {
        service_cart: true,
        service_category: true,
        service_cv: true,
        service_order: true,
        service_ratings: true,
        services: true,
        user_service_provider: true,
      },
    });

    res.json(serviceTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service types' });
  }
});

/* GET SERVICE TYPE BY ID */
router.get('/:service_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_type_id = Number(req.params.service_type_id);

    if (Number.isNaN(service_type_id)) {
      return res.status(400).json({ error: 'service_type_id must be a number' });
    }

    const serviceType = await prisma.service_type.findUnique({
      where: { service_type_id },
      include: {
        service_cart: true,
        service_category: true,
        service_cv: true,
        service_order: true,
        service_ratings: true,
        services: true,
        user_service_provider: true,
      },
    });

    if (!serviceType) {
      return res.status(404).json({ error: 'Service type not found' });
    }

    res.json(serviceType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service type' });
  }
});

/* CREATE SERVICE TYPE */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { service_type_name } = req.body;

    const serviceType = await prisma.service_type.create({
      data: {
        service_type_name,
      },
    });

    res.status(201).json(serviceType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service type' });
  }
});

/* UPDATE SERVICE TYPE */
router.put('/:service_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_type_id = Number(req.params.service_type_id);

    if (Number.isNaN(service_type_id)) {
      return res.status(400).json({ error: 'service_type_id must be a number' });
    }

    const { service_type_name } = req.body;

    const existing = await prisma.service_type.findUnique({
      where: { service_type_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Service type not found' });
    }

    const updated = await prisma.service_type.update({
      where: { service_type_id },
      data: {
        service_type_name: service_type_name ?? existing.service_type_name,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service type' });
  }
});

/* DELETE SERVICE TYPE */
router.delete('/:service_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_type_id = Number(req.params.service_type_id);

    if (Number.isNaN(service_type_id)) {
      return res.status(400).json({ error: 'service_type_id must be a number' });
    }

    await prisma.service_type.delete({
      where: { service_type_id },
    });

    res.json({ message: 'Service type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service type' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
