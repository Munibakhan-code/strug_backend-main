import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=========================================== FLASH CARD CATEGORY ====================================
//======================================================================================================

/* GET ALL FLASH CARD CATEGORIES */
router.get('/categories', async (_req, res) => {
  try {
    const categories = await prisma.flash_card_category.findMany({
      orderBy: { flash_card_category_id: 'desc' },
      include: {
        flash_card: true,
        flash_card_deck: true,
      },
    });
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card categories' });
  }
});

/* GET FLASH CARD CATEGORY BY ID */
router.get('/categories/:id', async (req, res) => {
  try {
    const category = await prisma.flash_card_category.findUnique({
      where: { flash_card_category_id: parseInt(req.params.id) },
      include: {
        flash_card: true,
        flash_card_deck: true,
      },
    });
    
    if (!category) {
      return res.status(404).json({ error: 'Flash card category not found' });
    }
    
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card category' });
  }
});

/* CREATE FLASH CARD CATEGORY */
router.post('/categories', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_category_name, flash_card_category_description, flash_card_category_image } = req.body;
    
    const category = await prisma.flash_card_category.create({
      data: {
        flash_card_category_name,
        flash_card_category_description,
        flash_card_category_image,
      },
    });
    
    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create flash card category' });
  }
});

/* UPDATE FLASH CARD CATEGORY */
router.put('/categories/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_category_name, flash_card_category_description, flash_card_category_image } = req.body;
    
    const category = await prisma.flash_card_category.update({
      where: { flash_card_category_id: parseInt(req.params.id) },
      data: {
        flash_card_category_name,
        flash_card_category_description,
        flash_card_category_image,
      },
    });
    
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flash card category' });
  }
});

/* DELETE FLASH CARD CATEGORY */
router.delete('/categories/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.flash_card_category.delete({
      where: { flash_card_category_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Flash card category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flash card category' });
  }
});

//======================================================================================================
//=========================================== FLASH CARD DECK ========================================
//======================================================================================================

/* GET ALL FLASH CARD DECKS */
router.get('/decks', async (_req, res) => {
  try {
    const decks = await prisma.flash_card_deck.findMany({
      orderBy: { flash_card_deck_id: 'desc' },
      include: {
        flash_card: true,
        flash_card_category: true,
        user: true,
        flash_card_deck_user: true,
      },
    });
    res.json(decks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card decks' });
  }
});

/* GET FLASH CARD DECK BY ID */
router.get('/decks/:id', async (req, res) => {
  try {
    const deck = await prisma.flash_card_deck.findUnique({
      where: { flash_card_deck_id: parseInt(req.params.id) },
      include: {
        flash_card: true,
        flash_card_category: true,
        user: true,
        flash_card_deck_user: true,
      },
    });
    
    if (!deck) {
      return res.status(404).json({ error: 'Flash card deck not found' });
    }
    
    res.json(deck);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card deck' });
  }
});

/* CREATE FLASH CARD DECK */
router.post('/decks', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_deck_name, flash_card_deck_description, flash_card_deck_category_id, user_id } = req.body;
    
    const deck = await prisma.flash_card_deck.create({
      data: {
        flash_card_deck_name,
        flash_card_deck_description,
        flash_card_deck_category_id: flash_card_deck_category_id ? parseInt(flash_card_deck_category_id) : null,
        flash_card_deck_creator: user_id ? parseInt(user_id) : null,
      },
    });
    
    res.status(201).json(deck);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create flash card deck' });
  }
});

/* UPDATE FLASH CARD DECK */
router.put('/decks/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_deck_name, flash_card_deck_description, flash_card_deck_category_id } = req.body;
    
    const deck = await prisma.flash_card_deck.update({
      where: { flash_card_deck_id: parseInt(req.params.id) },
      data: {
        flash_card_deck_name,
        flash_card_deck_description,
        flash_card_deck_category_id: flash_card_deck_category_id ? parseInt(flash_card_deck_category_id) : null,
      },
    });
    
    res.json(deck);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flash card deck' });
  }
});

/* DELETE FLASH CARD DECK */
router.delete('/decks/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.flash_card_deck.delete({
      where: { flash_card_deck_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Flash card deck deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flash card deck' });
  }
});

//======================================================================================================
//========================================= FLASH CARD DECK USER ====================================
//======================================================================================================

/* GET ALL FLASH CARD DECK USERS */
router.get('/deck-users', async (_req, res) => {
  try {
    const deckUsers = await prisma.flash_card_deck_user.findMany({
      orderBy: { flash_card_deck_user_id: 'desc' },
      include: {
        flash_card_deck: true,
        user: true,
      },
    });
    res.json(deckUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card deck users' });
  }
});

/* GET FLASH CARD DECK USER BY ID */
router.get('/deck-users/:id', async (req, res) => {
  try {
    const deckUser = await prisma.flash_card_deck_user.findUnique({
      where: { flash_card_deck_user_id: parseInt(req.params.id) },
      include: {
        flash_card_deck: true,
        user: true,
      },
    });
    
    if (!deckUser) {
      return res.status(404).json({ error: 'Flash card deck user not found' });
    }
    
    res.json(deckUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card deck user' });
  }
});

/* CREATE FLASH CARD DECK USER */
router.post('/deck-users', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_deck_id, user_id, is_complete } = req.body;
    
    const deckUser = await prisma.flash_card_deck_user.create({
      data: {
        flash_card_deck_id: parseInt(flash_card_deck_id),
        user_id: parseInt(user_id),
        is_complete: is_complete || false,
      },
    });
    
    res.status(201).json(deckUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create flash card deck user' });
  }
});

/* UPDATE FLASH CARD DECK USER */
router.put('/deck-users/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { is_complete } = req.body;
    
    const deckUser = await prisma.flash_card_deck_user.update({
      where: { flash_card_deck_user_id: parseInt(req.params.id) },
      data: {
        is_complete,
      },
    });
    
    res.json(deckUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flash card deck user' });
  }
});

/* DELETE FLASH CARD DECK USER */
router.delete('/deck-users/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.flash_card_deck_user.delete({
      where: { flash_card_deck_user_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Flash card deck user deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flash card deck user' });
  }
});

//======================================================================================================
//========================================= FLASH CARD USER DO ======================================
//======================================================================================================

/* GET ALL FLASH CARD USER DOS */
router.get('/user-dos', async (_req, res) => {
  try {
    const userDos = await prisma.flash_card_user_do.findMany({
      orderBy: { flash_card_user_do_id: 'desc' },
      include: {
        flash_card: true,
        user: true,
      },
    });
    res.json(userDos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card user dos' });
  }
});

/* GET FLASH CARD USER DO BY ID */
router.get('/user-dos/:id', async (req, res) => {
  try {
    const userDo = await prisma.flash_card_user_do.findUnique({
      where: { flash_card_user_do_id: parseInt(req.params.id) },
      include: {
        flash_card: true,
        user: true,
      },
    });
    
    if (!userDo) {
      return res.status(404).json({ error: 'Flash card user do not found' });
    }
    
    res.json(userDo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flash card user do' });
  }
});

/* CREATE FLASH CARD USER DO */
router.post('/user-dos', /*authenticateToken,*/ async (req, res) => {
  try {
    const { flash_card_id, user_id, rating, no_of_appearance } = req.body;
    
    const userDo = await prisma.flash_card_user_do.create({
      data: {
        flash_card_id: parseInt(flash_card_id),
        user_id: parseInt(user_id),
        rating: rating ? parseInt(rating) : null,
        no_of_appearance: no_of_appearance ? parseInt(no_of_appearance) : null,
      },
    });
    
    res.status(201).json(userDo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create flash card user do' });
  }
});

/* UPDATE FLASH CARD USER DO */
router.put('/user-dos/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { rating, no_of_appearance } = req.body;
    
    const userDo = await prisma.flash_card_user_do.update({
      where: { flash_card_user_do_id: parseInt(req.params.id) },
      data: {
        rating: rating ? parseInt(rating) : null,
        no_of_appearance: no_of_appearance ? parseInt(no_of_appearance) : null,
      },
    });
    
    res.json(userDo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flash card user do' });
  }
});

/* DELETE FLASH CARD USER DO */
router.delete('/user-dos/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.flash_card_user_do.delete({
      where: { flash_card_user_do_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Flash card user do deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flash card user do' });
  }
});

export default router;