'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/middleware');
const { validateConnection } = require('./validate');
const { testConnection } = require('./driver');

function createConnectionsRouter({ connections }) {
  const r = express.Router();
  r.use(requireAdmin); // FR-8b: non-admins see 404

  const idOf = (req) => parseInt(req.params.id, 10);

  r.get('/', async (req, res, next) => { try { res.json(await connections.list()); } catch (e) { next(e); } });

  r.get('/:id', async (req, res, next) => {
    try {
      const c = await connections.get(idOf(req));
      c ? res.json(c) : res.status(404).json({ error: 'Not found' });
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    try {
      const { error, value } = validateConnection(req.body, { requirePassword: true });
      if (error) return res.status(400).json({ error });
      res.status(201).json(await connections.create(value));
    } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const id = idOf(req);
      if (!(await connections.get(id))) return res.status(404).json({ error: 'Not found' });
      const { error, value } = validateConnection(req.body, { requirePassword: false });
      if (error) return res.status(400).json({ error });
      await connections.update(id, value); // blank password keeps the stored one
      res.json(await connections.get(id));
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      const id = idOf(req);
      if (!(await connections.get(id))) return res.status(404).json({ error: 'Not found' });
      await connections.remove(id, { detach: req.query.detach === '1' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/:id/test', async (req, res, next) => {
    try {
      const c = await connections.getWithSecret(idOf(req));
      if (!c) return res.status(404).json({ error: 'Not found' });
      res.json(await testConnection(c));
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createConnectionsRouter };
