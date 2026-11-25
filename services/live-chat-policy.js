import prisma from '../utils/prisma-client.js';
import { isSubscribed } from './live-subscription.js';

// Ban checks fail CLOSED. Soft mode gates (followers/subs) fail open.

export async function getChatPolicy(session_id) {
	const session = await prisma.live_session.findUnique({
		where: { session_id: Number(session_id) },
		select: {
			streamer: {
				select: {
					streamer_id: true,
					user_id: true,
					chat_mode: true,
					slow_mode_ms: true,
					banned_words: { select: { word: true } },
				},
			},
		},
	});
	const s = session?.streamer;
	if (!s) return null;
	return {
		streamer_id: s.streamer_id,
		owner_user_id: s.user_id,
		chat_mode: s.chat_mode || 'PUBLIC',
		slow_mode_ms: s.slow_mode_ms || 0,
		banned_words: s.banned_words.map(w => w.word?.toLowerCase().trim()).filter(Boolean),
	};
}

function wordBlocked(text, bannedWords) {
	if (!bannedWords?.length) return false;
	const lower = String(text).toLowerCase();
	return bannedWords.some((w) => {
		if (!w) return false;
		try {
			const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`, 'i');
			return re.test(lower);
		} catch {
			return lower.includes(w);
		}
	});
}

/** Returns rejection reason string or null. Also supports legacy callers expecting a string. */
export async function chatRejectReason(policy, user_id, text) {
	const result = await chatRejectDetail(policy, user_id, text);
	return result.reason;
}

export async function chatRejectDetail(policy, user_id, text) {
	if (!policy || !user_id) return { reason: null };
	if (user_id === policy.owner_user_id) return { reason: null };

	try {
		const ban = await prisma.live_chat_ban.findUnique({
			where: { streamer_id_user_id: { streamer_id: policy.streamer_id, user_id } },
			select: { expires_at: true },
		});
		if (ban && (!ban.expires_at || ban.expires_at > new Date())) {
			return { reason: 'Banned', hardFail: true };
		}
	} catch (err) {
		console.error('[live-chat-policy] ban check failed — failing closed:', err?.message);
		return { reason: 'Moderation_Unavailable', hardFail: true };
	}

	if (wordBlocked(text, policy.banned_words)) {
		return { reason: 'Message_Blocked', hardFail: true };
	}

	try {
		const isMod = await prisma.live_chat_moderator.findUnique({
			where: { streamer_id_user_id: { streamer_id: policy.streamer_id, user_id } },
			select: { mod_id: true },
		});
		if (isMod) return { reason: null };
	} catch { /* soft */ }

	try {
		if (policy.chat_mode === 'SUBSCRIBERS_ONLY') {
			const subbed = await isSubscribed(user_id, policy.streamer_id);
			if (!subbed) return { reason: 'Subscribers_Only' };
		} else if (policy.chat_mode === 'FOLLOWERS_ONLY') {
			const follows = await isFollowing(user_id, policy.owner_user_id);
			if (!follows) return { reason: 'Followers_Only' };
		}
	} catch (err) {
		console.debug('[live-chat-policy] soft mode check failed, allowing:', err?.message);
	}
	return { reason: null };
}

async function isFollowing(viewerUserId, streamerUserId) {
	const [viewer, streamer] = await Promise.all([
		prisma.social_profile.findUnique({ where: { user_id: viewerUserId }, select: { profile_id: true } }),
		prisma.social_profile.findUnique({ where: { user_id: streamerUserId }, select: { profile_id: true } }),
	]);
	if (!viewer || !streamer) return false;
	const edge = await prisma.follower.findUnique({
		where: { follower_id_following_id: { follower_id: viewer.profile_id, following_id: streamer.profile_id } },
		select: { id: true },
	});
	return !!edge;
}
