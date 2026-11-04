'use strict';
const path = require('path');
const { copyStream, q } = require('./remote');
const { timed, fmtBytes } = require('./timingLog');

// The work itself: find the newest file per database, copy it, check it, extract it, restore it; and the 6 PM
// cleanup. Takes already-opened targets so tests can run it on this machine with a fake `mysql`.

const px = path.posix;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;

// Newest "<prefix>_<YYYYMMDD>_<HHMMSS>.sql.gz" by the stamp in the name (not by file time, which a copy can change).
// The pattern is anchored, so "dev_kenji" never matches "dev_kenji_arjuna_20261103_000000.sql.gz".
function pickLatest(files, prefix) {
  const re = new RegExp(`^${escapeRe(prefix)}_(\\d{8})_(\\d{6})\\.sql\\.gz$`);
  let best = null;
  for (const f of files) {
    const m = re.exec(f.name);
    if (!m) continue;
    const stamp = m[1] + m[2];
    if (!best || stamp > best.stamp) best = { name: f.name, size: f.size, stamp, date: m[1] };
  }
  return best;
}

// Everything cleanup may delete for one prefix: the archive, the extracted file and half-copied leftovers.
function ownedFile(name, prefix) {
  return new RegExp(`^${escapeRe(prefix)}_\\d{8}_\\d{6}\\.sql(\\.gz)?(\\.part)?$`).test(name);
}

// mysql option file. Values are quoted so a password with # or spaces survives; a newline would break it.
function optionFile(my) {
  const val = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[client]\nhost=${val(my.host)}\nport=${val(my.port)}\nuser=${val(my.username)}\npassword=${val(my.password)}\n`;
}

function makeLog(onLine) {
  const lines = [];
  const t = () => { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const add = (level, msg) => { const line = `${t()} ${level} ${msg}`; lines.push(line); if (onLine) onLine(line); };
  return { lines, info: (m) => add('', m), warn: (m) => add('WARN', m), error: (m) => add('ERROR', m) };
}

// Errors that mean nothing was imported at all (login, connection, missing database); these still fail the file.
const FATAL_RESTORE = /ERROR (1044|1045|1049|2002|2003|2005|2013)\b|Access denied|Can't connect|Unknown database/i;

async function restoreOne({ source, dest, cfg, item, log, now, cnfPath, tlog, run }) {
  const files = await source.list(cfg.source.dir);
  const latest = pickLatest(files, item.prefix);
  if (!latest) throw new Error(`No file named ${item.prefix}_<date>_<time>.sql.gz in ${cfg.source.dir}`);
  log.info(`${item.prefix}: latest is ${latest.name} (${latest.size} bytes)`);
  if (latest.date !== ymd(now())) log.warn(`${item.prefix}: the newest file is dated ${latest.date}, not today. Is the backup job running?`);

  const dir = cfg.dest.dir;
  const gz = px.join(dir, latest.name);
  const sql = gz.replace(/\.gz$/, '');
  const T = (step, fn, extra) => timed(tlog, run, latest.name, step, fn, extra);
  const t0 = Date.now();

  // Copy under a .part name and rename when whole, so a broken transfer never looks like a finished file.
  await T('copy', async () => {
    const from = await source.readStream(px.join(cfg.source.dir, latest.name));
    const to = await dest.writeStream(gz + '.part', 0o640);
    const bytes = await copyStream(from, to);
    if (bytes !== latest.size) throw new Error(`Copy incomplete: got ${bytes} of ${latest.size} bytes`);
    await dest.rename(gz + '.part', gz);
  }, `${fmtBytes(latest.size)} (${latest.size} bytes)`);
  log.info(`${item.prefix}: copied to ${gz}`);

  let r = await T('verify (gzip -t)', async () => {
    const x = await dest.exec(`gzip -t -- ${q(gz)}`);
    if (x.code !== 0) throw new Error(`The copied file is not a valid gzip file (${x.text || 'gzip -t failed'}). The backup may still have been writing.`);
    return x;
  });

  await T('unzip', async () => {
    r = await dest.exec(`gzip -dc -- ${q(gz)} > ${q(sql + '.part')} && mv -f -- ${q(sql + '.part')} ${q(sql)}`);
    if (r.code !== 0) throw new Error(`Extract failed: ${r.text || 'exit ' + r.code}`);
  });
  log.info(`${item.prefix}: extracted to ${sql}`);

  await T('restore', async () => {
    r = await dest.exec(`mysql --defaults-extra-file=${q(cnfPath)} --default-character-set=utf8mb4 --force --database=${q(item.database)} < ${q(sql)}`);
    if (r.code === 127) throw new Error(`The mysql client is not installed on ${dest.label}. On Ubuntu: sudo apt install mysql-client`);
    // --force keeps importing after an SQL error; the exit code is then non-zero, which is not a failure here.
    if (r.code !== 0 && FATAL_RESTORE.test(r.text || '')) throw new Error(`Restore into ${item.database} failed: ${r.text || 'exit ' + r.code}`);
  }, `database ${item.database}`);
  const withErrors = r.code !== 0;
  if (withErrors) {
    const msgs = String(r.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    log.warn(`${item.prefix}: import finished with ${msgs.length || 'some'} error message(s), ignored. First: ${(msgs[0] || 'exit ' + r.code).slice(0, 300)}`);
  }
  log.info(`${item.prefix}: restored into database ${item.database}${withErrors ? ' (with errors)' : ''}`);
  tlog.write(`run=${run} | ${latest.name} | TOTAL | ${withErrors ? 'OK (errors ignored)' : 'OK'} | ${Math.round((Date.now() - t0) / 100) / 10}s`);
  return withErrors;
}

// Returns { ok, summary, lines }. Each database is handled on its own, so one bad file does not block the other.
async function runSync({ cfg, source, dest, now = () => new Date(), onLine, timingLog = { write() {} }, runId = '-' }) {
  const log = makeLog(onLine);
  timingLog.write(`run=${runId} | sync started | ${cfg.items.length} database(s)`);
  const failed = [];
  const withErrors = [];
  let done = 0;
  const cnfPath = px.join(cfg.dest.dir, `.dbsync-${process.pid}-${Date.now()}.cnf`);
  try {
    await dest.mkdirp(cfg.dest.dir);
    await dest.writeSecret(cnfPath, optionFile(cfg.mysql));
    for (const item of cfg.items) {
      try {
        if (await restoreOne({ source, dest, cfg, item, log, now, cnfPath, tlog: timingLog, run: runId })) withErrors.push(item.prefix);
        done++;
      } catch (e) {
        failed.push(item.prefix);
        log.error(`${item.prefix}: ${e.message}`);
      }
    }
  } catch (e) {
    log.error(e.message);
    return { ok: false, summary: e.message.slice(0, 300), lines: log.lines };
  } finally {
    await dest.remove(cnfPath).catch(() => {});
  }
  const ok = failed.length === 0;
  timingLog.write(`run=${runId} | sync finished | ${done} restored, ${failed.length} failed`);
  const note = withErrors.length ? ` Completed with errors in: ${withErrors.join(', ')} (errors ignored, see the log).` : '';
  return {
    ok, warnings: withErrors.length > 0, lines: log.lines,
    summary: ok ? `Restored ${done} database(s).${note}`.trim() : `Failed: ${failed.join(', ')} (${done} restored).${note}`.trim(),
  };
}

// Deletes this module's own files from the target folder; anything else in the folder is left alone.
async function runCleanup({ cfg, dest, onLine }) {
  const log = makeLog(onLine);
  let files;
  try { files = await dest.list(cfg.dest.dir); } catch (e) {
    if (/no such file|ENOENT/i.test(e.message)) { log.info(`${cfg.dest.dir} does not exist, nothing to delete`); return { ok: true, summary: 'Nothing to delete', lines: log.lines }; }
    throw e;
  }
  let n = 0;
  for (const f of files) {
    if (!(cfg.items.some((i) => ownedFile(f.name, i.prefix)) || /^\.dbsync-.*\.cnf$/.test(f.name))) continue;
    await dest.remove(px.join(cfg.dest.dir, f.name));
    log.info(`Deleted ${f.name}`);
    n++;
  }
  const left = files.length - n;
  if (left > 0) log.info(`${left} other file(s) in the folder were left alone`);
  return { ok: true, summary: `Deleted ${n} file(s)`, lines: log.lines };
}

module.exports = { pickLatest, ownedFile, optionFile, runSync, runCleanup };
