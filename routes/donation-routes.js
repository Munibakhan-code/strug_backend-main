import express from 'express';
import Stripe from 'stripe';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import mailerEvents from '../utils/mailer-event.js';
import { decrypt } from '../utils/crypto.js';
import i18next from '../utils/i18n.js';
import { emailLngFromUser } from '../utils/email-lang.js';

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

async function loadDonation(donationId) {
  return prisma.donations.findUnique({
    where: { donation_id: Number(donationId) },
    include: {
      user: true,
      reward_tier: true,
      projects: true,
    },
  });
}

function canViewDonation(donation, req) {
  return Boolean(
    donation
    && (
      donation.donated_user_id === req.user.user_id
      || donation.projects?.owner_user_id === req.user.user_id
      || isAdmin(req)
    )
  );
}

async function reconcileProjectAmount(projectId) {
  const paid = await prisma.donations.aggregate({
    where: { project_id: Number(projectId), payment_status: 'paid' },
    _sum: { amount: true },
  });
  const refunded = await prisma.donations.aggregate({
    where: { project_id: Number(projectId), refund_status: 'refunded' },
    _sum: { refund_amount: true },
  });
  const next = Math.max(
    0,
    Number(paid._sum.amount || 0) - Number(refunded._sum.refund_amount || 0),
  );
  await prisma.projects.update({
    where: { project_id: Number(projectId) },
    data: { current_amount: next },
  }).catch(() => {});
}

/**
 * Get all donations
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { donated_user_id: req.user.user_id };
    const donations = await prisma.donations.findMany({
      where,
      orderBy: { donation_id: 'desc' },
      include: {
        user: true,
        projects: true,
        reward_tier: true,
      },
    });

    res.json(donations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch donations' });
  }
});

router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const donations = await prisma.donations.findMany({
      where: { donated_user_id: req.user.user_id },
      orderBy: { donation_id: 'desc' },
      include: {
        projects: true,
        reward_tier: true,
      },
    });
    res.json(donations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your donations' });
  }
});

router.get('/project/:project_id/backers', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });
    const project = await prisma.projects.findUnique({ where: { project_id } });
    if (!project) return res.status(404).json({ error: 'Campaign not found' });
    if (project.owner_user_id !== req.user.user_id && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const backers = await prisma.donations.findMany({
      where: { project_id, payment_status: { in: ['paid', 'refunded'] } },
      orderBy: { donation_id: 'desc' },
      include: {
        user: { select: { user_id: true, name: true, username: true, email: true } },
        reward_tier: true,
      },
    });
    res.json(backers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch campaign backers' });
  }
});

/**
 * Get single donation
 */
router.get('/:donation_id', authenticateToken, async (req, res) => {
  try {
    const donation = await loadDonation(req.params.donation_id);

    if (!donation) return res.status(404).json({ error: 'Donation not found' });
    if (!canViewDonation(donation, req)) return res.status(403).json({ error: 'Forbidden' });

    res.json(donation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch donation' });
  }
});

/**
 * CREATE NEW DONATION
 * Production Ready: Validates data & Sends a Thank You Receipt via Email
 * POST /donation
 */
router.post('/', authenticateToken, async (req, res) => {
    try {
        // donor is ALWAYS the authenticated user — never trust a client-supplied id
        const donated_user_id = req.user.user_id;
        const {
          amount, project_id, payment_intent_id, reward_tier_id, referral_code,
          shipping_name, shipping_email, shipping_address,
        } = req.body;

        const amt = parseFloat(amount);
        const proj = Number(project_id);
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ successful: false, message: 'A valid donation amount is required.' });
        }
        if (!Number.isInteger(proj)) {
            return res.status(400).json({ successful: false, message: 'A valid project_id is required.' });
        }

        // Optional reward tier: only honoured if it exists and belongs to THIS campaign.
        let tierId = null;
        if (reward_tier_id !== undefined && reward_tier_id !== null && reward_tier_id !== '') {
            const t = Number(reward_tier_id);
            if (Number.isInteger(t)) {
                const tier = await prisma.reward_tier.findUnique({ where: { tier_id: t } });
                if (tier && tier.project_id === proj) tierId = t;
            }
        }

        // Payment is verified SERVER-SIDE against Stripe — the client never decides paid
        // status, and a bare `payment_intent_id` string is no longer trusted. A donation is
        // recorded "paid" only when Stripe confirms a succeeded PaymentIntent that (a) belongs
        // to THIS user, (b) is tagged purpose:'donation', (c) matches the requested amount,
        // and (d) has not already backed another donation (replay). The recorded amount comes
        // from Stripe, not req.body.
        let paymentStatus = 'unpaid';
        let recordedAmt = amt;
        if (payment_intent_id) {
            if (!stripe) {
                return res.status(503).json({ successful: false, message: 'Payments are temporarily unavailable.' });
            }
            const piId = String(payment_intent_id);
            let pi;
            try {
                pi = await stripe.paymentIntents.retrieve(piId);
            } catch (e) {
                return res.status(400).json({ successful: false, message: 'Invalid payment reference.' });
            }
            if (!pi || pi.status !== 'succeeded') {
                return res.status(409).json({ successful: false, message: 'Payment has not succeeded.' });
            }
            if (pi.metadata?.user_id !== String(donated_user_id) || pi.metadata?.purpose !== 'donation') {
                return res.status(403).json({ successful: false, message: 'This payment is not a donation for your account.' });
            }
            const paidAmt = (pi.amount_received ?? pi.amount) / 100;
            if (Math.round(paidAmt * 100) !== Math.round(amt * 100)) {
                return res.status(400).json({ successful: false, message: 'Payment amount does not match the donation amount.' });
            }
            // Replay guard: one PaymentIntent can back at most one donation row.
            const dup = await prisma.donations.findFirst({ where: { payment_intent_id: piId } });
            if (dup) {
                return res.status(409).json({ successful: false, message: 'This payment has already been recorded.' });
            }
            paymentStatus = 'paid';
            recordedAmt = paidAmt; // server source of truth, not req.body
        }

        const newDonation = await prisma.donations.create({
            data: {
                donated_user_id,
                amount: recordedAmt,
                project_id: proj,
                donated_date: new Date(),
                payment_intent_id: payment_intent_id ? String(payment_intent_id) : null,
                payment_status: paymentStatus,
                reward_tier_id: tierId,
                referral_code: referral_code ? String(referral_code).trim() : null,
                paid_at: paymentStatus === 'paid' ? new Date() : null,
                shipping_name: shipping_name ? String(shipping_name).trim() : null,
                shipping_email: shipping_email ? String(shipping_email).trim() : null,
                shipping_address: shipping_address ? String(shipping_address).trim() : null,
                fulfillment_status: tierId ? 'pending' : 'not_required',
            },
            include: { user: true, projects: true, reward_tier: true }
        });

        // Move the campaign's raised total. current_amount is server-owned — it is only
        // ever changed here, atomically, when a paid donation row is created (never set
        // by the client on create/update of the project).
        if (newDonation.payment_status === 'paid') {
            await prisma.projects.update({
                where: { project_id: proj },
                data: { current_amount: { increment: recordedAmt } },
            }).catch((e) => console.error('Failed to increment project current_amount', e));

            // Claim a reward-tier slot atomically. The WHERE compares claimed_count to the
            // limit in SQL so a limited tier can never oversell under concurrency; if it is
            // already full the donation keeps the funds but its tier link is released.
            if (tierId) {
                const claimed = await prisma.$executeRaw`
                    UPDATE "reward_tier"
                       SET "claimed_count" = "claimed_count" + 1
                     WHERE "tier_id" = ${tierId}
                       AND ("quantity_limit" IS NULL OR "claimed_count" < "quantity_limit")`
                    .catch((e) => { console.error('Failed to claim reward tier', e); return 0; });
                if (claimed === 0) {
                    await prisma.donations.update({
                        where: { donation_id: newDonation.donation_id },
                        data: { reward_tier_id: null },
                    }).catch(() => {});
                }
            }
        }

        // If the webhook recorded this charge as an orphan before the row existed,
        // mark it reconciled now.
        if (payment_intent_id) {
            await prisma.stripe_orphan_payment.updateMany({
                where: { payment_intent_id, status: 'unreconciled' },
                data: { status: 'reconciled' },
            }).catch(() => {});
        }

        if (newDonation.user?.email) {
            const userCurrency = newDonation.user.currency || "CAD";
            const lng = emailLngFromUser(newDonation.user);
            const t = i18next.getFixedT(lng);
            mailerEvents.emit('send_email', {
                templateName: 'fintech-mail',
                variables: {
                    tag: t('emails.fintech.donation.tag'),
                    title: t('emails.fintech.donation.title'),
                    message: t('emails.fintech.donation.msg'),
                    label_1: t('emails.fintech.donation.amount'),
                    val_1: `${userCurrency} ${parseFloat(newDonation.amount).toFixed(2)}`,
                    label_2: t('emails.fintech.donation.project'),
                    val_2: newDonation.projects?.project_name
                },
                to: decrypt(newDonation.user.email),
                subjectKey: 'emails.fintech.subjects.donation',
                user: newDonation.user,
            });
        }

        const projectOwnerId = newDonation.projects?.owner_user_id;
        if (projectOwnerId && projectOwnerId !== Number(donated_user_id)) {
            const owner = await prisma.user.findUnique({ where: { user_id: projectOwnerId } });
            if (owner?.email) {
                const lng = emailLngFromUser(owner);
                const t = i18next.getFixedT(lng);
                const base = (process.env.FRONTEND_URL || 'https://strug.ca').replace(/\/$/, '');
                mailerEvents.emit('send_email', {
                    templateName: 'community-mail',
                    variables: {
                        title: t('emails.community.donation_title'),
                        message: t('emails.community.donation_message', {
                            amount: `${owner.currency || 'CAD'} ${parseFloat(newDonation.amount).toFixed(2)}`,
                            project: newDonation.projects?.project_name || 'your campaign',
                        }),
                        url: `${base}/raise`,
                        button_text: t('emails.community.donation_button'),
                    },
                    to: decrypt(owner.email),
                    subjectKey: 'emails.community.donation_subject',
                    user: owner,
                });
            }
        }

        res.status(201).json({ successful: true, message: "Donation receipt sent." });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});
/**
 * Update donation
 */
router.put('/:donation_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { donation_id } = req.params;
    const { shipping_name, shipping_email, shipping_address } = req.body;

    const existing = await loadDonation(donation_id);

    if (!existing) return res.status(404).json({ error: 'Donation not found' });
    if (existing.donated_user_id !== req.user.user_id && !isAdmin(req))
      return res.status(403).json({ error: 'Forbidden' });

    const updatedDonation = await prisma.donations.update({
      where: { donation_id: Number(donation_id) },
      data: {
        shipping_name: shipping_name !== undefined ? (shipping_name ? String(shipping_name).trim() : null) : existing.shipping_name,
        shipping_email: shipping_email !== undefined ? (shipping_email ? String(shipping_email).trim() : null) : existing.shipping_email,
        shipping_address: shipping_address !== undefined ? (shipping_address ? String(shipping_address).trim() : null) : existing.shipping_address,
      },
    });

    io?.emit('donation-updated', updatedDonation);

    res.json(updatedDonation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update donation' });
  }
});




/**
 * Delete donation
 */
router.delete('/:donation_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins may delete donations' });
    const deleted = await prisma.donations.delete({
      where: { donation_id: Number(req.params.donation_id) },
    });

    io?.emit('donation-deleted', { donation_id: deleted.donation_id });

    res.json({ message: 'Donation deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete donation' });
  }
});

/**
 * PATCH /:donation_id/confirm — manual reconciliation for a donation payment.
 */
router.patch('/:donation_id/confirm', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const donation_id = Number(req.params.donation_id);
    if (Number.isNaN(donation_id)) return res.status(400).json({ successful: false, message: 'donation_id must be a number' });

    const donation = await loadDonation(donation_id);
    if (!donation) return res.status(404).json({ successful: false, message: 'Donation not found' });
    // Manual reconciliation flips a donation to `paid` and inflates the project's withdrawable
    // raised total WITHOUT any Stripe verification — so it must be admin/finance only. Letting
    // the project owner call it lets them fund their own campaign with unpaid donations.
    if (!isAdmin(req)) {
      return res.status(403).json({ successful: false, message: 'Only an admin may confirm a donation payment' });
    }

    if (donation.payment_status !== 'paid') {
      await prisma.donations.update({
        where: { donation_id },
        data: {
          payment_status: 'paid',
          paid_at: new Date(),
          refund_status: 'none',
          refund_amount: 0,
        },
      });
      if (donation.reward_tier_id) {
        await prisma.reward_tier.update({
          where: { tier_id: donation.reward_tier_id },
          data: { claimed_count: { increment: 1 } },
        }).catch(() => {});
      }
      await reconcileProjectAmount(donation.project_id);
    }

    io?.to(`user-${donation.donated_user_id}`).emit(`donation-confirmed-${donation_id}`, { donation_id, confirmed_by: req.user.user_id });

    return res.json({ successful: true, message: 'Donation confirmed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to confirm donation' });
  }
});

router.patch('/:donation_id/fulfillment', authenticateToken, async (req, res) => {
  try {
    const donation = await loadDonation(req.params.donation_id);
    if (!donation) return res.status(404).json({ error: 'Donation not found' });
    if (donation.projects?.owner_user_id !== req.user.user_id && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { fulfillment_status, fulfillment_note, tracking_number, tracking_url } = req.body;
    const allowed = new Set(['pending', 'in_progress', 'fulfilled', 'refunded', 'not_required']);
    const nextStatus = allowed.has(String(fulfillment_status || '').trim()) ? String(fulfillment_status).trim() : donation.fulfillment_status;
    const updated = await prisma.donations.update({
      where: { donation_id: donation.donation_id },
      data: {
        fulfillment_status: nextStatus,
        fulfillment_note: fulfillment_note !== undefined ? (fulfillment_note ? String(fulfillment_note) : null) : donation.fulfillment_note,
        tracking_number: tracking_number !== undefined ? (tracking_number ? String(tracking_number) : null) : donation.tracking_number,
        tracking_url: tracking_url !== undefined ? (tracking_url ? String(tracking_url) : null) : donation.tracking_url,
      },
      include: {
        reward_tier: true,
        projects: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fulfillment' });
  }
});

router.post('/:donation_id/refund', authenticateToken, async (req, res) => {
  try {
    const donation = await loadDonation(req.params.donation_id);
    if (!donation) return res.status(404).json({ error: 'Donation not found' });
    if (donation.projects?.owner_user_id !== req.user.user_id && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (donation.refund_status === 'refunded') {
      return res.status(409).json({ error: 'Donation already refunded' });
    }
    if (donation.payment_status !== 'paid') {
      return res.status(409).json({ error: 'Only paid donations can be refunded' });
    }

    if (donation.payment_intent_id) {
      if (!stripe) return res.status(503).json({ error: 'Payments are temporarily unavailable.' });
      await stripe.refunds.create({ payment_intent: donation.payment_intent_id });
    }

    const updated = await prisma.donations.update({
      where: { donation_id: donation.donation_id },
      data: {
        payment_status: 'refunded',
        refund_status: 'refunded',
        refund_amount: donation.amount,
        refunded_at: new Date(),
        refunded_by_user_id: req.user.user_id,
        fulfillment_status: donation.reward_tier_id ? 'refunded' : donation.fulfillment_status,
      },
      include: {
        reward_tier: true,
        projects: true,
      },
    });
    if (donation.reward_tier_id) {
      await prisma.reward_tier.update({
        where: { tier_id: donation.reward_tier_id },
        data: { claimed_count: { decrement: 1 } },
      }).catch(() => {});
    }
    await reconcileProjectAmount(donation.project_id);
    res.json({ successful: true, donation: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to refund donation' });
  }
});

export default router;
