import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all flash cards
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const flashCards = await prisma.flash_card.findMany({
      orderBy: { flash_card_id: 'asc' },
      include: {
        flash_card_category: true,
        user: true,
        flash_card_deck: true,
        flash_card_user_do: true,
      },
    });
    res.json(flashCards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash cards' });
  }
});

/**
 * Get single flash card
 */
router.get('/:flash_card_id', authenticateToken, async (req, res) => {
  try {
    const flashCard = await prisma.flash_card.findUnique({
      where: { flash_card_id: Number(req.params.flash_card_id) },
      include: {
        flash_card_category: true,
        user: true,
        flash_card_deck: true,
        flash_card_user_do: true,
      },
    });

    if (!flashCard) return res.status(404).json({ error: 'Flash card not found' });

    res.json(flashCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card' });
  }
});

/**
 * Create flash card
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { flash_card_topic, flash_card_question, flash_card_answer, flash_card_category_id, flash_card_creator, flash_card_deck_id } = req.body;

    if (!flash_card_topic || !flash_card_question || !flash_card_answer) {
      return res.status(400).json({ error: 'Topic, question, and answer are required' });
    }

    const newFlashCard = await prisma.flash_card.create({
      data: {
        flash_card_topic,
        flash_card_question,
        flash_card_answer,
        flash_card_category_id,
        flash_card_creator,
        flash_card_deck_id,
      },
    });

    io?.emit('flash-card-created', newFlashCard);

    res.status(201).json(newFlashCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create flash card' });
  }
});

/**
 * Update flash card
 */
router.put('/:flash_card_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { flash_card_id } = req.params;
    const { flash_card_topic, flash_card_question, flash_card_answer, flash_card_category_id, flash_card_creator, flash_card_deck_id } = req.body;

    const existing = await prisma.flash_card.findUnique({
      where: { flash_card_id: Number(flash_card_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Flash card not found' });

    const updatedFlashCard = await prisma.flash_card.update({
      where: { flash_card_id: Number(flash_card_id) },
      data: {
        flash_card_topic,
        flash_card_question,
        flash_card_answer,
        flash_card_category_id,
        flash_card_creator,
        flash_card_deck_id,
      },
    });

    io?.emit('flash-card-updated', updatedFlashCard);

    res.json(updatedFlashCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flash card' });
  }
});

/**
 * Delete flash card
 */
router.delete('/:flash_card_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.flash_card.delete({
      where: { flash_card_id: Number(req.params.flash_card_id) },
    });

    io?.emit('flash-card-deleted', { flash_card_id: deleted.flash_card_id });

    res.json({ message: 'Flash card deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flash card' });
  }
});

export default router;
