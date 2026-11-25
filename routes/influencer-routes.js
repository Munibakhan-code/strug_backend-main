import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//========================================== HIRE INFLUENCER ========================================
//======================================================================================================

/* GET ALL HIRE INFLUENCERS */
router.get('/hire', async (_req, res) => {
  try {
    const hires = await prisma.hire_influencer.findMany({
      orderBy: { hire_influencer_id: 'desc' },
      include: {
        influencer: {
          include: {
            user: true,
          },
        },
        user: true,
      },
    });
    res.json(hires);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hire influencer records' });
  }
});

/* GET HIRE INFLUENCER BY ID */
router.get('/hire/:id', async (req, res) => {
  try {
    const hire = await prisma.hire_influencer.findUnique({
      where: { hire_influencer_id: parseInt(req.params.id) },
      include: {
        influencer: {
          include: {
            user: true,
          },
        },
        user: true,
      },
    });
    
    if (!hire) {
      return res.status(404).json({ error: 'Hire influencer record not found' });
    }
    
    res.json(hire);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hire influencer record' });
  }
});

/* CREATE HIRE INFLUENCER */
router.post('/hire', /*authenticateToken,*/ async (req, res) => {
  try {
    const { influencer_id, user_id, hire_influencer_description } = req.body;
    
    const hire = await prisma.hire_influencer.create({
      data: {
        influencer_id: parseInt(influencer_id),
        user_id: parseInt(user_id),
        hire_influencer_description,
        hire_influencer_date: new Date(),
      },
    });
    
    res.status(201).json(hire);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create hire influencer record' });
  }
});

/* UPDATE HIRE INFLUENCER */
router.put('/hire/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { hire_influencer_description } = req.body;
    
    const hire = await prisma.hire_influencer.update({
      where: { hire_influencer_id: parseInt(req.params.id) },
      data: {
        hire_influencer_description,
      },
    });
    
    res.json(hire);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update hire influencer record' });
  }
});

/* DELETE HIRE INFLUENCER */
router.delete('/hire/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.hire_influencer.delete({
      where: { hire_influencer_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Hire influencer record deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete hire influencer record' });
  }
});

//======================================================================================================
//============================================= INFLUENCER ============================================
//======================================================================================================

/* GET ALL INFLUENCERS */
router.get('/', async (_req, res) => {
  try {
    const influencers = await prisma.influencer.findMany({
      orderBy: { influencer_id: 'desc' },
      include: {
        user: true,
        hire_influencer: true,
      },
    });
    res.json(influencers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch influencers' });
  }
});

/* GET INFLUENCER BY ID */
router.get('/:id', async (req, res) => {
  try {
    const influencer = await prisma.influencer.findUnique({
      where: { influencer_id: parseInt(req.params.id) },
      include: {
        user: true,
        hire_influencer: true,
      },
    });
    
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }
    
    res.json(influencer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch influencer' });
  }
});

/* CREATE INFLUENCER */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { user_id, influencer_description, influencer_image_url } = req.body;
    
    const influencer = await prisma.influencer.create({
      data: {
        user_id: parseInt(user_id),
        influencer_description,
        influencer_image_url,
      },
    });
    
    res.status(201).json(influencer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create influencer' });
  }
});

/* UPDATE INFLUENCER */
router.put('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { influencer_description, influencer_image_url } = req.body;
    
    const influencer = await prisma.influencer.update({
      where: { influencer_id: parseInt(req.params.id) },
      data: {
        influencer_description,
        influencer_image_url,
      },
    });
    
    res.json(influencer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update influencer' });
  }
});

/* DELETE INFLUENCER */
router.delete('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.influencer.delete({
      where: { influencer_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Influencer deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete influencer' });
  }
});

export default router;