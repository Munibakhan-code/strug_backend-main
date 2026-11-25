// middleware/authenticate-board.js
//
// Auth for the internal Task Board / dashboards. Verifies the JWT, requires
// permission==="board", loads the member AND their role (board_role), rejects unless
// status==="approved", and attaches:
//   req.member      — the member row (no password)
//   req.memberRole  — the board_role row (or null)
//   req.access      — resolved { dashboardId: "read"|"write" } effective access map
//   req.caps        — { manage_members, review_tasks, assign_tasks }
//
// Everything is re-read from the DB on every request (never trusted from the token), so
// revoking a role / editing access / deactivating a member takes effect immediately.
//
// RBAC v2 (2026-07-13): dashboards are gated by requireDashboard(id, level) against the
// resolved access map. The legacy capability guards are kept (reimplemented on the new
// model) so older imports keep working; is_super_admin remains the hard exclusive gate.

import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma-client.js';
import { effectiveAccess, effectiveCaps, hasDashboardAccess } from '../services/board-rbac.js';

function authenticateBoard(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ successful: false, message: 'Access denied' });

  jwt.verify(token, process.env.ACCESS_TOKEN_KEY, async (error, payload) => {
    if (error) return res.status(401).json({ successful: false, message: 'Invalid token' });
    if (payload?.permission !== 'board' || !payload?.member_id) {
      return res.status(401).json({ successful: false, message: 'Invalid token' });
    }

    try {
      const member = await prisma.board_member.findUnique({
        where: { member_id: payload.member_id },
        omit: { password: false },
      });
      if (!member) return res.status(401).json({ successful: false, message: 'Invalid token' });
      // Password-change invalidation: tokens minted after this change carry pwd_fp. Legacy
      // tokens without it still work until they expire (7d), so existing sessions aren't
      // mass-logged-out on deploy.
      if (
        payload.pwd_fp &&
        member.password &&
        payload.pwd_fp !== String(member.password).slice(-12)
      ) {
        return res.status(401).json({ successful: false, message: 'Invalid token' });
      }
      if (member.status !== 'approved') {
        return res
          .status(403)
          .json({ successful: false, message: 'Account is not active', status: member.status });
      }

      const role = member.role_id
        ? await prisma.board_role.findUnique({ where: { role_id: member.role_id } })
        : null;

      // Never leak the password hash downstream.
      const { password, ...safe } = member;
      req.member = safe;
      req.memberRole = role;
      req.access = effectiveAccess(safe, role);
      req.caps = effectiveCaps(safe, role);
      next();
    } catch (err) {
      console.error('[authenticate-board] error:', err);
      return res.status(500).json({ successful: false, message: 'Internal server error during authentication' });
    }
  });
}

// Dashboard gate factory — the primary RBAC v2 guard. Usage:
//   router.use(authenticateBoard, requireDashboard('finance', 'read'))   // reads
//   router.post('/payouts/:id/approve', requireDashboard('finance', 'write'), handler)
function requireDashboard(dashboardId, level = 'read') {
  return function dashboardGuard(req, res, next) {
    if (hasDashboardAccess(req.access || {}, dashboardId, level)) return next();
    return res.status(403).json({
      successful: false,
      message: `Forbidden: ${level} access to ${dashboardId} required`,
    });
  };
}

// ── Capability guards (reimplemented on req.caps) ────────────────────────────────────
function requireAssign(req, res, next) {
  if (!req.caps?.assign_tasks) {
    return res.status(403).json({ successful: false, message: 'Forbidden: assign capability required' });
  }
  next();
}

function requireReview(req, res, next) {
  if (!req.caps?.review_tasks) {
    return res.status(403).json({ successful: false, message: 'Forbidden: review capability required' });
  }
  next();
}

// Staff management (approve / reject / deactivate members). Role/access administration is
// a stricter, super-admin-only action — see requireSuperAdmin.
function requireManageMembers(req, res, next) {
  if (!req.caps?.manage_members) {
    return res.status(403).json({ successful: false, message: 'Forbidden: member-management capability required' });
  }
  next();
}

// Legacy aliases mapped onto the access map so old imports keep working.
function requireViewUsers(req, res, next) {
  return requireDashboard('user-management', 'read')(req, res, next);
}
function requireRestricted(req, res, next) {
  return requireDashboard('kyc', 'read')(req, res, next);
}

// Super-admin — the most exclusive gate (God Mode + role/access administration).
// Only the super-admins hold it, and only a super-admin can grant/revoke it.
function requireSuperAdmin(req, res, next) {
  if (!req.member?.is_super_admin) {
    return res.status(403).json({ successful: false, message: 'Forbidden: super-admin access required' });
  }
  next();
}

export {
  authenticateBoard,
  requireDashboard,
  requireAssign,
  requireReview,
  requireManageMembers,
  requireViewUsers,
  requireRestricted,
  requireSuperAdmin,
};
