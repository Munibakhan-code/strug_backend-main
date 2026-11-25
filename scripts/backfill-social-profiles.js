// scripts/backfill-social-profiles.js
import dotenv from 'dotenv';
dotenv.config(); // Load .env variables before importing other modules

import prisma from '../utils/prisma-client.js';
import { resolveProfileFallbackData } from '../utils/profile-identity.js';

/**
 * PRODUCTION-GRADE LEGACY BACKFILL SCRIPT (Resilient Version)
 *
 * Purpose:
 * Finds all existing `user` records in the database that do NOT have
 * an associated `social_profile` row, and provisions one for them safely.
 *
 * Characteristics:
 * - Direct resilient insertion to social_profile
 * - Explicit field selection (bypasses unmigrated DB columns like is_driver)
 * - Idempotent (Can be executed multiple times with zero duplicate errors)
 * - Cursor-based Batch Processing (RAM & DB connection safety)
 * - Dry-Run Capability (Allows simulating without writing DB changes)
 *
 * Usage:
 *   node scripts/backfill-social-profiles.js              (Executes real backfill)
 *   node scripts/backfill-social-profiles.js --dry-run    (Simulates backfill safely)
 */

const BATCH_SIZE = 100;
const isDryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

async function runBackfill() {
  console.log(`\n🚀 [BACKFILL] Starting Social Profile Backfill Engine...`);
  if (isDryRun) {
    console.log(`⚠️  [DRY RUN MODE] No changes will be written to the database.\n`);
  }

  let totalProcessed = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  try {
    // 1. Count total legacy users needing a social profile
    const targetUsersCount = await prisma.user.count({
      where: {
        social_profiles: null,
      },
    });

    console.log(`📊 Found ${targetUsersCount} users missing a social_profile record.\n`);

    if (targetUsersCount === 0) {
      console.log(`✅ All users already have a social profile. Nothing to backfill!\n`);
      return;
    }

    // 2. Batch processing loop using Cursor Pagination
    let cursorUserId = 0;

    while (true) {
      const usersBatch = await prisma.user.findMany({
        where: {
          user_id: { gt: cursorUserId },
          social_profiles: null,
        },
        take: BATCH_SIZE,
        orderBy: { user_id: 'asc' },
        select: { user_id: true, name: true, username: true },
      });

      if (usersBatch.length === 0) break;

      console.log(`🔄 Processing batch of ${usersBatch.length} users (user_id > ${cursorUserId})...`);

      for (const user of usersBatch) {
        cursorUserId = user.user_id; // Advance cursor
        totalProcessed++;

        try {
          // Double-check idempotency
          const existingCheck = await prisma.social_profile.findUnique({
            where: { user_id: user.user_id },
            select: { profile_id: true },
          });

          if (existingCheck) {
            totalSkipped++;
            continue;
          }

          // Resolve fallbacks for handle, display name, images, bio via Phase 1 helper
          const fallback = await resolveProfileFallbackData(prisma, user.user_id);

          if (isDryRun) {
            console.log(`   [DRY-RUN] Would create profile for User #${user.user_id} -> Handle: "@${fallback.handle}", Name: "${fallback.display_name}"`);
            totalCreated++;
          } else {
            // 1. Create Social Profile (Explicit select avoids querying missing DB columns)
            await prisma.social_profile.create({
              data: {
                user_id: user.user_id,
                handle: fallback.handle,
                display_name: fallback.display_name,
                bio: fallback.bio,
                profile_pic_url: fallback.profile_pic_url,
                banner_url: fallback.banner_url,
                accepted_terms: true,
              },
              select: { profile_id: true },
            });

            // 2. Best-effort Username sync on User table
            if (!user.username) {
              await prisma.user.update({
                where: { user_id: user.user_id },
                data: { username: fallback.handle },
                select: { user_id: true, username: true },
              }).catch(() => {
                // Ignore if user table has unmigrated column issues
              });
            }

            totalCreated++;
          }
        } catch (userErr) {
          totalFailed++;
          console.error(`❌ Failed to backfill profile for User #${user.user_id}: ${userErr.message}`);
        }
      }

      console.log(`   Batch complete. Progress: ${totalProcessed}/${targetUsersCount}\n`);
    }

    console.log(`==================================================`);
    console.log(`🎉 [BACKFILL COMPLETE] Summary:`);
    console.log(`   - Total Candidates: ${targetUsersCount}`);
    console.log(`   - Total Processed:  ${totalProcessed}`);
    console.log(`   - Successfully ${isDryRun ? 'Simulated' : 'Created'}: ${totalCreated}`);
    console.log(`   - Skipped (Existed): ${totalSkipped}`);
    console.log(`   - Failed: ${totalFailed}`);
    console.log(`==================================================\n`);

  } catch (err) {
    console.error(`💥 [CRITICAL ERROR] Backfill script terminated unexpectedly:`, err);
  } finally {
    await prisma.$disconnect();
  }
}

runBackfill();