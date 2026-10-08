'use strict';
const path = require('path');
const express = require('express');

// Every route works on the signed-in user's own subscriptions and files only; other people's ids look like "not found".
function createSubscriptionsRouter({ subs, audit }) {
  const r = express.Router();
  const me = (req) => ({ id: req.session.userId, role: req.session.role, username: req.session.username });
  const id = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : -1; };
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  r.get('/', wrap(async (req, res) => res.json(await subs.list(req.session.userId))));
  r.post('/', wrap(async (req, res) => res.status(201).json(await subs.create(me(req), req.body))));

  r.get('/files', wrap(async (req, res) => res.json(await subs.files(me(req)))));
  r.get('/files/:runId/download', wrap(async (req, res) => {
    const abs = await subs.filePath(me(req), id(req.params.runId));
    if (!abs) return res.status(404).json({ error: 'Not found' });
    if (audit) await audit.log({ userId: req.session.userId, username: req.session.username, action: 'download-saved', ip: req.ip, userAgent: req.get('user-agent') });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.download(abs, path.basename(abs));
  }));

  r.put('/:id', wrap(async (req, res) => res.json(await subs.update(me(req), id(req.params.id), req.body))));
  r.delete('/:id', wrap(async (req, res) => { await subs.remove(me(req), id(req.params.id)); res.json({ ok: true }); }));
  r.post('/:id/run', wrap(async (req, res) => res.json(await subs.runNow(me(req), id(req.params.id)))));
  r.get('/:id/runs', wrap(async (req, res) => res.json(await subs.runs(me(req), id(req.params.id)))));

  return r;
}

module.exports = { createSubscriptionsRouter };
