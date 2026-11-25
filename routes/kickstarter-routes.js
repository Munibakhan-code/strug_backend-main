import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//======================================== KICKSTARTER CATEGORY ====================================
//======================================================================================================

/* GET ALL KICKSTARTER CATEGORIES */
router.get('/', async (_req, res) => {
  try {
    const categories = await prisma.kickstarter_category.findMany({
      orderBy: { category_id: 'desc' },
    });
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch kickstarter categories' });
  }
});

/* GET KICKSTARTER CATEGORY BY ID */
router.get('/:id', async (req, res) => {
  try {
    const category = await prisma.kickstarter_category.findUnique({
      where: { category_id: parseInt(req.params.id) },
    });
    
    if (!category) {
      return res.status(404).json({ error: 'Kickstarter category not found' });
    }
    
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch kickstarter category' });
  }
});

/* CREATE KICKSTARTER CATEGORY */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { category_name } = req.body;
    
    const category = await prisma.kickstarter_category.create({
      data: {
        category_name,
      },
    });
    
    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create kickstarter category' });
  }
});

/* UPDATE KICKSTARTER CATEGORY */
router.put('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { category_name } = req.body;
    
    const category = await prisma.kickstarter_category.update({
      where: { category_id: parseInt(req.params.id) },
      data: {
        category_name,
      },
    });
    
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update kickstarter category' });
  }
});

/* DELETE KICKSTARTER CATEGORY */
router.delete('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.kickstarter_category.delete({
      where: { category_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Kickstarter category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete kickstarter category' });
  }
});

export default router;