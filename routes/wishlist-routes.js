import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();
const prisma = new PrismaClient();

// Helper: sum completed contributions for an item
function sumContributions(contributions) {
  return contributions.reduce((s, c) => s + parseFloat(c.amount), 0);
}

// Helper: build the public-facing item shape
function shapeItem(item) {
  const total_contributed = sumContributions(
    item.contributions.filter(c => c.status === 'completed')
  );
  const price = parseFloat(item.price);
  const progress_pct = price > 0 ? Math.min(100, Math.round((total_contributed / price) * 100)) : 0;
  return {
    wishlist_item_id: item.wishlist_item_id,
    owner_id: item.owner_id,
    item_type: item.item_type,
    item_ref_id: item.item_ref_id,
    title: item.title,
    description: item.description,
    image_url: item.image_url,
    price,
    currency: item.currency,
    status: item.status,
    created_at: item.created_at,
    total_contributed,
    progress_pct,
    contributor_count: item.contributions.filter(c => c.status === 'completed').length,
    recent_contributors: item.contributions
      .filter(c => c.status === 'completed')
      .slice(-5)
      .map(c => ({
        contributor_id: c.contributor_id,
        amount: parseFloat(c.amount),
        note: c.note,
        created_at: c.created_at,
        profile: c.contributor?.social_profiles?.[0] ?? null,
      })),
  };
}

// GET /wishlist/search?q=&type=  — search platform items to add (auth required)
// MUST be registered before /:userId to prevent Express matching "search" as a userId param.
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const q = req.query.q?.trim() ?? '';
    const type = req.query.type ?? '';
    const results = [];

    if (!type || type === 'product') {
      const products = await prisma.product_listing.findMany({
        where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
        include: { product_variation: { take: 1, orderBy: { price: 'asc' }, where: { price: { gt: 0 } } } },
        take: 6,
        orderBy: { listing_id: 'desc' },
      });
      for (const p of products) {
        const v = p.product_variation[0];
        if (v?.price) {
          results.push({
            type: 'product',
            ref_id: v.variation_id,
            title: p.name ?? 'Product',
            image_url: p.image_url ?? v.image_url ?? null,
            price: v.price,
            description: null,
          });
        }
      }
    }

    if (!type || type === 'food') {
      const foods = await prisma.food_item.findMany({
        where: { is_available: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
        take: 6,
        orderBy: { food_item_id: 'desc' },
      });
      for (const f of foods) {
        if (f.price) {
          results.push({
            type: 'food',
            ref_id: f.food_item_id,
            title: f.name ?? 'Food item',
            image_url: null,
            price: f.price,
            description: f.description ?? null,
          });
        }
      }
    }

    if (!type || type === 'booking') {
      const bookings = await prisma.booking_listing.findMany({
        where: { is_active: true, ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}) },
        take: 6,
        orderBy: { booking_listing_id: 'desc' },
      });
      for (const b of bookings) {
        if (b.price) {
          const imgs = Array.isArray(b.images) ? b.images : (b.images ? Object.values(b.images) : []);
          results.push({
            type: 'booking',
            ref_id: b.booking_listing_id,
            title: b.title ?? 'Experience',
            image_url: imgs[0] ?? null,
            price: b.price,
            description: b.description ?? null,
          });
        }
      }
    }

    res.json(results);
  } catch (err) {
    console.error('wishlist search error', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /wishlist/:userId  — get all active wishlist items for a user (public)
router.get('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user' });

    const items = await prisma.wishlist_item.findMany({
      where: { owner_id: userId, status: { not: 'removed' } },
      include: {
        contributions: {
          select: {
            contribution_id: true,
            contributor_id: true,
            amount: true,
            note: true,
            status: true,
            created_at: true,
            contributor: { select: { social_profiles: { select: { display_name: true, profile_pic_url: true, handle: true } } } },
          },
          orderBy: { created_at: 'asc' },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json(items.map(shapeItem));
  } catch (err) {
    console.error('wishlist get error', err);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

// POST /wishlist  — add item to own wishlist
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { item_type, item_ref_id, title, description, image_url, price } = req.body;
    if (!title || !price || parseFloat(price) <= 0) {
      return res.status(400).json({ error: 'title and price are required' });
    }
    const validTypes = ['product', 'food', 'booking', 'service', 'custom'];
    if (!validTypes.includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }

    // Cap wishlist at 20 active items
    const count = await prisma.wishlist_item.count({
      where: { owner_id: req.user.user_id, status: { in: ['active', 'funded'] } },
    });
    if (count >= 20) return res.status(400).json({ error: 'Wishlist limit reached (20 items)' });

    const item = await prisma.wishlist_item.create({
      data: {
        owner_id: req.user.user_id,
        item_type: item_type ?? 'custom',
        item_ref_id: item_ref_id ? parseInt(item_ref_id) : null,
        title: title.slice(0, 500),
        description: description ?? null,
        image_url: image_url ?? null,
        price: parseFloat(price),
        status: 'active',
      },
    });

    res.status(201).json({ ...item, total_contributed: 0, progress_pct: 0, contributor_count: 0 });
  } catch (err) {
    console.error('wishlist add error', err);
    res.status(500).json({ error: 'Failed to add wishlist item' });
  }
});

// DELETE /wishlist/:itemId  — remove item; contributions are gifts and go to the owner's wallet
router.delete('/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);

    // Verify ownership before entering transaction
    const item = await prisma.wishlist_item.findUnique({
      where: { wishlist_item_id: itemId },
      select: { owner_id: true, status: true, title: true },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.owner_id !== req.user.user_id) return res.status(403).json({ error: 'Forbidden' });

    let gifted_total = 0;

    await prisma.$transaction(async (tx) => {
      // Atomic guard: only one concurrent delete can flip to 'removed'.
      const guard = await tx.wishlist_item.updateMany({
        where: {
          wishlist_item_id: itemId,
          owner_id: req.user.user_id,
          status: { notIn: ['removed', 'claimed'] },
        },
        data: { status: 'removed' },
      });
      if (guard.count === 0) throw Object.assign(new Error('not_removable'), { code: 'not_removable' });

      // Sum all completed contributions — contributions are permanent gifts, never refunded
      const agg = await tx.wishlist_contribution.aggregate({
        where: { wishlist_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      gifted_total = parseFloat(agg._sum.amount ?? 0);

      // Credit the gift total to the owner's wallet (not contributors — gifts are non-refundable)
      if (gifted_total > 0) {
        const walletCredit = await tx.strug_wallet.updateMany({
          where: { user_id: req.user.user_id },
          data: { balance: { increment: gifted_total } },
        });
        if (walletCredit.count === 0) {
          await tx.strug_wallet.create({
            data: { user_id: req.user.user_id, balance: gifted_total, currency: 'CAD' },
          });
        }
        await tx.wallet_transaction.create({
          data: {
            user_id: req.user.user_id,
            amount: gifted_total,
            type: 'credit',
            source: 'wishlist_gift_received',
            description: `Gifts received: ${item.title}`,
            status: 'completed',
          },
        });
      }
    }, { timeout: 15000 });

    res.json({ success: true, gifted_total });
  } catch (err) {
    if (err.code === 'not_removable') return res.status(400).json({ error: 'Item already removed or claimed' });
    console.error('wishlist remove error', err);
    res.status(500).json({ error: 'Failed to remove wishlist item' });
  }
});

// POST /wishlist/:itemId/contribute  — contribute amount (from wallet)
//
// Race-condition fixes:
//   1. FOR UPDATE row lock on wishlist_item serializes concurrent contributions — prevents
//      two callers both computing the same `remaining` and both overfunding.
//   2. All balance check + debit happens inside the same transaction with updateMany WHERE
//      balance >= amount — prevents wallet double-spend when two requests race the read.
//   3. total_so_far and remaining are computed via aggregate INSIDE the lock, so they
//      reflect reality at the time the lock is held, not at request start.
router.post('/:itemId/contribute', authenticateToken, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const requested_amount = parseFloat(req.body.amount);
    const note = req.body.note ?? null;

    if (isNaN(requested_amount) || requested_amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Cheap pre-check (no lock needed) — avoids entering a transaction for obvious errors
    const item = await prisma.wishlist_item.findUnique({
      where: { wishlist_item_id: itemId },
      select: { owner_id: true, status: true, price: true, title: true },
    });
    if (!item || item.status === 'removed') return res.status(404).json({ error: 'Item not found' });
    if (item.status === 'claimed') return res.status(400).json({ error: 'This item has already been claimed' });

    const price = parseFloat(item.price);
    let final_amount, new_total, fully_funded;

    await prisma.$transaction(async (tx) => {
      // Acquire row lock — prevents concurrent contributions from racing each other.
      // All subsequent reads within this transaction see a consistent snapshot.
      await tx.$executeRaw`SELECT 1 FROM wishlist_item WHERE wishlist_item_id = ${itemId} FOR UPDATE`;

      // Re-read status inside the lock (may have changed between pre-check and now)
      const locked = await tx.wishlist_item.findUnique({
        where: { wishlist_item_id: itemId },
        select: { status: true },
      });
      if (locked.status !== 'active') {
        throw Object.assign(new Error('not_active'), { code: 'not_active' });
      }

      // Authoritative total inside the lock — no concurrent contribution can sneak in
      const agg = await tx.wishlist_contribution.aggregate({
        where: { wishlist_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      const total_so_far = parseFloat(agg._sum.amount ?? 0);
      const remaining = price - total_so_far;

      if (remaining <= 0) {
        throw Object.assign(new Error('already_funded'), { code: 'already_funded' });
      }

      final_amount = Math.min(requested_amount, remaining); // never overfund

      // Atomic wallet debit: the WHERE balance >= final_amount check + UPDATE is one SQL
      // statement, preventing a double-spend if two sessions pass the balance check at the
      // same time (only one UPDATE can win; the other sees count=0).
      const walletDebit = await tx.strug_wallet.updateMany({
        where: { user_id: req.user.user_id, balance: { gte: final_amount } },
        data: { balance: { decrement: final_amount } },
      });
      if (walletDebit.count === 0) {
        throw Object.assign(new Error('insufficient_balance'), { code: 'insufficient_balance' });
      }

      await tx.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: -final_amount,
          type: 'debit',
          source: 'wishlist_contribution',
          description: `Gift for wishlist: ${item.title}`,
          status: 'completed',
        },
      });
      await tx.wishlist_contribution.create({
        data: {
          wishlist_item_id: itemId,
          contributor_id: req.user.user_id,
          amount: final_amount,
          payment_method: 'wallet',
          note,
          status: 'completed',
        },
      });

      new_total = total_so_far + final_amount;
      fully_funded = new_total >= price;

      if (fully_funded) {
        await tx.wishlist_item.update({
          where: { wishlist_item_id: itemId },
          data: { status: 'funded' },
        });
      }
    }, { timeout: 10000 });

    res.json({
      success: true,
      contrib_amount: final_amount,
      fully_funded,
      progress_pct: Math.min(100, Math.round((new_total / price) * 100)),
      total_contributed: new_total,
    });
  } catch (err) {
    if (err.code === 'already_funded') return res.status(400).json({ error: 'Item is already fully funded' });
    if (err.code === 'insufficient_balance') return res.status(400).json({ error: 'Insufficient wallet balance' });
    if (err.code === 'not_active') return res.status(400).json({ error: 'Item is no longer accepting contributions' });
    console.error('wishlist contribute error', err);
    res.status(500).json({ error: 'Contribution failed' });
  }
});

// POST /wishlist/:itemId/claim  — owner claims fully-funded item to their wallet
//
// Race-condition fixes:
//   1. updateMany with WHERE status='funded' is the atomic guard — in Postgres READ COMMITTED,
//      a second concurrent claim blocks on the row lock, then re-evaluates WHERE and finds
//      status is no longer 'funded', so count=0 → rejected.
//   2. Contribution total is summed INSIDE the transaction (after the guard) so it reflects
//      the exact amount that was contributed, not a stale pre-read.
//   3. Wallet credit uses updateMany (no upsert) so a missing wallet row is detected and
//      created separately, making the intent explicit and preventing phantom balance creation.
router.post('/:itemId/claim', authenticateToken, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);

    // Cheap ownership pre-check before entering transaction
    const item = await prisma.wishlist_item.findUnique({
      where: { wishlist_item_id: itemId },
      select: { owner_id: true, status: true, title: true },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.owner_id !== req.user.user_id) return res.status(403).json({ error: 'Forbidden' });

    let credited;

    await prisma.$transaction(async (tx) => {
      // Atomic state transition: only one claim can win.
      // The second concurrent claim blocks on the row lock, sees status != 'funded', and exits.
      const guard = await tx.wishlist_item.updateMany({
        where: { wishlist_item_id: itemId, owner_id: req.user.user_id, status: 'funded' },
        data: { status: 'claimed' },
      });
      if (guard.count === 0) {
        throw Object.assign(new Error('not_claimable'), { code: 'not_claimable' });
      }

      // Authoritative total inside the transaction — after the guard locked the row
      const agg = await tx.wishlist_contribution.aggregate({
        where: { wishlist_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      credited = parseFloat(agg._sum.amount ?? 0);
      if (credited <= 0) throw Object.assign(new Error('no_funds'), { code: 'no_funds' });

      // Credit owner wallet — try update first; create wallet only if it doesn't exist yet
      const walletCredit = await tx.strug_wallet.updateMany({
        where: { user_id: req.user.user_id },
        data: { balance: { increment: credited } },
      });
      if (walletCredit.count === 0) {
        await tx.strug_wallet.create({
          data: { user_id: req.user.user_id, balance: credited, currency: 'CAD' },
        });
      }

      await tx.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: credited,
          type: 'credit',
          source: 'wishlist_claim',
          description: `Wishlist funded: ${item.title}`,
          status: 'completed',
        },
      });
    }, { timeout: 10000 });

    res.json({ success: true, credited });
  } catch (err) {
    if (err.code === 'not_claimable') return res.status(400).json({ error: 'Item is not funded or already claimed' });
    if (err.code === 'no_funds') return res.status(400).json({ error: 'No contributions to claim' });
    console.error('wishlist claim error', err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

export default router;
