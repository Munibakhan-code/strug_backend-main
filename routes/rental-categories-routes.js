import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL RENTAL CATEGORIES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const rentalCategories = await prisma.rental_categories.findMany({
      orderBy: { rental_category_id: 'desc' },
      include: {
        rental_type: true,
        rental_listing: true,
      },
    });

    res.json(rentalCategories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental categories' });
  }
});

/* GET RENTAL CATEGORY BY ID */
router.get('/:rental_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const rental_category_id = Number(req.params.rental_category_id);

    if (Number.isNaN(rental_category_id)) {
      return res.status(400).json({ error: 'rental_category_id must be a number' });
    }

    const rentalCategory = await prisma.rental_categories.findUnique({
      where: { rental_category_id },
      include: {
        rental_type: true,
        rental_listing: true,
      },
    });

    if (!rentalCategory) {
      return res.status(404).json({ error: 'Rental category not found' });
    }

    res.json(rentalCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental category' });
  }
});

/* CREATE RENTAL CATEGORY */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { rental_category_name, rental_type_id } = req.body;

    const rentalCategory = await prisma.rental_categories.create({
      data: {
        rental_category_name,
        rental_type_id,
      },
      include: {
        rental_type: true,
      },
    });

    res.status(201).json(rentalCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rental category' });
  }
});

/* UPDATE RENTAL CATEGORY */
router.put('/:rental_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const rental_category_id = Number(req.params.rental_category_id);

    if (Number.isNaN(rental_category_id)) {
      return res.status(400).json({ error: 'rental_category_id must be a number' });
    }

    const { rental_category_name, rental_type_id } = req.body;

    const existing = await prisma.rental_categories.findUnique({
      where: { rental_category_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Rental category not found' });
    }

    const updated = await prisma.rental_categories.update({
      where: { rental_category_id },
      data: {
        rental_category_name: rental_category_name ?? existing.rental_category_name,
        rental_type_id: rental_type_id ?? existing.rental_type_id,
      },
      include: {
        rental_type: true,
        rental_listing: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rental category' });
  }
});

/* DELETE RENTAL CATEGORY */
router.delete('/:rental_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const rental_category_id = Number(req.params.rental_category_id);

    if (Number.isNaN(rental_category_id)) {
      return res.status(400).json({ error: 'rental_category_id must be a number' });
    }

    await prisma.rental_categories.delete({
      where: { rental_category_id },
    });

    res.json({ message: 'Rental category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rental category' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
