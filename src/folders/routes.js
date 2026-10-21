'use strict';
const express = require('express');
const { requireAuth, requireAdmin } = require('../auth/middleware');
const { FOLDER_OPEN_SQL, who } = require('./access');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function cleanName(v) {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 100) throw bad('Folder name must be 1-100 characters');
  return n;
}

function createFoldersRouter({ db, reports }) {
  const r = express.Router();
  r.use(requireAuth);
  const admin = (req) => req.session.role === 'admin';

  const me = (req) => ({ role: req.session.role, userId: req.session.userId });

  // Folder visible to this user? The system "Connection" folder is admin-only and looks missing to everyone else (FR-8b).
  // A folder with an access list is also missing for viewers who are not on it.
  async function visibleFolder(req, id) {
    if (Number.isNaN(id)) return null;
    return db.one(`SELECT f.id, f.name, f.is_system FROM folders f WHERE f.id = @id AND ${FOLDER_OPEN_SQL}`, { id, ...who(me(req)) });
  }

  r.get('/', async (req, res, next) => {
    try {
      const rows = await db.query(
        `SELECT f.id, f.name, f.is_system, (SELECT COUNT(*) FROM reports r WHERE r.folder_id = f.id) AS report_count,
           (SELECT COUNT(*) FROM folder_access fa WHERE fa.folder_id = f.id) AS access_count
         FROM folders f WHERE ${FOLDER_OPEN_SQL} ORDER BY f.is_system DESC, f.name`,
        who(me(req))
      );
      // Only admins are told which folders are restricted.
      res.json(rows.map((f) => ({ id: f.id, name: f.name, isSystem: !!f.is_system, reportCount: f.report_count,
        ...(admin(req) && !f.is_system ? { restrictedTo: f.access_count } : {}) })));
    } catch (e) { next(e); }
  });

  r.post('/', requireAdmin, async (req, res, next) => {
    try {
      const name = cleanName((req.body || {}).name);
      if (await db.one('SELECT id FROM folders WHERE name = @name', { name })) throw bad('A folder with that name already exists', 409);
      const f = await db.one('INSERT INTO folders (name) OUTPUT INSERTED.id, INSERTED.name VALUES (@name)', { name });
      res.status(201).json({ id: f.id, name: f.name, isSystem: false, reportCount: 0 });
    } catch (e) { next(e); }
  });

  r.put('/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const f = await visibleFolder(req, id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (f.is_system) throw bad('The Connection folder cannot be renamed');
      const name = cleanName((req.body || {}).name);
      if (await db.one('SELECT id FROM folders WHERE name = @name AND id <> @id', { name, id })) throw bad('A folder with that name already exists', 409);
      await db.query('UPDATE folders SET name = @name WHERE id = @id', { id, name });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const f = await visibleFolder(req, id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (f.is_system) throw bad('The Connection folder cannot be deleted');
      if ((await reports.listByFolder(id)).length) throw bad('The folder still has reports. Move or delete them first', 409);
      await db.query('DELETE FROM folders WHERE id = @id', { id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Who may open the folder. userIds empty = every viewer (the default). Admins always can, so they are never listed.
  r.get('/:id/access', requireAdmin, async (req, res, next) => {
    try {
      const f = await visibleFolder(req, parseInt(req.params.id, 10));
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (f.is_system) throw bad('The Connection folder is always admin only');
      const rows = await db.query('SELECT user_id FROM folder_access WHERE folder_id = @id', { id: f.id });
      res.json({ userIds: rows.map((x) => x.user_id) });
    } catch (e) { next(e); }
  });

  r.put('/:id/access', requireAdmin, async (req, res, next) => {
    try {
      const f = await visibleFolder(req, parseInt(req.params.id, 10));
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (f.is_system) throw bad('The Connection folder is always admin only');
      const raw = (req.body || {}).userIds;
      if (!Array.isArray(raw) || raw.length > 500 || raw.some((v) => !Number.isInteger(v))) throw bad('userIds must be a list of user ids');
      const ids = [...new Set(raw)];
      if (ids.length) {
        // viewers only: admins can open everything anyway
        const params = {};
        const marks = ids.map((id, i) => { params['u' + i] = id; return '@u' + i; });
        const found = await db.query(`SELECT id FROM users WHERE role = 'viewer' AND id IN (${marks.join(',')})`, params);
        if (found.length !== ids.length) throw bad('Choose existing viewer accounts only');
      }
      const params = { f: f.id };
      const values = ids.map((id, i) => { params['u' + i] = id; return `(@f, @u${i})`; });
      await db.query(
        `SET XACT_ABORT ON; BEGIN TRANSACTION;
         DELETE FROM folder_access WHERE folder_id = @f;
         ${values.length ? `INSERT INTO folder_access (folder_id, user_id) VALUES ${values.join(',')};` : ''}
         COMMIT TRANSACTION;`, params);
      res.json({ userIds: ids });
    } catch (e) { next(e); }
  });

  r.get('/:id/reports', async (req, res, next) => {
    try {
      const f = await visibleFolder(req, parseInt(req.params.id, 10));
      if (!f) return res.status(404).json({ error: 'Not found' });
      res.json({ folder: { id: f.id, name: f.name }, reports: await reports.listByFolder(f.id) });
    } catch (e) { next(e); }
  });

  // FR-9: admin-only upload. One file per request; the browser sends several in a row for bulk upload.
  r.post('/:id/reports', requireAdmin, async (req, res, next) => {
    try {
      const f = await visibleFolder(req, parseInt(req.params.id, 10));
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (f.is_system) throw bad('The Connection folder holds connections, not reports');
      const b = req.body || {};
      const connectionId = b.connectionId === undefined || b.connectionId === null || b.connectionId === '' ? null : parseInt(b.connectionId, 10);
      if (connectionId !== null && Number.isNaN(connectionId)) throw bad('Invalid connection');
      res.status(201).json(await reports.create({ folderId: f.id, fileName: b.fileName, xml: b.content, connectionId, userId: req.session.userId }));
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createFoldersRouter };
