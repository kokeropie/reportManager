'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin, csrfProtect, newCsrfToken } = require('./middleware');

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}
function save(req) {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

function createAuthRouter({ users, store, db, audit }) {
  const log = (req, e) => (audit ? audit.log({ ip: req.ip, userAgent: req.get('user-agent'), ...e }) : null);
  const r = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
  });

  // Hands out a CSRF token before login so the login POST itself is protected.
  r.get('/csrf', async (req, res, next) => {
    try {
      if (!req.session.csrf) req.session.csrf = newCsrfToken();
      await save(req);
      res.json({ csrfToken: req.session.csrf });
    } catch (e) { next(e); }
  });

  r.post('/login', loginLimiter, csrfProtect, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const user = await users.authenticate(username, password);
      if (!user) {
        await log(req, { action: 'login', username: String(username || '').slice(0, 100), status: 'error', error: 'Wrong username or password' });
        return res.status(401).json({ error: 'Wrong username or password' });
      }
      await regenerate(req); // new session id on login (prevents fixation)
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.mustChange = !!user.must_change_password;
      req.session.csrf = newCsrfToken();
      await save(req);
      const s = await db.one(`SELECT value FROM settings WHERE name = 'single_session'`);
      if (s && s.value === 'true') await store.destroyForUser(user.id, req.sessionID);
      await log(req, { action: 'login', userId: user.id, username: user.username });
      res.json({ username: user.username, role: user.role, mustChange: req.session.mustChange, csrfToken: req.session.csrf });
    } catch (e) { next(e); }
  });

  r.post('/logout', requireAuth, csrfProtect, (req, res, next) => {
    log(req, { action: 'logout', userId: req.session.userId, username: req.session.username });
    req.session.destroy((e) => {
      if (e) return next(e);
      res.clearCookie('rs.sid');
      res.json({ ok: true });
    });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.session.username, role: req.session.role, mustChange: !!req.session.mustChange, csrfToken: req.session.csrf });
  });

  // Everyone has their own account; this is how they pick (and later change) their own password.
  r.post('/password', requireAuth, csrfProtect, loginLimiter, async (req, res, next) => {
    try {
      const { current, password } = req.body || {};
      await users.changeOwnPassword(req.session.userId, current, password);
      await store.destroyForUser(req.session.userId, req.sessionID); // other devices must sign in again
      req.session.mustChange = false;
      await save(req);
      await log(req, { action: 'password-change', userId: req.session.userId, username: req.session.username });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

function createUsersRouter({ users, store }) {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/', async (req, res, next) => { try { res.json(await users.list()); } catch (e) { next(e); } });

  r.post('/', async (req, res, next) => {
    try { res.status(201).json(await users.create({ ...(req.body || {}), mustChange: true })); } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const target = await users.get(id);
      if (!target) return res.status(404).json({ error: 'Not found' });
      const { role, disabled } = req.body || {};
      const losesAdmin = target.role === 'admin' && !target.disabled && (role === 'viewer' || disabled === true);
      if (losesAdmin) {
        if (id === req.session.userId) return res.status(400).json({ error: 'You cannot demote or disable your own account' });
        if ((await users.countActiveAdmins()) <= 1) return res.status(400).json({ error: 'At least one active admin is required' });
      }
      await users.update(id, { role, disabled });
      if (disabled === true || role !== undefined) await store.destroyForUser(id, id === req.session.userId ? req.sessionID : null);
      res.json(await users.get(id));
    } catch (e) { next(e); }
  });

  r.post('/:id/password', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!(await users.get(id))) return res.status(404).json({ error: 'Not found' });
      await users.setPassword(id, (req.body || {}).password, { mustChange: id !== req.session.userId });
      await store.destroyForUser(id, id === req.session.userId ? req.sessionID : null);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createAuthRouter, createUsersRouter };
