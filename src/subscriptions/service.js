'use strict';
const fs = require('fs');
const path = require('path');
const { normalize, nextRun, describe } = require('./schedule');
const { resolveParams, withDefaults } = require('../rdl/engine');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// One folder name per path segment; no dots-only names, no separators, no drive letters. Result uses "/".
function cleanFolder(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]+/).filter((p) => p !== '');
  if (parts.length > 5) throw bad('The folder can be at most 5 levels deep');
  const out = parts.map((p) => {
    const seg = p.trim();
    if (!seg || /^\.+$/.test(seg) || /[<>:"|?*\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg) || seg.length > 60 || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(seg)) {
      throw bad(`"${seg}" is not allowed in a folder name. Use letters, digits, spaces, - and _`);
    }
    return seg;
  });
  return out.join('/');
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'report';
}

// Absolute path under the user's own root, or null when it would escape it.
function resolveUnder(root, ...parts) {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

function cleanParams(input) {
  const out = {};
  if (input === undefined || input === null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('Parameters must be an object');
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === '') continue; // blank = use the report's default at run time
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw bad(`Parameter "${k}" has an invalid value`);
    out[k] = v;
  }
  if (JSON.stringify(out).length > 4000) throw bad('Parameters are too long');
  return out;
}

function publicSub(r) {
  const schedule = JSON.parse(r.schedule);
  return {
    id: r.id, reportId: r.report_id, reportName: r.report_name, name: r.name, format: r.format,
    params: JSON.parse(r.params), schedule, scheduleText: describe(schedule), folder: r.folder,
    enabled: !!r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastStatus: r.last_status, lastError: r.last_error,
    failures: r.failures,
  };
}

const SELECT = `SELECT s.*, r.name AS report_name FROM subscriptions s JOIN reports r ON r.id = s.report_id`;

function createSubscriptionService({ db, reports, outputDir, now = () => new Date(), onChange = () => {} }) {
  const userRoot = (userId) => resolveUnder(outputDir, String(parseInt(userId, 10)));

  // Reports in the admin-only Connection folder do not exist for viewers.
  async function assertVisible(reportId, role) {
    const row = await db.one('SELECT r.id, r.name, f.is_system FROM reports r JOIN folders f ON f.id = r.folder_id WHERE r.id = @id', { id: reportId });
    if (!row || (row.is_system && role !== 'admin')) throw bad('Not found', 404);
    return row;
  }

  // Throws a plain 400 when the stored values can never run (unknown names are ignored by the engine).
  async function assertParams(reportId, params) {
    const row = await reports.getRow(reportId);
    const def = await reports.loadDef(row);
    const { errors } = resolveParams(def, withDefaults(def, params));
    if (errors.length) throw bad(errors.join('. '));
  }

  async function mine(id, userId) {
    const r = await db.one(`${SELECT} WHERE s.id = @id AND s.user_id = @userId`, { id, userId });
    if (!r) throw bad('Not found', 404);
    return r;
  }

  async function build(user, body, existing) {
    const b = body || {};
    const reportId = existing ? existing.report_id : parseInt(b.reportId, 10);
    if (!Number.isInteger(reportId)) throw bad('Choose a report');
    const rep = await assertVisible(reportId, user.role);
    const format = b.format === undefined && existing ? existing.format : String(b.format || '').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) throw bad('Format must be csv or xlsx');
    const schedule = normalize(b.schedule === undefined && existing ? JSON.parse(existing.schedule) : b.schedule);
    const params = cleanParams(b.params === undefined && existing ? JSON.parse(existing.params) : b.params);
    await assertParams(reportId, params);
    const folder = cleanFolder(b.folder === undefined && existing ? existing.folder : b.folder);
    const name = String(b.name === undefined && existing ? existing.name : b.name || rep.name).trim().slice(0, 200) || rep.name;
    return { reportId, format, schedule, params, folder, name };
  }

  return {
    cleanFolder, userRoot,

    async list(userId) {
      return (await db.query(`${SELECT} WHERE s.user_id = @userId ORDER BY s.name`, { userId })).map(publicSub);
    },

    async create(user, body) {
      const v = await build(user, body, null);
      const row = await db.one(
        `INSERT INTO subscriptions (user_id, report_id, name, params, format, schedule, folder, enabled, next_run_at)
         OUTPUT INSERTED.id VALUES (@userId, @reportId, @name, @params, @format, @schedule, @folder, 1, @next)`,
        { userId: user.id, reportId: v.reportId, name: v.name, params: JSON.stringify(v.params), format: v.format,
          schedule: JSON.stringify(v.schedule), folder: v.folder, next: nextRun(v.schedule, now()) }
      );
      onChange();
      return publicSub(await mine(row.id, user.id));
    },

    async update(user, id, body) {
      const cur = await mine(id, user.id);
      const b = body || {};
      const v = await build(user, { ...b, reportId: cur.report_id }, cur);
      const enabled = b.enabled === undefined ? !!cur.enabled : !!b.enabled;
      // Re-enabling (or changing the schedule) restarts the failure count and recomputes the next run.
      await db.query(
        `UPDATE subscriptions SET name=@name, params=@params, format=@format, schedule=@schedule, folder=@folder,
           enabled=@enabled, next_run_at=@next, failures=CASE WHEN @enabled = 1 THEN 0 ELSE failures END WHERE id=@id AND user_id=@userId`,
        { id, userId: user.id, name: v.name, params: JSON.stringify(v.params), format: v.format, schedule: JSON.stringify(v.schedule),
          folder: v.folder, enabled, next: enabled ? nextRun(v.schedule, now()) : null }
      );
      onChange();
      return publicSub(await mine(id, user.id));
    },

    async remove(user, id) {
      await mine(id, user.id);
      const files = await db.query('SELECT file_name FROM subscription_runs WHERE subscription_id = @id AND file_name IS NOT NULL', { id });
      await db.query('DELETE FROM subscriptions WHERE id = @id AND user_id = @userId', { id, userId: user.id });
      this.deleteFiles(user.id, files.map((f) => f.file_name));
    },

    // "Run now": due on the next scheduler tick, without touching the regular schedule afterwards.
    async runNow(user, id) {
      const cur = await mine(id, user.id);
      await db.query('UPDATE subscriptions SET next_run_at = @now, enabled = 1 WHERE id = @id AND user_id = @userId', { id, userId: user.id, now: now() });
      onChange();
      return publicSub({ ...cur, enabled: 1, next_run_at: now() });
    },

    async runs(user, id, limit = 50) {
      await mine(id, user.id);
      return (await db.query(
        `SELECT TOP (@limit) id, started_at, finished_at, status, row_count, file_name, file_size, error
         FROM subscription_runs WHERE subscription_id = @id AND user_id = @userId ORDER BY id DESC`, { id, userId: user.id, limit })).map(publicRun);
    },

    // Everything the user has saved, newest first.
    async files(user, limit = 200) {
      return (await db.query(
        `SELECT TOP (@limit) rn.id, rn.started_at, rn.finished_at, rn.status, rn.row_count, rn.file_name, rn.file_size, rn.error, s.name AS subscription_name
         FROM subscription_runs rn JOIN subscriptions s ON s.id = rn.subscription_id
         WHERE rn.user_id = @userId AND rn.file_name IS NOT NULL ORDER BY rn.id DESC`, { userId: user.id, limit }))
        .map((r) => ({ ...publicRun(r), subscriptionName: r.subscription_name }));
    },

    // Absolute path of one of the user's own files, or null.
    async filePath(user, runId) {
      const r = await db.one('SELECT file_name FROM subscription_runs WHERE id = @id AND user_id = @userId AND file_name IS NOT NULL', { id: runId, userId: user.id });
      if (!r) return null;
      const abs = resolveUnder(userRoot(user.id), r.file_name);
      return abs && fs.existsSync(abs) ? abs : null;
    },

    deleteFiles(userId, names) {
      const root = userRoot(userId);
      for (const n of names) {
        const abs = n && resolveUnder(root, n);
        if (!abs) continue;
        try { fs.unlinkSync(abs); } catch (e) { /* already gone */ }
        // remove now-empty folders up to the user's root
        for (let d = path.dirname(abs); d !== root && d.startsWith(root + path.sep); d = path.dirname(d)) {
          try { fs.rmdirSync(d); } catch (e) { break; }
        }
      }
    },
  };
}

function publicRun(r) {
  return {
    id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, rowCount: r.row_count,
    fileName: r.file_name ? r.file_name.split('/').pop() : null, fileSize: r.file_size === null ? null : Number(r.file_size), error: r.error,
  };
}

module.exports = { createSubscriptionService, cleanFolder, resolveUnder, safeName, cleanParams };
