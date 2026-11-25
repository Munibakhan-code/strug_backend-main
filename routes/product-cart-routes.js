import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { canAccessBuyerCart, canMutateCartItem } from '../utils/shop-cart-access.js';

const router = express.Router();

const cartInclude = {
  product_variation: {
    include: {
      product_listing: true,
    },
  },
  product_type: true,
  user_product_cart_seller_idTouser: true,
};

/* GET current buyer's cart items */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const buyer_id = req.user.user_id;
    const cartItems = await prisma.product_cart.findMany({
      where: { buyer_id },
      orderBy: { cart_id: 'desc' },
      include: {
        ...cartInclude,
        user_product_cart_buyer_idTouser: true,
      },
    });
    res.json(cartItems);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cart items' });
  }
});

/* GET CART ITEMS BY BUYER ID — caller may only read their own cart */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
  try {
    const buyer_id = Number(req.params.buyer_id);
    if (Number.isNaN(buyer_id)) return res.status(400).json({ error: 'buyer_id must be a number' });
    if (!canAccessBuyerCart(req.user.user_id, buyer_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const cartItems = await prisma.product_cart.findMany({
      where: { buyer_id },
      include: cartInclude,
    });
    res.json(cartItems);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cart items for buyer' });
  }
});

/* CREATE CART ITEM — buyer_id always from JWT */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { seller_id, variation_id, qty, total, product_type_id } = req.body;
    const buyer_id = req.user.user_id;

    if (!seller_id || variation_id == null || qty == null) {
      return res.status(400).json({ error: 'seller_id, variation_id, and qty are required' });
    }

    const cartItem = await prisma.product_cart.create({
      data: {
        seller_id: Number(seller_id),
        buyer_id,
        variation_id: Number(variation_id),
        qty: Number(qty),
        total: total != null ? Number(total) : null,
        product_type_id: product_type_id != null ? Number(product_type_id) : null,
      },
      include: {
        product_variation: true,
        product_type: true,
      },
    });

    res.status(201).json(cartItem);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

/* UPDATE CART ITEM — owner only; cannot reassign buyer */
router.put('/:cart_id', authenticateToken, async (req, res) => {
  try {
    const cart_id = Number(req.params.cart_id);
    if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

    const existing = await prisma.product_cart.findUnique({ where: { cart_id } });
    if (!existing) return res.status(404).json({ error: 'Cart item not found' });
    if (!canMutateCartItem(req.user.user_id, existing)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { seller_id, variation_id, qty, total, product_type_id } = req.body;

    const updated = await prisma.product_cart.update({
      where: { cart_id },
      data: {
        seller_id: seller_id ?? existing.seller_id,
        variation_id: variation_id ?? existing.variation_id,
        qty: qty ?? existing.qty,
        total: total ?? existing.total,
        product_type_id: product_type_id ?? existing.product_type_id,
      },
      include: {
        product_variation: true,
        product_type: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cart item' });
  }
});

/* DELETE CART ITEM — owner only */
router.delete('/:cart_id', authenticateToken, async (req, res) => {
  try {
    const cart_id = Number(req.params.cart_id);
    if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

    const existing = await prisma.product_cart.findUnique({ where: { cart_id } });
    if (!existing) return res.status(404).json({ error: 'Cart item not found' });
    if (!canMutateCartItem(req.user.user_id, existing)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.product_cart.delete({ where: { cart_id } });
    res.json({ message: 'Cart item deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cart item' });
  }
});

export default router;
