'use strict';
const fs = require('fs');
const path = require('path');
const { nextRun } = require('./schedule');
const { resolveUnder, safeName } = require('./service');
const { writeCsv } = require('../export/csv');
const { writeXlsx } = require('../export/xlsx');

const MAX_FAILURES = 5; // consecutive failures before a subscription pauses itself
const MAX_SLEEP_MS = 5 * 60 * 1000; // safety net: also picks up changes made by another copy of the app
const MIN_SLEEP_MS = 1000;

const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

// Writes to name.tmp and renames when complete, so a reader never sees a half-written file.
async function writeFile(abs, format, data) {
  const tmp = abs + '.tmp';
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const out = fs.createWriteStream(tmp);
  const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  finished.catch(() => {});
  try {
    if (format === 'csv') await writeCsv(out, data.grid);
    else await writeXlsx(out, data.grid, { sheetName: data.reportName });
    await finished;
    fs.renameSync(tmp, abs);
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch (x) { /* nothing written */ }
    throw e;
  }
  return fs.statSync(abs).size;
}

function createScheduler({ db, runs, audit, outputDir, retentionDays = 30, now = () => new Date(), log = console }) {
  let busy = false;
  let timer = null;
  let lastCleanup = 0;

  async function record(sub, started, fields) {
    await db.query(
      `INSERT INTO subscription_runs (subscription_id, user_id, started_at, finished_at, status, row_count, file_name, file_size, error)
       VALUES (@sid, @uid, @started, @finished, @status, @rows, @file, @size, @error)`,
      { sid: sub.id, uid: sub.user_id, started, finished: now(), status: fields.status, rows: fields.rows ?? null,
        file: fields.file ?? null, size: fields.size ?? null, error: fields.error ? String(fields.error).slice(0, 500) : null }
    );
    const failed = fields.status !== 'ok';
    await db.query(
      `UPDATE subscriptions SET last_run_at = @started, last_status = @status, last_error = @error,
         failures = CASE WHEN @failed = 1 THEN failures + 1 ELSE 0 END,
         enabled = CASE WHEN @failed = 1 AND failures + 1 >= @max THEN 0 ELSE enabled END
       WHERE id = @id`,
      { id: sub.id, started, status: fields.status, error: failed ? String(fields.error || 'Failed').slice(0, 500) : null, failed, max: MAX_FAILURES }
    );
  }

  async function execute(sub) {
    const started = now();
    const event = { userId: sub.user_id, username: sub.username, action: 'scheduled-run', reportId: sub.report_id, reportName: sub.report_name, params: JSON.parse(sub.params) };
    try {
      if (sub.user_disabled) throw Object.assign(new Error('The owner account is disabled'), { fatal: true });
      if (sub.folder_is_system && sub.role !== 'admin') throw Object.assign(new Error('The owner can no longer open this report'), { fatal: true });
      const data = await runs.exportData(sub.report_id, JSON.parse(sub.params), { fillBlanks: true });
      const rel = [sub.folder, `${safeName(sub.name)} ${stamp(started)}.${sub.format}`].filter(Boolean).join('/');
      const root = resolveUnder(outputDir, String(sub.user_id));
      const abs = resolveUnder(root, rel);
      if (!abs) throw new Error('The folder is not allowed');
      const size = await writeFile(abs, sub.format, data);
      await record(sub, started, { status: 'ok', rows: data.grid.rowCount, file: rel, size });
      await audit.log({ ...event, rowCount: data.grid.rowCount });
    } catch (e) {
      const msg = e.detail ? `${e.message} (${e.detail})` : e.message;
      log.error(`Subscription ${sub.id} failed: ${msg}`);
      await record(sub, started, { status: 'error', error: msg });
      if (e.fatal) await db.query('UPDATE subscriptions SET enabled = 0 WHERE id = @id', { id: sub.id });
      await audit.log({ ...event, status: 'error', error: msg });
    }
  }

  // Finds due subscriptions, claims each one by moving next_run_at forward (so no second tick or second copy of
  // the app can pick it up), then runs them. A restart after downtime runs each missed subscription once.
  async function tick() {
    if (busy) return 0;
    busy = true;
    try {
      const t = now();
      const due = await db.query(
        `SELECT TOP 20 s.*, r.name AS report_name, u.username, u.role, u.disabled AS user_disabled, f.is_system AS folder_is_system
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id JOIN reports r ON r.id = s.report_id JOIN folders f ON f.id = r.folder_id
         WHERE s.enabled = 1 AND s.next_run_at <= @now ORDER BY s.next_run_at`, { now: t });
      const claimed = [];
      for (const s of due) {
        let next;
        try { next = nextRun(JSON.parse(s.schedule), t); } catch (e) { log.error(`Subscription ${s.id} has a bad schedule`); continue; }
        const got = await db.one('UPDATE subscriptions SET next_run_at = @next OUTPUT INSERTED.id WHERE id = @id AND enabled = 1 AND next_run_at = @old',
          { id: s.id, next, old: s.next_run_at });
        if (got) claimed.push(s);
      }
      await Promise.all(claimed.map((s) => execute(s).catch((e) => log.error('Subscription run crashed:', e.message))));
      if (t.getTime() - lastCleanup > 3600 * 1000) { lastCleanup = t.getTime(); await cleanup(t).catch((e) => log.error('Output cleanup failed:', e.message)); }
      return claimed.length;
    } finally { busy = false; }
  }

  // Retention: old files and their history rows go away.
  async function cleanup(t) {
    if (!(retentionDays > 0)) return;
    const cutoff = new Date(t.getTime() - retentionDays * 86400000);
    const old = await db.query('SELECT id, user_id, file_name FROM subscription_runs WHERE started_at < @cutoff', { cutoff });
    for (const r of old) {
      const root = resolveUnder(outputDir, String(r.user_id));
      const abs = r.file_name && root && resolveUnder(root, r.file_name);
      if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* already gone */ } }
    }
    if (old.length) await db.query('DELETE FROM subscription_runs WHERE started_at < @cutoff', { cutoff });
  }

  // How long to sleep: until the earliest enabled next_run_at, never longer than the safety cap.
  async function nextDelay() {
    try {
      const row = await db.one('SELECT MIN(next_run_at) AS t FROM subscriptions WHERE enabled = 1');
      if (!row || !row.t) return MAX_SLEEP_MS;
      return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, new Date(row.t).getTime() - now().getTime()));
    } catch (e) {
      log.error('Scheduler could not read the next run time:', e.message);
      return MAX_SLEEP_MS;
    }
  }

  let stopped = true;
  function sleep(ms) {
    clearTimeout(timer);
    timer = setTimeout(loop, ms);
    timer.unref();
  }
  async function loop() {
    timer = null;
    try { await tick(); } catch (e) { log.error('Scheduler tick failed:', e.message); }
    if (!stopped) sleep(await nextDelay());
  }

  return {
    tick, cleanup, nextDelay,
    start() {
      if (!stopped) return;
      stopped = false;
      sleep(5000);
    },
    // A subscription was created, changed or set to "run now" in this process: look again soon.
    wake() { if (!stopped && timer) sleep(MIN_SLEEP_MS); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}

module.exports = { createScheduler, writeFile, MAX_FAILURES };
