import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all DG content
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const categoryName = category || 'DigitalProducts';
    const contents = await prisma.dg_content.findMany({
      where: {
        dg_categories: {
          dg_category_name: {
            equals: categoryName,
            mode: 'insensitive'
          }
        }
      },
      orderBy: { content_id: 'desc' },
      include: {
        dg_categories: true,
        dg_cart: true,
        dg_order: true,
      },
    });

    res.json(contents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG content' });
  }
});

/**
 * Get single DG content
 */
router.get('/:content_id', authenticateToken, async (req, res) => {
  try {
    const content = await prisma.dg_content.findUnique({
      where: { content_id: Number(req.params.content_id) },
      include: {
        dg_categories: true,
        dg_cart: true,
        dg_order: true,
      },
    });

    if (!content) return res.status(404).json({ error: 'DG content not found' });

    res.json(content);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG content' });
  }
});

/**
 * Get seller's digital content listings
 */
router.get('/listings/:seller_id', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const author_id = String(req.params.seller_id);
    
    let where = { author: author_id };
    if (category) {
      where.dg_categories = {
        dg_category_name: {
          equals: category,
          mode: 'insensitive'
        }
      };
    }
    
    const contents = await prisma.dg_content.findMany({
      where,
      orderBy: { content_id: 'desc' },
      include: {
        dg_categories: true,
      },
    });

    res.json(contents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seller DG content' });
  }
});

/**
 * Create DG content
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      content_title,
      content_description,
      content_url,
      author,
      price,
      date,
      dg_category_id,
      dg_category_name,
      cover_img_url,
    } = req.body;

    if (!content_title || price === undefined) {
      return res.status(400).json({ error: 'content_title and price are required' });
    }

    let resolvedCategoryId = dg_category_id ? Number(dg_category_id) : null;
    if (dg_category_name) {
      const catName = String(dg_category_name).trim();
      let dgCat = await prisma.dg_categories.findFirst({
        where: { dg_category_name: { equals: catName, mode: 'insensitive' } }
      });
      if (!dgCat) {
        dgCat = await prisma.dg_categories.create({
          data: { dg_category_name: catName }
        });
      }
      resolvedCategoryId = dgCat.dg_category_id;
    }

    const newContent = await prisma.dg_content.create({
      data: {
        content_title,
        content_description: content_description || null,
        content_url: content_url || null,
        author: author ? String(author) : null,
        price: parseFloat(price),
        date: date ? new Date(date) : new Date(),
        dg_category_id: resolvedCategoryId,
        cover_img_url: cover_img_url || null,
      },
      include: {
        dg_categories: true
      }
    });

    io?.emit('dg-content-created', newContent);

    res.status(201).json(newContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create DG content' });
  }
});

/**
 * Update DG content
 */
router.put('/:content_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { content_id } = req.params;
    const {
      content_title,
      content_description,
      content_url,
      author,
      price,
      date,
      dg_category_id,
      dg_category_name,
      cover_img_url,
    } = req.body;

    const existing = await prisma.dg_content.findUnique({
      where: { content_id: Number(content_id) },
    });

    if (!existing) return res.status(404).json({ error: 'DG content not found' });

    let resolvedCategoryId = dg_category_id ? Number(dg_category_id) : existing.dg_category_id;
    if (dg_category_name) {
      const catName = String(dg_category_name).trim();
      let dgCat = await prisma.dg_categories.findFirst({
        where: { dg_category_name: { equals: catName, mode: 'insensitive' } }
      });
      if (!dgCat) {
        dgCat = await prisma.dg_categories.create({
          data: { dg_category_name: catName }
        });
      }
      resolvedCategoryId = dgCat.dg_category_id;
    }

    const updatedContent = await prisma.dg_content.update({
      where: { content_id: Number(content_id) },
      data: {
        content_title: content_title ?? existing.content_title,
        content_description: content_description !== undefined ? content_description : existing.content_description,
        content_url: content_url !== undefined ? content_url : existing.content_url,
        author: author !== undefined ? (author ? String(author) : null) : existing.author,
        price: price !== undefined ? parseFloat(price) : existing.price,
        date: date ? new Date(date) : existing.date,
        dg_category_id: resolvedCategoryId,
        cover_img_url: cover_img_url !== undefined ? cover_img_url : existing.cover_img_url,
      },
      include: {
        dg_categories: true
      }
    });

    io?.emit('dg-content-updated', updatedContent);

    res.json(updatedContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update DG content' });
  }
});

/**
 * Delete DG content
 */
router.delete('/:content_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.dg_content.delete({
      where: { content_id: Number(req.params.content_id) },
    });

    io?.emit('dg-content-deleted', { content_id: deleted.content_id });

    res.json({ message: 'DG content deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete DG content' });
  }
});

export default router;
