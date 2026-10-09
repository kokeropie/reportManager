'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseRdl, RdlError } = require('../rdl/parser');

const MAX_RDL_BYTES = 5 * 1024 * 1024;
const bad = (msg, status = 400, extra) => Object.assign(new Error(msg), { status }, extra);

// FR-35: only .rdl; this also rejects Report Builder's .rdl.data cache files.
function reportNameFromFile(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop(); // browsers may send either separator
  if (!/\.rdl$/i.test(base)) throw bad(`"${base}" is not an .rdl file. Only .rdl report files can be uploaded`);
  const name = base.replace(/\.rdl$/i, '').trim();
  if (!name || name.length > 200) throw bad('The file name must be 1-200 characters');
  return name;
}

function publicReport(r) {
  return {
    id: r.id, name: r.name, title: r.title, folderId: r.folder_id, folderName: r.folder_name,
    dataSourceName: r.datasource_name, connectionId: r.connection_id, updatedAt: r.updated_at,
  };
}

function createReportService({ db, reportsDir }) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const cache = new Map(); // id -> { stamp, def }

  const SELECT = `SELECT r.*, f.name AS folder_name FROM reports r JOIN folders f ON f.id = r.folder_id`;
  const filePath = (r) => path.join(reportsDir, path.basename(r.file_path)); // basename: never trust a stored path

  function parseOrThrow(xml) {
    if (Buffer.byteLength(xml, 'utf8') > MAX_RDL_BYTES) throw bad('The file is too large (limit 5 MB)');
    let def;
    try { def = parseRdl(xml); } catch (e) {
      if (e instanceof RdlError) throw bad(e.message);
      throw e;
    }
    if (def.errors.length) throw bad('This report cannot be used: ' + def.errors.join('; '), 400, { details: def.errors });
    return def;
  }

  async function findConnectionByName(name) {
    if (!name) return null;
    return db.one('SELECT id FROM connections WHERE LOWER(name) = LOWER(@name)', { name });
  }

  return {
    publicReport,

    async listByFolder(folderId) {
      return (await db.query(`${SELECT} WHERE r.folder_id = @folderId ORDER BY r.name`, { folderId })).map(publicReport);
    },
    async search(q) {
      const like = '%' + String(q || '').replace(/[%_[]/g, (c) => '[' + c + ']') + '%';
      return (await db.query(
        `SELECT TOP 100 r.*, f.name AS folder_name FROM reports r JOIN folders f ON f.id = r.folder_id
         WHERE f.is_system = 0 AND (r.name LIKE @like OR r.title LIKE @like) ORDER BY r.name`, { like })).map(publicReport);
    },
    async getRow(id) {
      return db.one(`${SELECT} WHERE r.id = @id`, { id });
    },

    // FR-9/10/11/30: validate, store the file, pick a connection by data source name if none was given.
    async create({ folderId, fileName, xml, connectionId, userId }) {
      const name = reportNameFromFile(fileName);
      const def = parseOrThrow(String(xml || ''));
      // Same name in the same folder: overwrite the file in place. The report id stays, so subscriptions keep running with the new file.
      const dup = await db.one('SELECT id, connection_id, datasource_name FROM reports WHERE folder_id = @folderId AND name = @name', { folderId, name });
      if (dup) {
        const out = await this.replace(dup.id, xml);
        return { id: dup.id, name, warnings: out.warnings, connectionId: dup.connection_id, autoMatched: false, dataSourceName: def.dataSource.reference, replaced: true };
      }
      let connId = connectionId || null;
      let autoMatched = false;
      if (connId) {
        if (!(await db.one('SELECT id FROM connections WHERE id = @id', { id: connId }))) throw bad('That connection does not exist');
      } else {
        const m = (await findConnectionByName(def.dataSource.reference)) || (await findConnectionByName(def.dataSource.name));
        if (m) { connId = m.id; autoMatched = true; }
      }
      const file = `${crypto.randomUUID()}.rdl`;
      fs.writeFileSync(path.join(reportsDir, file), xml, 'utf8');
      try {
        const row = await db.one(
          `INSERT INTO reports (folder_id, name, file_path, datasource_name, connection_id, title, warnings, uploaded_by)
           OUTPUT INSERTED.id
           VALUES (@folderId, @name, @file, @ds, @connId, @title, @warnings, @userId)`,
          { folderId, name, file, ds: def.dataSource.reference || def.dataSource.name, connId, title: def.title, warnings: JSON.stringify(def.warnings), userId }
        );
        return { id: row.id, name, warnings: def.warnings, connectionId: connId, autoMatched, dataSourceName: def.dataSource.reference };
      } catch (e) {
        fs.unlink(path.join(reportsDir, file), () => {});
        throw e;
      }
    },

    // FR-12: new RDL, same folder and connection.
    async replace(id, xml) {
      const r = await this.getRow(id);
      if (!r) throw bad('Not found', 404);
      const def = parseOrThrow(String(xml || ''));
      const tmp = filePath(r) + '.tmp';
      fs.writeFileSync(tmp, xml, 'utf8');
      fs.renameSync(tmp, filePath(r));
      await db.query(
        `UPDATE reports SET title = @title, warnings = @warnings, datasource_name = @ds, updated_at = SYSUTCDATETIME() WHERE id = @id`,
        { id, title: def.title, warnings: JSON.stringify(def.warnings), ds: def.dataSource.reference || def.dataSource.name }
      );
      cache.delete(id);
      return { id, warnings: def.warnings };
    },

    async update(id, { connectionId, name, folderId }) {
      const r = await this.getRow(id);
      if (!r) throw bad('Not found', 404);
      if (connectionId !== undefined && connectionId !== null) {
        if (!(await db.one('SELECT id FROM connections WHERE id = @id', { id: connectionId }))) throw bad('That connection does not exist');
      }
      if (folderId !== undefined) {
        const f = await db.one('SELECT id, is_system FROM folders WHERE id = @id', { id: folderId });
        if (!f) throw bad('That folder does not exist');
        if (f.is_system) throw bad('Reports cannot be moved into the Connection folder');
      }
      const newName = name === undefined ? r.name : String(name).trim();
      if (!newName || newName.length > 200) throw bad('Name must be 1-200 characters');
      const newFolder = folderId === undefined ? r.folder_id : folderId;
      const clash = await db.one('SELECT id FROM reports WHERE folder_id = @f AND name = @n AND id <> @id', { f: newFolder, n: newName, id });
      if (clash) throw bad('A report with that name already exists in that folder', 409);
      await db.query(
        `UPDATE reports SET name = @n, folder_id = @f, connection_id = @c, updated_at = SYSUTCDATETIME() WHERE id = @id`,
        { id, n: newName, f: newFolder, c: connectionId === undefined ? r.connection_id : connectionId }
      );
    },

    async remove(id) {
      const r = await this.getRow(id);
      if (!r) throw bad('Not found', 404);
      await db.query('DELETE FROM reports WHERE id = @id', { id });
      fs.unlink(filePath(r), () => {});
      cache.delete(id);
    },

    // Parsed definition, cached until the report is replaced.
    async loadDef(row) {
      const stamp = String(row.updated_at && row.updated_at.getTime ? row.updated_at.getTime() : row.updated_at);
      const hit = cache.get(row.id);
      if (hit && hit.stamp === stamp) return hit.def;
      let xml;
      try { xml = fs.readFileSync(filePath(row), 'utf8'); } catch (e) { throw bad('The report file is missing on the server. Ask an administrator to upload it again', 500); }
      const def = parseRdl(xml);
      cache.set(row.id, { stamp, def });
      return def;
    },
  };
}

module.exports = { createReportService, reportNameFromFile };
