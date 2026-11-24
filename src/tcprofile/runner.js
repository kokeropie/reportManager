'use strict';
const fs = require('fs');
const path = require('path');
const { nextRun } = require('../subscriptions/schedule');
const { download } = require('./fetch');

const FILE_NAME = 'tcProfile_new.xlsx';
const FOLDER = 'tcprofile';
const KEEP_RUNS = 100;
const TICK_MS = 30 * 1000;

// Downloads the Excel file for the current year and replaces OUTPUT_DIR/tcprofile/tcProfile_new.xlsx with it.
// The new file is written next to the old one and renamed over it, so a failed or half-finished download never
// damages the file that is already there. One run at a time per process.
function createRunner({ db, outputDir, alvis, now = () => new Date(), fetchFile = download, onFileSaved = () => {}, log = console }) {
  let current = null;
  const dir = path.join(outputDir, FOLDER);

  async function finish(id, status, summary, size) {
    await db.query('UPDATE tcprofile_runs SET finished_at=@t, status=@s, summary=@sum, size_bytes=@size WHERE id=@id',
      { id, t: now(), s: status, sum: String(summary).slice(0, 480), size: size === undefined ? null : size });
    const top = await db.one('SELECT MAX(id) AS m FROM tcprofile_runs');
    if (top && top.m) await db.query('DELETE FROM tcprofile_runs WHERE id <= @cut', { cut: top.m - KEEP_RUNS });
  }

  async function work() {
    if (!alvis.apiKey) throw new Error('ALVIS_API_KEY is not set in .env. Add it and restart the app.');
    const year = now().getFullYear();
    const url = `${alvis.baseUrl.replace(/\/$/, '')}/service-performance/tc-profile/export?year=${year}`;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
    try {
      const size = await fetchFile(url, alvis.apiKey, tmp, { onBytes: (n) => { if (current) current.bytes = n; } });
      const fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(2);
      try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
      if (!size || head.toString('latin1') !== 'PK') throw new Error('Alvis did not return an Excel file, so the old file was kept.');
      fs.renameSync(tmp, path.join(dir, FILE_NAME));
      return { size, year };
    } finally { try { fs.unlinkSync(tmp); } catch (e) { /* already renamed or never created */ } }
  }

  return {
    get busy() { return current; },
    FILE_NAME, FOLDER,
    // The current file on disk, or null.
    file() {
      try { const st = fs.statSync(path.join(dir, FILE_NAME)); return { name: FILE_NAME, folder: FOLDER, size: st.size, modifiedAt: st.mtime }; } catch (e) { return null; }
    },
    // Starts a run and returns { id, done } straight away. Throws 409 if one is already running.
    async start(by) {
      if (current) throw Object.assign(new Error('A download is already running'), { status: 409 });
      current = { startedAt: Date.now(), bytes: 0 };
      try {
        const ins = await db.query(`INSERT INTO tcprofile_runs (trigger_by, started_at, status) VALUES (@by, @t, 'running')`, { by, t: now() });
        const id = ins.insertId;
        const done = (async () => {
          try {
            const r = await work();
            await finish(id, 'ok', `Saved ${FOLDER}/${FILE_NAME} for ${r.year} (${(r.size / 1048576).toFixed(1)} MB)`, r.size);
            onFileSaved();
            return { ok: true };
          } catch (e) {
            log.error(`tcProfile download failed: ${e.message}`);
            await finish(id, 'error', e.message).catch(() => {});
            return { ok: false, summary: e.message };
          } finally { current = null; }
        })();
        return { id, done };
      } catch (e) { current = null; throw e; }
    },
  };
}

// Wakes every 30 seconds; a due job is claimed by moving its next time forward (compare-and-set), so a second
// copy of the app cannot run it too. After downtime a missed run happens once.
function createTcProfileScheduler({ db, runner, now = () => new Date(), log = console }) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking || runner.busy) return 0;
    ticking = true;
    try {
      const t = now();
      const row = await db.one('SELECT * FROM tcprofile_config WHERE id = 1');
      if (!row || !row.enabled || !row.next_run_at || new Date(row.next_run_at) > t) return 0;
      const got = await db.query('UPDATE tcprofile_config SET next_run_at=@next WHERE id = 1 AND enabled = 1 AND next_run_at = @old',
        { next: nextRun(JSON.parse(row.schedule), t), old: row.next_run_at });
      if (!got.affectedRows) return 0;
      log.log(`tcProfile scheduler: starting scheduled download at ${t.toISOString()}`);
      await (await runner.start('schedule')).done;
      return 1;
    } catch (e) { log.error('tcProfile scheduler tick failed:', e.message); return 0; } finally { ticking = false; }
  }

  return {
    tick,
    async start() {
      if (timer) return;
      await db.query(`UPDATE tcprofile_runs SET status='error', finished_at=@t, summary='Interrupted by a restart' WHERE status='running'`, { t: now() }).catch(() => {});
      log.log('tcProfile scheduler: started, checking every 30s');
      timer = setInterval(tick, TICK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createRunner, createTcProfileScheduler, FILE_NAME, FOLDER };
