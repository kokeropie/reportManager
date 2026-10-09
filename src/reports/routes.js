'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/middleware');
const { writeCsv } = require('../export/csv');
const { writeXlsx } = require('../export/xlsx');

const intParam = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : NaN; };

function fileStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'report';
}

const layoutOf = (v) => (['all', 'matrix', 'tabular'].includes(v) ? v : undefined);

function createReportsRouter({ reports, runs, cfg, audit }) {
  const noAudit = { log: async () => {} };
  audit = audit || noAudit;
  // FR-26/26a: username, IP and browser, because everyone may share one Viewer login.
  const who = (req) => ({ userId: req.session.userId, username: req.session.username, ip: req.ip, userAgent: req.get('user-agent') });
  const reportNameOf = async (id) => { try { const r = await reports.getRow(id); return r ? r.name : null; } catch (e) { return null; } };
  const r = express.Router();
  const isAdmin = (req) => req.session.role === 'admin';
  const notFound = (res) => res.status(404).json({ error: 'Not found' });

  r.get('/', async (req, res, next) => {
    try { res.json(await reports.search(req.query.q)); } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      if (Number.isNaN(id)) return notFound(res);
      res.json(await runs.describe(id, isAdmin(req)));
    } catch (e) { next(e); }
  });

  r.put('/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      const b = req.body || {};
      const connectionId = b.connectionId === undefined ? undefined : b.connectionId === null || b.connectionId === '' ? null : intParam(b.connectionId);
      if (connectionId !== undefined && connectionId !== null && Number.isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection' });
      await reports.update(id, { connectionId, name: b.name, folderId: b.folderId === undefined ? undefined : intParam(b.folderId) });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.put('/:id/rdl', requireAdmin, async (req, res, next) => {
    try { res.json(await reports.replace(intParam(req.params.id), (req.body || {}).content)); } catch (e) { next(e); }
  });

  r.delete('/:id', requireAdmin, async (req, res, next) => {
    try { await reports.remove(intParam(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
  });

  r.post('/:id/run', async (req, res, next) => {
    try {
      const b = req.body || {};
      const id = intParam(req.params.id);
      let out;
      try {
        out = await runs.run(id, b.params || {}, {
          userId: req.session.userId,
          page: 1,
          layout: layoutOf(b.layout),
          pageSize: Math.min(Math.max(parseInt(b.pageSize, 10) || cfg.pageSize, 10), 500),
        });
      } catch (e) {
        if (e.status !== 404) await audit.log({ ...who(req), action: 'run', reportId: id, reportName: await reportNameOf(id), params: b.params || {}, status: 'error', error: e.detail || e.message });
        throw e;
      }
      await audit.log({ ...who(req), action: 'run', reportId: id, reportName: out.reportName, params: b.params || {}, rowCount: out.dataRows });
      delete out.reportName;
      delete out.dataRows;
      res.json(out);
    } catch (e) { next(e); }
  });

  r.get('/:id/runs/:runId', (req, res, next) => {
    try {
      const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || cfg.pageSize, 10), 500);
      res.json(runs.page(req.params.runId, req.session.userId, parseInt(req.query.page, 10) || 1, pageSize));
    } catch (e) { next(e); }
  });

  // FR-22/23/24: re-run the query and stream the file. Any error is plain JSON, sent before the file starts.
  r.post('/:id/export', async (req, res, next) => {
    const id = intParam(req.params.id);
    const params = (req.body || {}).params || {};
    const format = String(req.query.format || '').toLowerCase();
    try {
      if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'Format must be csv or xlsx' });
      let data;
      try {
        data = await runs.exportData(id, params, { layout: layoutOf((req.body || {}).layout) });
      } catch (e) {
        if (e.status !== 404) await audit.log({ ...who(req), action: 'export-' + format, reportId: id, reportName: await reportNameOf(id), params, status: 'error', error: e.detail || e.message });
        throw e;
      }
      await audit.log({ ...who(req), action: 'export-' + format, reportId: id, reportName: data.reportName, params, rowCount: data.grid.rowCount });
      const base = `${safeFileName(data.reportName)} ${fileStamp(new Date())}.${format}`;
      res.set({
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${base.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (format === 'csv') await writeCsv(res, data.grid);
      else await writeXlsx(res, data.grid, { sheetName: data.reportName });
    } catch (e) {
      if (res.headersSent) { console.error('Export failed mid-stream:', e.message); res.destroy(); return; }
      next(e);
    }
  });

  return r;
}

module.exports = { createReportsRouter };
