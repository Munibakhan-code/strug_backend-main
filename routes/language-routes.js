import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//============================================= LANGUAGE ==============================================
//======================================================================================================

/* GET ALL LANGUAGES */
router.get('/', async (_req, res) => {
  try {
    const languages = await prisma.language.findMany({
      orderBy: { language_id: 'desc' },
      include: {
        lesson: true,
      },
    });
    res.json(languages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch languages' });
  }
});

/* GET LANGUAGE BY ID */
router.get('/:id', async (req, res) => {
  try {
    const language = await prisma.language.findUnique({
      where: { language_id: parseInt(req.params.id) },
      include: {
        lesson: true,
      },
    });
    
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }
    
    res.json(language);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch language' });
  }
});

/* CREATE LANGUAGE */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { language_name } = req.body;
    
    const language = await prisma.language.create({
      data: {
        language_name,
      },
    });
    
    res.status(201).json(language);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create language' });
  }
});

/* UPDATE LANGUAGE */
router.put('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { language_name } = req.body;
    
    const language = await prisma.language.update({
      where: { language_id: parseInt(req.params.id) },
      data: {
        language_name,
      },
    });
    
    res.json(language);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update language' });
  }
});

/* DELETE LANGUAGE */
router.delete('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.language.delete({
      where: { language_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Language deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete language' });
  }
});

export default router;