import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SERVICE CATEGORIES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const serviceCategories = await prisma.service_category.findMany({
      orderBy: { service_category_id: 'desc' },
      include: {
        service_type: true,
        services: true,
      },
    });

    res.json(serviceCategories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service categories' });
  }
});

/* GET SERVICE CATEGORY BY ID */
router.get('/:service_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_category_id = Number(req.params.service_category_id);

    if (Number.isNaN(service_category_id)) {
      return res.status(400).json({ error: 'service_category_id must be a number' });
    }

    const serviceCategory = await prisma.service_category.findUnique({
      where: { service_category_id },
      include: {
        service_type: true,
        services: true,
      },
    });

    if (!serviceCategory) {
      return res.status(404).json({ error: 'Service category not found' });
    }

    res.json(serviceCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service category' });
  }
});

/* CREATE SERVICE CATEGORY */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { service_category_name, service_type_id } = req.body;

    const serviceCategory = await prisma.service_category.create({
      data: {
        service_category_name,
        service_type_id,
      },
      include: {
        service_type: true,
      },
    });

    res.status(201).json(serviceCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service category' });
  }
});

/* UPDATE SERVICE CATEGORY */
router.put('/:service_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_category_id = Number(req.params.service_category_id);

    if (Number.isNaN(service_category_id)) {
      return res.status(400).json({ error: 'service_category_id must be a number' });
    }

    const { service_category_name, service_type_id } = req.body;

    const existing = await prisma.service_category.findUnique({
      where: { service_category_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Service category not found' });
    }

    const updated = await prisma.service_category.update({
      where: { service_category_id },
      data: {
        service_category_name: service_category_name ?? existing.service_category_name,
        service_type_id: service_type_id ?? existing.service_type_id,
      },
      include: {
        service_type: true,
        services: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service category' });
  }
});

/* DELETE SERVICE CATEGORY */
router.delete('/:service_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const service_category_id = Number(req.params.service_category_id);

    if (Number.isNaN(service_category_id)) {
      return res.status(400).json({ error: 'service_category_id must be a number' });
    }

    await prisma.service_category.delete({
      where: { service_category_id },
    });

    res.json({ message: 'Service category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service category' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
