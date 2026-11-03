'use strict';
const { nextRun } = require('../subscriptions/schedule');
const { sshTarget, localTarget } = require('./remote');
const { runSync, runCleanup } = require('./sync');

const KEEP_RUNS = 200;
const TICK_MS = 30 * 1000;

const defaultOpen = (part) => (part.host ? sshTarget(part) : localTarget());

// Runs the copy-and-restore or the clean-up, one at a time per process, and keeps a history row for each.
function createRunner({ db, service, now = () => new Date(), open = defaultOpen, log = console, timingLog }) {
  let current = null;

  async function finish(id, res) {
    await db.query(`UPDATE dbsync_runs SET finished_at=@t, status=@s, summary=@sum, log=@log WHERE id=@id`,
      { id, t: now(), s: res.ok ? 'ok' : 'error', sum: String(res.summary || '').slice(0, 500), log: res.lines.join('\n') });
    await db.query(`DELETE FROM dbsync_runs WHERE id <= (SELECT MAX(id) FROM dbsync_runs) - @keep`, { keep: KEEP_RUNS });
  }

  async function execute(id, kind, cfg) {
    const lines = [];
    const onLine = (l) => { lines.push(l); db.query('UPDATE dbsync_runs SET log=@log WHERE id=@id', { id, log: lines.join('\n') }).catch(() => {}); };
    let source = null, dest = null;
    try {
      dest = await open(cfg.dest).open();
      if (kind === 'sync') {
        source = await open(cfg.source).open();
        return await runSync({ cfg, source, dest, now, onLine, timingLog, runId: id });
      }
      return await runCleanup({ cfg, dest, onLine });
    } catch (e) {
      lines.push(`${now().toTimeString().slice(0, 8)} ERROR ${e.message}`);
      return { ok: false, summary: e.message, lines };
    } finally {
      if (source) source.close();
      if (dest) dest.close();
    }
  }

  return {
    get busy() { return current; },
    // Starts a run and returns { id, done } straight away. Throws 409 if one is already running.
    async start(kind, by) {
      if (current) throw Object.assign(new Error(`A ${current.kind} is already running`), { status: 409 });
      current = { kind };
      try {
        const cfg = await service.getWithSecret();
        const problem = !cfg.source.host && kind === 'sync' ? 'Fill in the backup server' : !cfg.mysql.username && kind === 'sync' ? 'Fill in the MySQL login'
          : !cfg.dest.host && process.platform === 'win32' ? 'Fill in the Ubuntu server' : '';
        const started = now();
        const run = await db.one(
          `INSERT INTO dbsync_runs (kind, trigger_by, started_at, status, summary) OUTPUT INSERTED.id VALUES (@kind, @by, @t, 'running', NULL)`,
          { kind, by, t: started });
        const done = (async () => {
          try {
            const res = problem ? { ok: false, summary: problem + ' on the DB Sync screen first.', lines: [problem] } : await execute(run.id, kind, cfg);
            if (!res.ok) log.error(`DB sync ${kind} failed: ${res.summary}`);
            await finish(run.id, res);
            return res;
          } catch (e) {
            log.error(`DB sync ${kind} crashed: ${e.message}`);
            await finish(run.id, { ok: false, summary: e.message, lines: [e.message] }).catch(() => {});
            return { ok: false, summary: e.message };
          } finally { current = null; }
        })();
        return { id: run.id, done };
      } catch (e) { current = null; throw e; }
    },
  };
}

// Wakes every 30 seconds; a job that is due is claimed by moving its next time forward (compare-and-set), so a
// second copy of the app cannot run it too. After downtime a missed job runs once.
function createDbSyncScheduler({ db, runner, now = () => new Date(), log = console }) {
  let timer = null;
  let ticking = false;

  async function claim(kind, cfgRow, t) {
    const col = kind === 'sync' ? 'next_sync_at' : 'next_cleanup_at';
    const sched = JSON.parse(kind === 'sync' ? cfgRow.sync_schedule : cfgRow.cleanup_schedule);
    if (!cfgRow[col] || new Date(cfgRow[col]) > t) return false;
    const got = await db.one(`UPDATE dbsync_config SET ${col} = @next OUTPUT INSERTED.id WHERE id = 1 AND enabled = 1 AND ${col} = @old`,
      { next: nextRun(sched, t), old: cfgRow[col] });
    return !!got;
  }

  async function tick() {
    if (ticking || runner.busy) return 0;
    ticking = true;
    let n = 0;
    try {
      const t = now();
      const cfgRow = await db.one('SELECT * FROM dbsync_config WHERE id = 1');
      if (!cfgRow || !cfgRow.enabled) return 0;
      for (const kind of ['sync', 'cleanup']) {
        if (runner.busy || !(await claim(kind, cfgRow, t))) continue;
        n++;
        await (await runner.start(kind, 'schedule')).done;
      }
    } catch (e) { log.error('DB sync scheduler tick failed:', e.message); } finally { ticking = false; }
    return n;
  }

  return {
    tick,
    async start() {
      if (timer) return;
      // A run that was cut off by a restart would stay "running" forever.
      await db.query(`UPDATE dbsync_runs SET status='error', finished_at=@t, summary='Interrupted by a restart' WHERE status='running'`, { t: now() }).catch(() => {});
      timer = setInterval(tick, TICK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createRunner, createDbSyncScheduler };
