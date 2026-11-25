// Shared community moderation helpers (#264/#268). Used by community-routes.js and
// community_posts-routes.js so mod/ban checks stay consistent across both routers.
import prisma from './prisma-client.js';

export const MOD_PERMISSIONS = ['all', 'manage_users', 'manage_posts', 'manage_flair', 'manage_settings'];

// Resolve a user's moderation standing in a community. Owner has all permissions.
export async function getModContext(communityId, userId) {
    const community = await prisma.community.findUnique({
        where: { community_id: communityId },
        select: { created_by: true },
    });
    if (!community) return { exists: false, isOwner: false, isMod: false, perms: [], can: () => false, created_by: null };

    const isOwner = String(community.created_by) === String(userId);
    let mod = null;
    if (!isOwner) {
        mod = await prisma.community_moderator.findUnique({
            where: { community_id_user_id: { community_id: communityId, user_id: userId } },
            select: { permissions: true },
        });
    }
    const perms = isOwner ? ['all'] : (mod?.permissions || []);
    const can = (p) => isOwner || perms.includes('all') || perms.includes(p);
    return { exists: true, isOwner, isMod: isOwner || !!mod, perms, can, created_by: community.created_by };
}

// Is the user currently banned from the community? (Expired timeouts don't count.)
export async function isBanned(communityId, userId) {
    const ban = await prisma.community_ban.findUnique({
        where: { community_id_user_id: { community_id: communityId, user_id: userId } },
        select: { expires_at: true },
    });
    if (!ban) return false;
    if (ban.expires_at && ban.expires_at.getTime() < Date.now()) return false;
    return true;
}
