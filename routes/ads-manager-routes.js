import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const initAccountSchema = z.object({
  currency: z.enum(['LKR', 'USD', 'CAD']).default('CAD')
});

const profileUpdateSchema = z.object({
  business_name: z.string().min(2).max(255),
  tax_id: z.string().min(5).max(50),
  brn: z.string().min(5).max(50),
  address: z.string().min(5).max(500)
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADVERTISER', 'ANALYST'])
});

const updateMemberSchema = z.object({
  role: z.enum(['ADVERTISER', 'ANALYST'])
});

const billingThresholdSchema = z.object({
  billing_threshold: z.number().nonnegative()
});

const brandProfileSchema = z.object({
  brand_name: z.string().min(2).max(255),
  logo_url: z.string().url().nullable().optional(),
  website: z.string().url().nullable().optional()
});

router.post('/account/init', authenticateToken, async (req, res, next) => {
  try {
    const validated = initAccountSchema.parse(req.body);
    const userId = req.user.user_id;

    const existingProfile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (existingProfile) {
      return res.status(409).json({
        successful: false,
        message: "Ad Account already initialized."
      });
    }

    const coreWallet = await prisma.strug_wallet.findUnique({
      where: { user_id: userId }
    });

    const accountCurrency = coreWallet?.currency || validated.currency;

    const result = await prisma.$transaction(async (tx) => {
      const profile = await tx.ads_account_profile.create({
        data: {
          user_id: userId,
          currency: accountCurrency,
          status: "UNDER_REVIEW"
        }
      });

      await tx.ads_wallet.create({
        data: {
          user_id: userId,
          currency: accountCurrency,
          balance: 0.00
        }
      });

      await tx.ads_member.create({
        data: {
          profile_id: profile.profile_id,
          user_id: userId,
          role: "OWNER"
        }
      });

      return profile;
    });

    return res.status(201).json({
      successful: true,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/account/me', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId },
      include: {
        members: {
          include: {
            user: {
              select: {
                user_id: true,
                name: true,
                email: true
              }
            }
          }
        },
        tos_agreements: true,
        brands: true
      }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const wallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    const checklist = {
      profile_setup: profile.setup_completed,
      tos_signed: profile.tos_agreements.length > 0,
      wallet_active: wallet !== null,
      verification_status: profile.status
    };

    return res.json({
      successful: true,
      data: {
        ...profile,
        ads_wallet: wallet
      },
      checklist
    });
  } catch (err) {
    next(err);
  }
});

router.put('/account/profile', authenticateToken, async (req, res, next) => {
  try {
    const validated = profileUpdateSchema.parse(req.body);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not initialized."
      });
    }

    const updated = await prisma.ads_account_profile.update({
      where: { user_id: userId },
      data: {
        business_name: validated.business_name,
        tax_id: validated.tax_id,
        brn: validated.brn,
        address: validated.address,
        setup_completed: true,
        status: "ACTIVE"
      }
    });

    // tax_id / brn are globally omitted (#1292); never echo them back on save.
    return res.json({
      successful: true,
      data: {
        profile_id: updated.profile_id,
        user_id: updated.user_id,
        business_name: updated.business_name,
        address: updated.address,
        setup_completed: updated.setup_completed,
        status: updated.status,
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/workspace/members', authenticateToken, async (req, res, next) => {
  try {
    const validated = addMemberSchema.parse(req.body);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const encryptedEmail = (await import('../utils/crypto.js')).encryptSearch(validated.email);
    const targetUser = await prisma.user.findUnique({
      where: { email: encryptedEmail }
    });

    if (!targetUser) {
      return res.status(404).json({
        successful: false,
        message: "User with this email not found."
      });
    }

    const member = await prisma.ads_member.create({
      data: {
        profile_id: profile.profile_id,
        user_id: targetUser.user_id,
        role: validated.role
      }
    });

    return res.status(201).json({
      successful: true,
      data: member
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err.code === 'P2002') {
      return res.status(409).json({
        successful: false,
        message: "User is already a member of this workspace."
      });
    }
    next(err);
  }
});

router.put('/workspace/members/:member_id', authenticateToken, async (req, res, next) => {
  try {
    const memberId = Number(req.params.member_id);
    const validated = updateMemberSchema.parse(req.body);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const member = await prisma.ads_member.findFirst({
      where: {
        member_id: memberId,
        profile_id: profile.profile_id
      }
    });

    if (!member) {
      return res.status(404).json({
        successful: false,
        message: "Member not found in this workspace."
      });
    }

    const updated = await prisma.ads_member.update({
      where: { member_id: memberId },
      data: { role: validated.role }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.delete('/workspace/members/:member_id', authenticateToken, async (req, res, next) => {
  try {
    const memberId = Number(req.params.member_id);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const member = await prisma.ads_member.findFirst({
      where: {
        member_id: memberId,
        profile_id: profile.profile_id
      }
    });

    if (!member) {
      return res.status(404).json({
        successful: false,
        message: "Member not found in this workspace."
      });
    }

    if (member.role === 'OWNER') {
      return res.status(400).json({
        successful: false,
        message: "Cannot remove the owner of the Ad Account."
      });
    }

    await prisma.ads_member.delete({
      where: { member_id: memberId }
    });

    return res.json({
      successful: true,
      message: "Member removed successfully."
    });
  } catch (err) {
    next(err);
  }
});

router.post('/account/tos/sign', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const agreement = await prisma.ads_tos_agreement.create({
      data: {
        profile_id: profile.profile_id,
        signed_by_user_id: userId,
        ip_address: ipAddress
      }
    });

    return res.status(201).json({
      successful: true,
      data: agreement
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/account/billing-threshold', authenticateToken, async (req, res, next) => {
  try {
    const validated = billingThresholdSchema.parse(req.body);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const updated = await prisma.ads_account_profile.update({
      where: { user_id: userId },
      data: { billing_threshold: validated.billing_threshold }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.patch('/account/sandbox', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const updated = await prisma.ads_account_profile.update({
      where: { user_id: userId },
      data: { sandbox_enabled: !profile.sandbox_enabled }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

router.post('/workspace/brands', authenticateToken, async (req, res, next) => {
  try {
    const validated = brandProfileSchema.parse(req.body);
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const brand = await prisma.ads_brand_profile.create({
      data: {
        profile_id: profile.profile_id,
        brand_name: validated.brand_name,
        logo_url: validated.logo_url || null,
        website: validated.website || null
      }
    });

    return res.status(201).json({
      successful: true,
      data: brand
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/workspace/brands', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "Ad Account not found."
      });
    }

    const brands = await prisma.ads_brand_profile.findMany({
      where: { profile_id: profile.profile_id }
    });

    return res.json({
      successful: true,
      data: brands
    });
  } catch (err) {
    next(err);
  }
});

export default router;