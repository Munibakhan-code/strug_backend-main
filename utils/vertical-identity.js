// Shared per-vertical identity resolution (bug #3 Phase 2). When a PROVIDER is shown in
// a vertical role (service provider, host, professional, driver), their display identity
// should be their vertical_profile, not their main social/user identity — with
// inherit-from-main fallback per field.
//
// Endpoints opt in by loading the provider's `user` with these relations:
//   user: { include: verticalIdentityUserInclude }
// then calling applyVerticalIdentity(user, vertical) on each embedded user.
//
// NOTE: `social_profiles` is a to-ONE relation (social_profile.user_id is @unique), so it
// must NOT carry `take` — Prisma 6.19 throws on `take` over a to-one relation (the bug that
// 500'd town-hall and every route using this util). Prisma returns it as a single object
// (or null); applyVerticalIdentity normalizes that into the 1-element array the frontend
// reads via `user.social_profiles?.[0]`.

const CONTEXT_VERTICAL = {
  rideshare: 'rideshare',
  food: 'food',
  services: 'services',
  marketplace: 'hosting',
};

export const verticalForContextType = (contextType) => CONTEXT_VERTICAL[contextType] || null;

// Standard include to attach to a `user` relation so applyVerticalIdentity can resolve.
export const verticalIdentityUserInclude = {
  vertical_profiles: { select: { vertical: true, handle: true, display_name: true, profile_pic_url: true } },
  // to-one relation → no `take` (Prisma 6.19 rejects it); applyVerticalIdentity re-wraps it.
  social_profiles: { select: { handle: true, profile_pic_url: true } },
};

// Public (unauthenticated) routes must NOT embed a bare `include: { user: true }` / the include
// above — Prisma `include` returns EVERY scalar column of `user`, which drags the owner's email,
// KYC review state and moderation history into anonymous responses. Use this select on public
// embeds: display identity only, plus the same two relations applyVerticalIdentity needs.
export const verticalIdentityUserSelect = {
  user_id: true,
  name: true,
  username: true,
  vertical_profiles: { select: { vertical: true, handle: true, display_name: true, profile_pic_url: true } },
  // to-one relation → no `take` (Prisma 6.19 rejects it); applyVerticalIdentity re-wraps it.
  social_profiles: { select: { handle: true, profile_pic_url: true } },
};

// Override an embedded user object's display identity in place with their vertical
// profile for `vertical` (each field falls back to the existing main value). Safe to
// call on a user loaded via verticalIdentityUserInclude; a no-op without a vertical or
// a matching customized profile.
export function applyVerticalIdentity(user, vertical) {
  if (!user) return user;
  // social_profiles is a to-one relation → Prisma returns an object (or null), but every
  // consumer reads `user.social_profiles?.[0]`. Normalize to a 1-element array (or []) for
  // ALL embedded users, with or without a vertical profile override.
  const spRaw = user.social_profiles;
  user.social_profiles = spRaw ? (Array.isArray(spRaw) ? spRaw : [spRaw]) : [];
  if (!vertical) return user;
  const vp = (user.vertical_profiles || []).find((v) => v.vertical === vertical);
  if (!vp) return user;
  if (vp.display_name) user.name = vp.display_name;
  const sp = user.social_profiles[0] || {};
  user.social_profiles = [{
    ...sp,
    handle: vp.handle || sp.handle || null,
    profile_pic_url: vp.profile_pic_url || sp.profile_pic_url || null,
  }];
  // Also expose flat fields for clients that read them directly off the provider's user.
  user.vertical_display_name = vp.display_name || null;
  user.vertical_handle = vp.handle || null;
  user.vertical_profile_pic_url = vp.profile_pic_url || null;
  return user;
}
