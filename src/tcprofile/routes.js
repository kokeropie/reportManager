'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/middleware');

// Admin only; viewers get 404.
function createTcProfileRouter({ service, runner, audit }) {
  const r = express.Router();
  r.use(requireAdmin);
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  const note = (req, action) => audit && audit.log({ userId: req.session.userId, username: req.session.username, action, ip: req.ip, userAgent: req.get('user-agent') });

  r.get('/', wrap(async (req, res) => res.json({ config: await service.get(), file: runner.file(), running: !!runner.busy })));
  r.put('/', wrap(async (req, res) => { const c = await service.save(req.body); await note(req, 'tcprofile-settings'); res.json(c); }));
  r.post('/run', wrap(async (req, res) => {
    const { id } = await runner.start('manual');
    await note(req, 'tcprofile-run');
    res.status(202).json({ id });
  }));
  r.get('/runs', wrap(async (req, res) => {
    const b = runner.busy;
    res.json({ runs: await service.runs(30), file: runner.file(), running: !!b, progress: b ? { startedAt: b.startedAt, bytes: b.bytes, now: Date.now() } : null });
  }));
  return r;
}

module.exports = { createTcProfileRouter };
