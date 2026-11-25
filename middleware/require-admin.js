// Admin is signalled two different ways depending on how the session was minted:
//   • req.user.role === 'ADMIN'      — set by authentication.js from the user row (every request)
//   • req.user.permission === 'admin' — carried in the JWT issued by the marketing-site login proxy
// Both are signed/trusted (the token is verified with ACCESS_TOKEN_KEY). Accept EITHER so an
// admin isn't locked out just because their session happens to carry only one of the two.
export function isAdmin(req) {
    return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

export function requireAdmin(req, res, next) {
    if (!isAdmin(req)) {
        return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    next();
}
