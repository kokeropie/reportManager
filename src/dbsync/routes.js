'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/middleware');

// Admin only; viewers get 404 like the Connections screen.
function createDbSyncRouter({ service, runner, audit }) {
  const r = express.Router();
  r.use(requireAdmin);
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  const note = (req, action) => audit && audit.log({ userId: req.session.userId, username: req.session.username, action, ip: req.ip, userAgent: req.get('user-agent') });

  r.get('/', wrap(async (req, res) => res.json({ config: await service.get(), running: runner.busy ? runner.busy.kind : null, platform: process.platform })));
  r.put('/', wrap(async (req, res) => { const c = await service.save(req.body); await note(req, 'dbsync-settings'); res.json(c); }));
  r.get('/latest', wrap(async (req, res) => res.json({ files: await runner.latest() })));
  r.post('/test/:which', wrap(async (req, res) => {
    if (!['source', 'dest', 'mysql'].includes(req.params.which)) return res.status(404).json({ error: 'Not found' });
    res.json(await service.test(req.params.which));
  }));
  r.post('/run/:kind', wrap(async (req, res) => {
    if (!['sync', 'cleanup'].includes(req.params.kind)) return res.status(404).json({ error: 'Not found' });
    const { id } = await runner.start(req.params.kind, 'manual');
    await note(req, 'dbsync-' + req.params.kind);
    res.status(202).json({ id });
  }));
  // progress: what the running job is doing right now (null when idle), with times in ms since the epoch.
  r.post('/stop', wrap(async (req, res) => {
    const { kind } = runner.stop(req.session.username);
    await note(req, 'dbsync-stop-' + kind);
    res.json({ ok: true });
  }));
  r.get('/runs', wrap(async (req, res) => {
    const b = runner.busy;
    res.json({ runs: await service.runs(30), running: b ? b.kind : null, progress: b ? { kind: b.kind, step: b.step, startedAt: b.startedAt, stepAt: b.stepAt, now: Date.now() } : null });
  }));

  return r;
}

module.exports = { createDbSyncRouter };
