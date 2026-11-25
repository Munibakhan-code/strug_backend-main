import jwt from "jsonwebtoken";
import prisma from "../utils/prisma-client.js";
import {
  ACCOUNT_SESSION_SELECT,
  evaluateAccountSession,
} from "../utils/account-session.js";

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json('Access denied');

  jwt.verify(token, process.env.ACCESS_TOKEN_KEY, async (error, user) => {
    if (error) return res.status(401).json('Invalid token');

    req.user = user;

    try {
      let account;
      try {
        account = await prisma.user.findUnique({
          where: { user_id: user.user_id },
          select: ACCOUNT_SESSION_SELECT,
        });
      } catch (pwdCheckErr) {
        // Fail closed: never treat a DB outage as an authenticated session.
        console.error('[auth] account-status / token-invalidation check failed:', pwdCheckErr.message);
        return res.status(503).json({ message: 'Authentication temporarily unavailable' });
      }

      const gate = evaluateAccountSession(account, user.iat);
      if (!gate.ok) {
        return res.status(gate.status).json(gate.body);
      }

      if (account?.role) {
        req.user.role = account.role;
      }

      const userProfile = await prisma.social_profile.findFirst({
          where: { user_id: user.user_id },
          select: { profile_id: true }
      });

      req.user.profile_id = userProfile ? userProfile.profile_id : null;

      prisma.__ctx = {
        user_id: user.user_id || null,
        team_id: user.team_id || null,
        profile_id: req.user.profile_id
      };

      next();
    } catch (err) {
      console.error("Middleware Error:", err);
      return res.status(500).json("Internal server error during authentication");
    }
  });
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, process.env.ACCESS_TOKEN_KEY, async (error, user) => {
    if (error) return next();

    req.user = user;
    try {
      let account;
      try {
        account = await prisma.user.findUnique({
          where: { user_id: user.user_id },
          select: ACCOUNT_SESSION_SELECT,
        });
      } catch {
        // Fail closed for optional auth: treat as anonymous rather than granting access.
        req.user = undefined;
        return next();
      }

      const gate = evaluateAccountSession(account, user.iat);
      if (!gate.ok) {
        req.user = undefined;
        return next();
      }

      const userProfile = await prisma.social_profile.findFirst({
        where: { user_id: user.user_id },
        select: { profile_id: true },
      });
      req.user.profile_id = userProfile ? userProfile.profile_id : null;
    } catch {
      req.user = undefined;
      return next();
    }
    next();
  });
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN' && req.user?.permission !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: Admins only' });
  }
  next();
}
