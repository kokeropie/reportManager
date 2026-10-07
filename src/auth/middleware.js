'use strict';
const crypto = require('crypto');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// Non-admins get 404, not 403, so admin-only resources look like they do not exist (FR-8b, AC-4).
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') return next();
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  res.status(404).json({ error: 'Not found' });
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// CSRF: token lives in the session and must come back in the X-CSRF-Token header on every write.
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session && req.session.csrf;
  if (expected && safeEqual(req.get('x-csrf-token'), expected)) return next();
  res.status(403).json({ error: 'Invalid or missing CSRF token' });
}

function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { requireAuth, requireAdmin, csrfProtect, newCsrfToken, safeEqual };
