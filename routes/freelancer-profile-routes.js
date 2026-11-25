import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Create Freelancer Profile
 * POST /freelancer-profile
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      display_name,
      freelance_bio,
      tagline,
      country,
      city,
      languages,
      skills,
    } = req.body;

    // Validation
    if (!display_name || !display_name.trim()) {
      return res.status(400).json({
        successful: false,
        message: 'display_name is required.',
      });
    }

    if (!Array.isArray(languages)) {
      return res.status(400).json({
        successful: false,
        message: 'languages must be an array.',
      });
    }

    if (!Array.isArray(skills)) {
      return res.status(400).json({
        successful: false,
        message: 'skills must be an array.',
      });
    }

    // Check if profile already exists
    const existingProfile = await prisma.freelancerProfile.findUnique({
      where: {
        user_id: req.user.user_id,
      },
    });

    if (existingProfile) {
      return res.status(409).json({
        successful: false,
        message: 'Freelancer profile already exists.',
      });
    }

    // Create profile and wallet in a transaction
    const freelancerProfile = await prisma.$transaction(async (tx) => {
      // Create profile
      const profile = await tx.freelancerProfile.create({
        data: {
          user_id: req.user.user_id,
          display_name: display_name.trim(),
          freelance_bio: freelance_bio?.trim() || null,
          tagline: tagline?.trim() || null,
          country: country?.trim() || null,
          city: city?.trim() || null,
          languages,
          skills,
          status: 'APPROVED',
        },
      });

      // Create wallet for the freelancer
      await tx.freelancerWallet.create({
        data: {
          freelancer_profile_id: profile.id,
          pending_balance: 0,
          available_balance: 0,
          total_earned: 0,
          total_withdrawn: 0,
        },
      });

      return profile;
    });

    return res.status(201).json({
      successful: true,
      message: 'Freelancer profile created successfully.',
      data: freelancerProfile,
    });
  } catch (error) {
    console.error('Create Freelancer Profile Error:', error);

    return res.status(500).json({
      successful: false,
      message: 'Failed to create freelancer profile.',
    });
  }
});

/**
 * Get My Freelancer Profile
 * GET /freelancer-profile
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const freelancerProfile = await prisma.freelancerProfile.findUnique({
      where: {
        user_id: req.user.user_id,
      },
    });

    if (!freelancerProfile) {
      return res.status(404).json({
        successful: false,
        message: 'Freelancer profile not found.',
      });
    }

    return res.json({
      successful: true,
      data: freelancerProfile,
    });
  } catch (error) {
    console.error('Get Freelancer Profile Error:', error);

    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch freelancer profile.',
    });
  }
});

/**
 * Update My Freelancer Profile
 * PUT /freelancer-profile
 */
router.put('/', authenticateToken, async (req, res) => {
  try {
    const existingProfile = await prisma.freelancerProfile.findUnique({
      where: {
        user_id: req.user.user_id,
      },
    });

    if (!existingProfile) {
      return res.status(404).json({
        successful: false,
        message: 'Freelancer profile not found.',
      });
    }

    const {
      display_name,
      freelance_bio,
      tagline,
      country,
      city,
      languages,
      skills,
    } = req.body;

    const updatedProfile = await prisma.freelancerProfile.update({
      where: {
        user_id: req.user.user_id,
      },
      data: {
        display_name: display_name ?? existingProfile.display_name,
        freelance_bio: freelance_bio ?? existingProfile.freelance_bio,
        tagline: tagline ?? existingProfile.tagline,
        country: country ?? existingProfile.country,
        city: city ?? existingProfile.city,
        languages: languages ?? existingProfile.languages,
        skills: skills ?? existingProfile.skills,
      },
    });

    return res.json({
      successful: true,
      message: 'Freelancer profile updated successfully.',
      data: updatedProfile,
    });
  } catch (error) {
    console.error('Update Freelancer Profile Error:', error);

    return res.status(500).json({
      successful: false,
      message: 'Failed to update freelancer profile.',
    });
  }
});

export default router;