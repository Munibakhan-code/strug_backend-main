import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL PRODUCT TYPES */
router.get('/', async (_req, res) => {
  try {
    const productTypes = await prisma.product_type.findMany({
      orderBy: { product_type_id: 'asc' },
    });
    res.json(productTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product types' });
  }
});

/* GET PRODUCT TYPE BY ID */
router.get('/:product_type_id', async (req, res) => {
  try {
    const product_type_id = Number(req.params.product_type_id);

    if (Number.isNaN(product_type_id)) {
      return res.status(400).json({ error: 'product_type_id must be a number' });
    }

    const productType = await prisma.product_type.findUnique({
      where: { product_type_id },
    });

    if (!productType) {
      return res.status(404).json({ error: 'Product type not found' });
    }

    res.json(productType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product type' });
  }
});

/* CREATE PRODUCT TYPE */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { product_type_name } = req.body;

    const productType = await prisma.product_type.create({
      data: {
        product_type_name,
      },
    });

    res.status(201).json(productType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product type' });
  }
});

/* UPDATE PRODUCT TYPE */
router.put('/:product_type_id', authenticateToken, async (req, res) => {
  try {
    const product_type_id = Number(req.params.product_type_id);

    if (Number.isNaN(product_type_id)) {
      return res.status(400).json({ error: 'product_type_id must be a number' });
    }

    const { product_type_name } = req.body;

    const existing = await prisma.product_type.findUnique({
      where: { product_type_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Product type not found' });
    }

    const updated = await prisma.product_type.update({
      where: { product_type_id },
      data: {
        product_type_name: product_type_name ?? existing.product_type_name,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product type' });
  }
});

/* DELETE PRODUCT TYPE */
router.delete('/:product_type_id', authenticateToken, async (req, res) => {
  try {
    const product_type_id = Number(req.params.product_type_id);

    if (Number.isNaN(product_type_id)) {
      return res.status(400).json({ error: 'product_type_id must be a number' });
    }

    await prisma.product_type.delete({
      where: { product_type_id },
    });

    res.json({ message: 'Product type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product type' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
