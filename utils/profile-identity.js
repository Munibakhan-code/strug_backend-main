// utils/profile-identity.js
import crypto from 'crypto';
import { checkHandleAvailability } from './handle-availability.js';

/**
 * PRODUCTION-GRADE IDENTITY & DATA CONSISTENCY ENGINE (Main Account Strict Version)
 * 
 * Purpose:
 * 1. Sanitizes raw handles (lowercase, length check, legal regex characters only).
 * 2. Resolves handle collisions safely by appending short cryptographic hex suffixes.
 * 3. Strictly pulls display name and username ONLY from the Main User Account (user table).
 */

/**
 * Sanitizes input string into a valid social handle format.
 * Rules: lowercase, no spaces/special chars except dots and underscores, min 3, max 30 chars.
 *
 * @param {string} rawInput
 * @param {number|string} [fallbackId='']
 * @returns {string}
 */
export function sanitizeHandle(rawInput, fallbackId = '') {
  if (!rawInput || typeof rawInput !== 'string') {
    return `user${fallbackId || crypto.randomBytes(3).toString('hex')}`.slice(0, 30);
  }

  let cleaned = rawInput
    .trim()
    .toLowerCase()
    .replace(/^@+/, '') // Remove leading @ symbols
    .replace(/[^a-z0-9._]/g, ''); // Allow only alphanumeric, dots, underscores

  if (cleaned.length < 3) {
    cleaned = `user${fallbackId || ''}_${cleaned}`.replace(/[^a-z0-9._]/g, '');
  }

  if (cleaned.length < 3) {
    cleaned = `user_${crypto.randomBytes(3).toString('hex')}`;
  }

  return cleaned.slice(0, 30);
}

/**
 * Generates a collision-free handle by checking availability across all system namespaces.
 * If occupied, appends a 4-character cryptographic hex suffix.
 *
 * @param {string} baseInput
 * @param {number} userId
 * @returns {Promise<string>}
 */
export async function resolveUniqueHandle(baseInput, userId) {
  const candidate = sanitizeHandle(baseInput, userId);

  // Check primary candidate availability
  const check = await checkHandleAvailability(candidate, userId);
  if (check.available) {
    return candidate;
  }

  // Handle collision by appending unique hex suffixes (Max 5 attempts)
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(2).toString('hex'); // 4-char hex
    const suffixCandidate = `${candidate.slice(0, 25)}_${suffix}`;
    const retryCheck = await checkHandleAvailability(suffixCandidate, userId);
    if (retryCheck.available) {
      return suffixCandidate;
    }
  }

  // Extreme fallback guarantee
  return `user${userId}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 30);
}

/**
 * Resolves profile details STRICTLY from the Main User Account (user table).
 * Does NOT query sibling store or streamer profiles.
 *
 * Priority Order:
 * 1. Direct explicit inputs
 * 2. Main User Account table (`user.name`, `user.username`)
 *
 * @param {object} prismaClient - Prisma Client instance
 * @param {number} userId
 * @param {object} [explicitData={}]
 * @returns {Promise<{
 *   userObj: object|null,
 *   handle: string,
 *   display_name: string,
 *   bio: string|null,
 *   profile_pic_url: string|null,
 *   banner_url: string|null
 * }>}
 */
export async function resolveProfileFallbackData(prismaClient, userId, explicitData = {}) {
  if (!userId || !Number.isInteger(Number(userId))) {
    throw new Error('[ProfileIdentity] Invalid or missing userId passed to fallback resolver.');
  }

  // Query ONLY the Main User Account table
  const userObj = await prismaClient.user.findUnique({
    where: { user_id: userId },
    select: { name: true, username: true, email: true },
  });

  const resolvedDisplayName =
    explicitData.display_name?.trim() ||
    userObj?.name?.trim() ||
    `User ${userId}`;

  const resolvedBio = explicitData.bio?.trim() || null;
  const resolvedProfilePic = explicitData.profile_pic_url || null;
  const resolvedBannerUrl = explicitData.banner_url || null;

  const rawHandle = explicitData.handle || userObj?.username || `user${userId}`;
  const resolvedHandle = await resolveUniqueHandle(rawHandle, userId);

  return {
    userObj,
    handle: resolvedHandle,
    display_name: resolvedDisplayName,
    bio: resolvedBio,
    profile_pic_url: resolvedProfilePic,
    banner_url: resolvedBannerUrl,
  };
}