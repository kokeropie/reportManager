'use strict';
const { nextRun } = require('../subscriptions/schedule');
const { sshTarget, localTarget } = require('./remote');
const { runSync, runCleanup, pickLatest } = require('./sync');

const KEEP_RUNS = 200;
const TICK_MS = 30 * 1000;

const defaultOpen = (part) => (part.host ? sshTarget(part) : localTarget());

// Runs the copy-and-restore or the clean-up, one at a time per process, and keeps a history row for each.
function createRunner({ db, service, now = () => new Date(), open = defaultOpen, log = console, timingLog }) {
  let current = null;
  const run_stopped = () => !!(current && current.stopped);

  async function finish(id, res) {
    await db.query(`UPDATE dbsync_runs SET finished_at=@t, status=@s, summary=@sum, log=@log WHERE id=@id`,
      { id, t: now(), s: res.stopped ? 'stopped' : res.ok ? (res.warnings ? 'warning' : 'ok') : 'error', sum: String(res.summary || '').slice(0, 1500), log: res.lines.join('\n') });
    const top = await db.one('SELECT MAX(id) AS m FROM dbsync_runs');
    if (top && top.m) await db.query('DELETE FROM dbsync_runs WHERE id <= @cut', { cut: top.m - KEEP_RUNS });
  }

  async function execute(id, kind, cfg) {
    const isStopped = () => !!(current && current.stopped);
    const onStep = (text) => { if (current) { current.step = text; current.stepAt = Date.now(); } };
    const lines = [];
    const onLine = (l) => { lines.push(l); db.query('UPDATE dbsync_runs SET log=@log WHERE id=@id', { id, log: lines.join('\n') }).catch(() => {}); };
    let source = null, dest = null;
    try {
      dest = await open(cfg.dest).open();
      if (current) current.targets = [dest];
      if (isStopped()) throw new Error('Stopped');
      if (kind === 'sync') {
        source = await open(cfg.source).open();
        if (current) current.targets = [dest, source];
        if (isStopped()) throw new Error('Stopped');
        return await runSync({ cfg, source, dest, now, onLine, onStep, isStopped, timingLog, runId: id });
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
    // Read-only look at the newest backup file per database on the backup server and on the Ubuntu server.
    // Does not touch a running job. "File time" is the modified time reported by the server.
    async latest() {
      const cfg = await service.getWithSecret();
      const out = [];
      for (const [where, part] of [['Ubuntu server', cfg.dest], ['Backup server', cfg.source]]) {
        const label = part.host ? `${where} (${part.host})` : `${where} (this machine)`;
        let target = null;
        try {
          target = await open(part).open();
          const files = await target.list(part.dir);
          for (const item of cfg.items) {
            const f = pickLatest(files, item.prefix);
            const full = files.find((x) => f && x.name === f.name);
            out.push({ where: label, dir: part.dir, prefix: item.prefix, found: !!f, name: f ? f.name : null, size: f ? f.size : null, stamp: f ? f.stamp : null, fileTime: full && full.mtime ? new Date(full.mtime).toISOString() : null });
          }
        } catch (e) { out.push({ where: label, dir: part.dir, error: e.message }); } finally { if (target) target.close(); }
      }
      return out;
    },
    // Stops the running job: kills the copy / unzip / restore and ends the connections. The run ends as "stopped".
    stop(by) {
      if (!current) throw Object.assign(new Error('Nothing is running'), { status: 409 });
      current.stopped = true;
      current.stoppedBy = by || 'an admin';
      for (const t of current.targets || []) { try { if (t.abort) t.abort(); } catch (e) { /* already closed */ } }
      return { kind: current.kind };
    },
    // Starts a run and returns { id, done } straight away. Throws 409 if one is already running.
    async start(kind, by) {
      if (current) throw Object.assign(new Error(`A ${current.kind} is already running`), { status: 409 });
      current = { kind, startedAt: Date.now(), step: '', stepAt: Date.now() };
      try {
        const cfg = await service.getWithSecret();
        const problem = !cfg.source.host && kind === 'sync' ? 'Fill in the backup server' : !cfg.mysql.username && kind === 'sync' ? 'Fill in the MySQL login'
          : !cfg.dest.host && process.platform === 'win32' ? 'Fill in the Ubuntu server' : '';
        const started = now();
        const ins = await db.query(
          `INSERT INTO dbsync_runs (kind, trigger_by, started_at, status, summary) VALUES (@kind, @by, @t, 'running', NULL)`,
          { kind, by, t: started });
        const run = { id: ins.insertId };
        const done = (async () => {
          try {
            let res = problem ? { ok: false, summary: problem + ' on the DB Sync screen first.', lines: [problem] } : await execute(run.id, kind, cfg);
            if (run_stopped()) res = { ok: false, stopped: true, summary: `Stopped by ${current.stoppedBy}`, lines: [...(res.lines || []), `Stopped by ${current.stoppedBy}`] };
            else if (!res.ok) log.error(`DB sync ${kind} failed: ${res.summary}`);
            await finish(run.id, res);
            return res;
          } catch (e) {
            log.error(`DB sync ${kind} crashed: ${e.message}`);
            await finish(run.id, run_stopped() ? { ok: false, stopped: true, summary: `Stopped by ${current.stoppedBy}`, lines: [`Stopped by ${current.stoppedBy}`] } : { ok: false, summary: e.message, lines: [e.message] }).catch(() => {});
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
    const got = await db.query(`UPDATE dbsync_config SET ${col} = @next WHERE id = 1 AND enabled = 1 AND ${col} = @old`,
      { next: nextRun(sched, t), old: cfgRow[col] });
    return !!got.affectedRows;
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
        log.log(`DB sync scheduler: starting scheduled ${kind} at ${t.toISOString()}`);
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
      log.log('DB sync scheduler: started, checking every 30s');
      timer = setInterval(tick, TICK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createRunner, createDbSyncScheduler };
