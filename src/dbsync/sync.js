'use strict';
const path = require('path');
const { copyStream, q } = require('./remote');
const { timed, fmtBytes, fmtMs } = require('./timingLog');

// The work itself: find the newest file per database, copy it, check it, extract it, restore it; and the 6 PM
// cleanup. Takes already-opened targets so tests can run it on this machine with a fake `mysql`.

const px = path.posix;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const p2 = (n) => String(n).padStart(2, '0');
const dateOf = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
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
  const t = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const add = (level, msg) => { const line = `${t()} ${level} ${msg}`; lines.push(line); if (onLine) onLine(line); };
  return { lines, info: (m) => add('', m), warn: (m) => add('WARN', m), error: (m) => add('ERROR', m) };
}

// Errors that mean nothing was imported at all (login, connection, missing database); these still fail the file.
const FATAL_RESTORE = /ERROR (1044|1045|1049|2002|2003|2005|2013)\b|Access denied|Can't connect|Unknown database/i;

async function restoreOne({ source, dest, cfg, item, log, now, cnfPath, tlog, run, onStep = () => {}, position = '', isStopped = () => false, leftovers = [] }) {
  const checkStop = () => { if (isStopped()) throw Object.assign(new Error('Stopped'), { stopped: true }); };
  const files = await source.list(cfg.source.dir);
  const latest = pickLatest(files, item.prefix);
  if (!latest) throw new Error(`No file named ${item.prefix}_<date>_<time>.sql.gz in ${cfg.source.dir}`);
  log.info(`${item.prefix}: latest is ${latest.name} (${latest.size} bytes)`);
  if (latest.date !== ymd(now())) log.warn(`${item.prefix}: the newest file is dated ${latest.date}, not today. Is the backup job running?`);

  const dir = cfg.dest.dir;
  const gz = px.join(dir, latest.name);
  const sql = gz.replace(/\.gz$/, '');
  leftovers.push(gz + '.part', sql + '.part'); // removed if the run is stopped half way
  const T = (step, fn, extra) => timed(tlog, run, latest.name, step, fn, extra);
  const t0 = Date.now();
  // Tells the screen what is happening right now, and writes a "started" line (the "done" line follows the step).
  const begin = (text) => { onStep(`${position}${item.prefix}: ${text}`); log.info(`${item.prefix}: ${text}...`); };
  const took = (since) => fmtMs(Date.now() - since);

  // Copy under a .part name and rename when whole, so a broken transfer never looks like a finished file.
  begin(`copying ${latest.name} (${fmtBytes(latest.size)})`);
  let ts = Date.now();
  await T('copy', async () => {
    const from = await source.readStream(px.join(cfg.source.dir, latest.name));
    const to = await dest.writeStream(gz + '.part', 0o640);
    const bytes = await copyStream(from, to, (b) => onStep(`${position}${item.prefix}: copying ${latest.name}: ${fmtBytes(b)} of ${fmtBytes(latest.size)} (${latest.size ? Math.min(100, Math.round((b / latest.size) * 100)) : 0}%)`));
    if (bytes !== latest.size) throw new Error(`Copy incomplete: got ${bytes} of ${latest.size} bytes`);
    await dest.rename(gz + '.part', gz);
  }, `${fmtBytes(latest.size)} (${latest.size} bytes)`);
  checkStop();
  log.info(`${item.prefix}: copied to ${gz} in ${took(ts)}`);

  begin(`checking ${latest.name} (gzip -t)`);
  ts = Date.now();
  let r = await T('verify (gzip -t)', async () => {
    const x = await dest.exec(`gzip -t -- ${q(gz)}`);
    if (x.code !== 0) throw new Error(`The copied file is not a valid gzip file (${x.text || 'gzip -t failed'}). The backup may still have been writing.`);
    return x;
  });

  checkStop();
  log.info(`${item.prefix}: check passed in ${took(ts)}`);

  begin(`extracting ${latest.name}`);
  ts = Date.now();
  await T('unzip', async () => {
    r = await dest.exec(`gzip -dc -- ${q(gz)} > ${q(sql + '.part')} && mv -f -- ${q(sql + '.part')} ${q(sql)}`);
    if (r.code !== 0) throw new Error(`Extract failed: ${r.text || 'exit ' + r.code}`);
  });
  checkStop();
  log.info(`${item.prefix}: extracted to ${sql} in ${took(ts)}`);

  leftovers.restoring = true;
  begin(`restoring ${px.basename(sql)} into database ${item.database}`);
  ts = Date.now();
  await T('restore', async () => {
    // Big dumps (dev_arjuna) stop on "packet too large" when the SERVER's max_allowed_packet is small. In MariaDB that
    // variable is global-only (SET SESSION fails and made the client quit at once), so: the client limit goes on the
    // command line, and the server limit is only checked. The permanent fix is in the server's config file.
    const MIN_PACKET = 256 * 1024 * 1024;
    const cur = await dest.exec(`mysql --defaults-extra-file=${q(cnfPath)} -N -B -e ${q('SELECT @@global.max_allowed_packet')} < /dev/null`);
    const have = parseInt(String(cur.text || '').trim().split(/\s+/).pop(), 10);
    if (!(have >= MIN_PACKET)) {
      const g = await dest.exec(`mysql --defaults-extra-file=${q(cnfPath)} -e ${q('SET GLOBAL max_allowed_packet = 1073741824')} < /dev/null`);
      if (g.code !== 0) {
        log.warn(`${item.prefix}: server max_allowed_packet is ${have >= 0 ? fmtBytes(have) : 'unknown'} and cannot be raised from here. Large rows may fail. Permanent fix on the database server: add "max_allowed_packet=1G" under [mysqld] in /etc/mysql/mariadb.conf.d/50-server.cnf, then run "sudo systemctl restart mariadb".`);
      }
    }
    r = await dest.exec(`mysql --defaults-extra-file=${q(cnfPath)} --default-character-set=utf8mb4 --max-allowed-packet=1073741824 --force --database=${q(item.database)} < ${q(sql)}`);
    if (r.code === 127) throw new Error(`The mysql client is not installed on ${dest.label}. On Ubuntu: sudo apt install mysql-client`);
    // --force keeps importing after an SQL error; the exit code is then non-zero, which is not a failure here.
    if (r.code !== 0 && FATAL_RESTORE.test(r.text || '')) throw new Error(`Restore into ${item.database} failed: ${r.text || 'exit ' + r.code}`);
  }, `database ${item.database}`);
  checkStop();
  const withErrors = r.code !== 0;
  if (withErrors) {
    const msgs = String(r.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    log.warn(`${item.prefix}: import finished with ${msgs.length || 'some'} error message(s), ignored. First: ${(msgs[0] || 'exit ' + r.code).slice(0, 300)}`);
  }
  log.info(`${item.prefix}: restored into database ${item.database}${withErrors ? ' (with errors)' : ''} in ${took(ts)}`);
  tlog.write(`run=${run} | ${latest.name} | TOTAL | ${withErrors ? 'OK (errors ignored)' : 'OK'} | ${Math.round((Date.now() - t0) / 100) / 10}s`);
  return { withErrors, name: latest.name, date: latest.date, ms: Date.now() - t0 };
}

// Returns { ok, summary, lines }. Each database is handled on its own, so one bad file does not block the other.
async function runSync({ cfg, source, dest, now = () => new Date(), onLine, onStep, isStopped = () => false, timingLog = { write() {} }, runId = '-' }) {
  const log = makeLog(onLine);
  timingLog.write(`run=${runId} | sync started | ${cfg.items.length} database(s)`);
  const failed = [];
  const withErrors = [];
  const results = [];
  const runStart = Date.now();
  let done = 0;
  const cnfPath = px.join(cfg.dest.dir, `.dbsync-${process.pid}-${Date.now()}.cnf`);
  try {
    await dest.mkdirp(cfg.dest.dir);
    await dest.writeSecret(cnfPath, optionFile(cfg.mysql));
    for (const [i, item] of cfg.items.entries()) {
      if (isStopped()) break;
      const leftovers = [];
      try {
        const position = cfg.items.length > 1 ? `[${i + 1}/${cfg.items.length}] ` : '';
        const res = await restoreOne({ source, dest, cfg, item, log, now, cnfPath, tlog: timingLog, run: runId, onStep, position, isStopped, leftovers });
        if (res.withErrors) withErrors.push(item.prefix);
        results.push(`${item.prefix}: backup of ${dateOf(res.date)} (${res.name}), copy + restore took ${fmtMs(res.ms)}${res.withErrors ? ', SQL errors ignored' : ', no errors'}`);
        done++;
      } catch (e) {
        if (isStopped()) {
          log.warn(`${item.prefix}: stopped by an admin`);
          for (const f of leftovers) await dest.remove(f).catch(() => {}); // half-copied or half-extracted files
          if (leftovers.restoring) log.warn(`${item.prefix}: the restore was cut off, so ${item.database} is only partly loaded. Run a sync again to overwrite it.`);
          break;
        }
        failed.push(item.prefix);
        results.push(`${item.prefix}: FAILED - ${String(e.message).slice(0, 120)}`);
        log.error(`${item.prefix}: ${e.message}`);
      }
    }
  } catch (e) {
    log.error(e.message);
    return { ok: false, summary: e.message.slice(0, 300), lines: log.lines };
  } finally {
    await dest.remove(cnfPath).catch(() => {});
  }
  if (isStopped()) { timingLog.write(`run=${runId} | sync stopped | ${done} restored`); return { ok: false, stopped: true, summary: 'Stopped', lines: log.lines }; }
  const ok = failed.length === 0;
  timingLog.write(`run=${runId} | sync finished | ${done} restored, ${failed.length} failed`);
  const note = withErrors.length ? ` Completed with errors in: ${withErrors.join(', ')} (errors ignored, see the log).` : '';
  const head = ok ? `Restored ${done} database(s) in ${fmtMs(Date.now() - runStart)}.${note}` : `Failed: ${failed.join(', ')} (${done} restored, total ${fmtMs(Date.now() - runStart)}).${note}`;
  return { ok, warnings: withErrors.length > 0, lines: log.lines, summary: [head.trim(), ...results].join('\n') };
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
