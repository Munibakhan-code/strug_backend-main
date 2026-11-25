// services/board-rbac.js
//
// RBAC v2 for the internal board. Single source of truth for:
//   • the catalog of dashboards that can be granted (DASHBOARDS)
//   • the built-in role presets (BUILTIN_ROLES)
//   • the resolver that turns a member + their role into an effective access map
//
// Enforcement model:
//   - Each grantable dashboard has a level: "read" | "write" (absent = "none").
//   - A role carries an `access` map ({ dashboardId: level }) + coarse capabilities
//     (manage_members / review_tasks / assign_tasks).
//   - A member holds one role and MAY carry `access_overrides` ({ dashboardId:
//     "none"|"read"|"write" }) that a super-admin sets to hand-tune that one person
//     ("Custom"). Effective access = role.access with the overrides applied.
//   - is_super_admin is the hard, exclusive gate: a super-admin implicitly has WRITE on
//     every dashboard incl. God Mode, plus every capability. It is NOT expressible via the
//     access map — God Mode / role administration are always super-only.

// The grantable dashboards (ids match the frontend navConfig ids). God Mode is intentionally
// NOT here — it is gated by is_super_admin alone and can never be handed out via a role.
const DASHBOARDS = [
  { id: 'hr',                  label: 'HR & People Ops' },
  { id: 'finance',             label: 'Finance' },
  { id: 'engineering',         label: 'Engineering' },
  { id: 'operations',          label: 'Operations' },
  { id: 'product',             label: 'Product' },
  { id: 'customer-support',    label: 'Customer Support' },
  { id: 'analytics',           label: 'Data & Analytics' },
  { id: 'communications',      label: 'Communications' },
  { id: 'user-management',     label: 'User Management' },
  { id: 'vertical-management', label: 'Vertical Management' },
  { id: 'content-moderation',  label: 'Content Moderation' },
  { id: 'payments-risks',      label: 'Payments & Risks' },
  { id: 'marketing-api',       label: 'Marketing API' },
  { id: 'creator-ops',         label: 'Creator & Social Media Ops' },
  { id: 'kyc',                 label: 'KYC & Verification' },
  { id: 'social-media',        label: 'Social Media' },
  { id: 'campaigns',           label: 'Campaign Management' },
];

const DASHBOARD_IDS = DASHBOARDS.map((d) => d.id);
const GOD_MODE_ID = 'god-mode';
const LEVELS = ['none', 'read', 'write'];

// Helpers to build access maps for the presets.
const allAt = (level) => Object.fromEntries(DASHBOARD_IDS.map((id) => [id, level]));
const only = (entries) => ({ ...entries }); // readability wrapper

// Built-in role presets. `key` is the stable slug; assigning a role copies nothing —
// enforcement always resolves live from the role, so editing a built-in's access would
// propagate (built-ins are seeded and not meant to be edited via the UI).
const BUILTIN_ROLES = [
  {
    key: 'super_admin',
    can_create_channels: true,
    name: 'Super Admin',
    description: 'Full control of every dashboard plus God Mode and role administration. Reserved for platform owners.',
    is_builtin: true,
    is_super_admin: true,
    manage_members: true,
    review_tasks: true,
    assign_tasks: true,
    access: allAt('write'), // moot (super implies write-all) but explicit for display
  },
  {
    key: 'administrator',
    can_create_channels: true,
    name: 'Administrator',
    description: 'Read and write on every operational dashboard, and can manage staff. Cannot access God Mode or grant roles.',
    is_builtin: true,
    manage_members: true,
    review_tasks: true,
    assign_tasks: true,
    access: allAt('write'),
  },
  {
    key: 'hr',
    name: 'HR & People Ops',
    description: 'Manages the internal staff roster. Full HR dashboard, plus read access to Communications and User Management.',
    is_builtin: true,
    manage_members: true,
    access: only({ hr: 'write', communications: 'read', 'user-management': 'read' }),
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Runs Finance and Payments & Risks (payouts, disputes), with read access to Analytics.',
    is_builtin: true,
    access: only({ finance: 'write', 'payments-risks': 'write', analytics: 'read' }),
  },
  {
    key: 'compliance',
    name: 'Compliance',
    description: 'Owns KYC & Verification, with read-only visibility across all other dashboards.',
    is_builtin: true,
    access: { ...allAt('read'), kyc: 'write' },
  },
  {
    key: 'support',
    name: 'Customer Support',
    description: 'Handles Customer Support and user accounts. Full Customer Support and User Management, plus read on Communications.',
    is_builtin: true,
    access: only({ 'customer-support': 'write', 'user-management': 'write', communications: 'read' }),
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Read-only visibility across all operational dashboards. Cannot change anything, and cannot see KYC.',
    is_builtin: true,
    access: (() => { const a = allAt('read'); delete a.kyc; return a; })(),
  },
  {
    key: 'engineer',
    name: 'Engineer',
    description: 'Works the Engineering board — create/edit tasks and review or assign work.',
    is_builtin: true,
    review_tasks: true,
    assign_tasks: true,
    access: only({ engineering: 'write' }),
  },
  {
    key: 'member',
    name: 'Member',
    description: 'An approved staff account with no dashboard access yet. Assign a role to grant access.',
    is_builtin: true,
    access: {},
  },
];

const BUILTIN_ROLE_KEYS = BUILTIN_ROLES.map((r) => r.key);

// Normalize a stored access map: keep only known dashboards + valid levels.
function sanitizeAccess(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of DASHBOARD_IDS) {
      const v = raw[id];
      if (v === 'read' || v === 'write') out[id] = v;
    }
  }
  return out;
}

// Normalize an overrides map: allows "none" (to subtract) in addition to read/write.
function sanitizeOverrides(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of DASHBOARD_IDS) {
      const v = raw[id];
      if (v === 'none' || v === 'read' || v === 'write') out[id] = v;
    }
  }
  return out;
}

// Effective per-dashboard access map for a member. `role` is the member's board_role row
// (or null). Super-admins implicitly get write on everything (incl. God Mode).
function effectiveAccess(member, role) {
  if (member?.is_super_admin) {
    return { ...allAt('write'), [GOD_MODE_ID]: 'write' };
  }
  const base = sanitizeAccess(role?.access);
  const overrides = sanitizeOverrides(member?.access_overrides);
  const merged = { ...base };
  for (const [id, lvl] of Object.entries(overrides)) {
    if (lvl === 'none') delete merged[id];
    else merged[id] = lvl;
  }
  return merged;
}

// The member's coarse capabilities (super => all).
function effectiveCaps(member, role) {
  if (member?.is_super_admin) {
    return { manage_members: true, review_tasks: true, assign_tasks: true };
  }
  return {
    manage_members: !!role?.manage_members,
    review_tasks: !!role?.review_tasks,
    assign_tasks: !!role?.assign_tasks,
  };
}

// Does the member meet `needed` ("read"|"write") on `dashboardId`?
function hasDashboardAccess(access, dashboardId, needed) {
  if (dashboardId === GOD_MODE_ID) return access[GOD_MODE_ID] === 'write';
  const lvl = access[dashboardId] || 'none';
  if (needed === 'write') return lvl === 'write';
  return lvl === 'read' || lvl === 'write';
}

// Best-fit built-in role key for a legacy member from their old can_* flags (used by the
// seed to backfill existing members so nothing regresses on cutover).
function legacyRoleKey(member) {
  if (member.is_super_admin) return 'super_admin';
  if (member.can_manage_members) return 'administrator';
  if (member.can_access_restricted) return 'compliance';
  if (member.can_assign || member.can_review) return 'engineer';
  if (member.can_view_users) return 'analyst';
  return 'member';
}

// Public shape of a role row for the API.
function publicRole(role) {
  if (!role) return null;
  return {
    role_id: role.role_id,
    key: role.key,
    name: role.name,
    description: role.description,
    is_builtin: role.is_builtin,
    is_super_admin: role.is_super_admin,
    access: sanitizeAccess(role.access),
    manage_members: role.manage_members,
    review_tasks: role.review_tasks,
    assign_tasks: role.assign_tasks,
    can_create_channels: !!role.can_create_channels,
  };
}

// The member shape returned to the internal dashboards. Includes the resolved access map
// + caps + role so the frontend can gate on them. Legacy can_* fields are derived from the
// new model (faithful to their new meaning) for any not-yet-migrated consumer.
function memberPublicView(member, role) {
  const access = effectiveAccess(member, role);
  const caps = effectiveCaps(member, role);
  return {
    member_id: member.member_id,
    name: member.name,
    email: member.email,
    avatar_url: member.avatar_url ?? null,
    status: member.status,
    is_super_admin: !!member.is_super_admin,
    role: role ? { role_id: role.role_id, key: role.key, name: role.name } : null,
    access,
    caps,
    access_overrides: sanitizeOverrides(member.access_overrides),
    // Derived legacy flags (transitional).
    can_manage_members: caps.manage_members,
    can_assign: caps.assign_tasks,
    can_review: caps.review_tasks,
    can_view_users: !!access['user-management'],
    can_access_restricted: !!access['kyc'],
  };
}

export {
  DASHBOARDS,
  DASHBOARD_IDS,
  GOD_MODE_ID,
  LEVELS,
  BUILTIN_ROLES,
  BUILTIN_ROLE_KEYS,
  sanitizeAccess,
  sanitizeOverrides,
  effectiveAccess,
  effectiveCaps,
  hasDashboardAccess,
  legacyRoleKey,
  publicRole,
  memberPublicView,
};
