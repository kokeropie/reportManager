'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/middleware');

function createAuditRouter({ audit }) {
  const r = express.Router();
  r.use(requireAdmin); // viewers get 404
  r.get('/', async (req, res, next) => {
    try {
      const q = req.query;
      const okDate = (s) => (s && !Number.isNaN(new Date(s).getTime()) ? s : undefined);
      res.json(await audit.list({
        page: parseInt(q.page, 10) || 1, pageSize: parseInt(q.pageSize, 10) || 100,
        user: q.user || undefined, report: q.report || undefined, action: q.action || undefined,
        from: okDate(q.from), to: okDate(q.to),
      }));
    } catch (e) { next(e); }
  });
  return r;
}

module.exports = { createAuditRouter };
