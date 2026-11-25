import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

const SAFE_USER_SELECT = { select: { user_id: true, name: true } };

function ownsCustomer(req, customer) {
  return isAdmin(req) || customer?.user_id === req.user.user_id;
}

async function resolveOwnCustomer(user_id) {
  // Deterministic: always return the user's earliest row so a duplicate (from a
  // concurrent first-time create race) never changes which customer_id is used.
  // TODO: add `@unique` on courier_customer.user_id + switch to upsert once the
  // prod DB is deduped (migration is deploy-sensitive on the drifted prod DB).
  let customer = await prisma.courier_customer.findFirst({
    where: { user_id },
    orderBy: { customer_id: 'asc' },
  });
  if (!customer) {
    try {
      customer = await prisma.courier_customer.create({ data: { user_id } });
    } catch {
      customer = await prisma.courier_customer.findFirst({
        where: { user_id },
        orderBy: { customer_id: 'asc' },
      });
    }
  }
  return customer;
}

/**
 * List courier customers. Admins see everyone; everyone else sees only their own row.
 * Embedded `user` is stripped to id + name — the full row carries plaintext email/phone.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const customers = await prisma.courier_customer.findMany({
      where: isAdmin(req) ? {} : { user_id: req.user.user_id },
      orderBy: { customer_id: 'asc' },
      include: {
        user: SAFE_USER_SELECT,
        courier_order: true,
      },
    });

    res.json(customers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier customers' });
  }
});

/**
 * Get-or-create the authenticated user's courier_customer record.
 * user_id comes from the token, never the body. Registered before
 * "/:customer_id" so "me" isn't parsed as an id.
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const customer = await resolveOwnCustomer(req.user.user_id);
    if (!customer) return res.status(500).json({ error: 'Failed to resolve courier customer' });
    res.json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve courier customer' });
  }
});

/**
 * Get single courier customer — owner or admin only.
 */
router.get('/:customer_id', authenticateToken, async (req, res) => {
  try {
    const customer = await prisma.courier_customer.findUnique({
      where: { customer_id: Number(req.params.customer_id) },
      include: {
        user: SAFE_USER_SELECT,
        courier_order: true,
      },
    });

    if (!customer)
      return res.status(404).json({ error: 'Courier customer not found' });
    if (!ownsCustomer(req, customer))
      return res.status(403).json({ error: 'Forbidden' });

    res.json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier customer' });
  }
});

/**
 * Create courier customer — bound to the JWT user. Body `user_id` is ignored.
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const newCustomer = await resolveOwnCustomer(req.user.user_id);
    if (!newCustomer) return res.status(500).json({ error: 'Failed to create courier customer' });

    io?.to(`user-${req.user.user_id}`).emit('courier-customer-created', newCustomer);

    res.status(201).json(newCustomer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create courier customer' });
  }
});

/**
 * Update courier customer. Reassigning `user_id` is admin-only (IDOR otherwise).
 */
router.put('/:customer_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { customer_id } = req.params;
    const existing = await prisma.courier_customer.findUnique({
      where: { customer_id: Number(customer_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'Courier customer not found' });
    if (!ownsCustomer(req, existing))
      return res.status(403).json({ error: 'Forbidden' });

    const nextUserId = isAdmin(req) && req.body?.user_id != null
      ? Number(req.body.user_id)
      : existing.user_id;

    const updatedCustomer = await prisma.courier_customer.update({
      where: { customer_id: Number(customer_id) },
      data: {
        user_id: nextUserId,
      },
    });

    io?.to(`user-${updatedCustomer.user_id}`).emit('courier-customer-updated', updatedCustomer);

    res.json(updatedCustomer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update courier customer' });
  }
});

/**
 * Delete courier customer — owner or admin only.
 */
router.delete('/:customer_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.courier_customer.findUnique({
      where: { customer_id: Number(req.params.customer_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'Courier customer not found' });
    if (!ownsCustomer(req, existing))
      return res.status(403).json({ error: 'Forbidden' });

    const deleted = await prisma.courier_customer.delete({
      where: { customer_id: existing.customer_id },
    });

    io?.to(`user-${deleted.user_id}`).emit('courier-customer-deleted', { customer_id: deleted.customer_id });

    res.json({ message: 'Courier customer deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete courier customer' });
  }
});

export default router;
