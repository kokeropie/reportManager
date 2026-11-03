'use strict';
const path = require('path');
const { copyStream, q } = require('./remote');

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

async function restoreOne({ source, dest, cfg, item, log, now, cnfPath }) {
  const files = await source.list(cfg.source.dir);
  const latest = pickLatest(files, item.prefix);
  if (!latest) throw new Error(`No file named ${item.prefix}_<date>_<time>.sql.gz in ${cfg.source.dir}`);
  log.info(`${item.prefix}: latest is ${latest.name} (${latest.size} bytes)`);
  if (latest.date !== ymd(now())) log.warn(`${item.prefix}: the newest file is dated ${latest.date}, not today. Is the backup job running?`);

  const dir = cfg.dest.dir;
  const gz = px.join(dir, latest.name);
  const sql = gz.replace(/\.gz$/, '');

  // Copy under a .part name and rename when whole, so a broken transfer never looks like a finished file.
  const from = await source.readStream(px.join(cfg.source.dir, latest.name));
  const to = await dest.writeStream(gz + '.part', 0o640);
  const bytes = await copyStream(from, to);
  if (bytes !== latest.size) throw new Error(`Copy incomplete: got ${bytes} of ${latest.size} bytes`);
  await dest.rename(gz + '.part', gz);
  log.info(`${item.prefix}: copied to ${gz}`);

  let r = await dest.exec(`gzip -t -- ${q(gz)}`);
  if (r.code !== 0) throw new Error(`The copied file is not a valid gzip file (${r.text || 'gzip -t failed'}). The backup may still have been writing.`);

  r = await dest.exec(`gzip -dc -- ${q(gz)} > ${q(sql + '.part')} && mv -f -- ${q(sql + '.part')} ${q(sql)}`);
  if (r.code !== 0) throw new Error(`Extract failed: ${r.text || 'exit ' + r.code}`);
  log.info(`${item.prefix}: extracted to ${sql}`);

  r = await dest.exec(`mysql --defaults-extra-file=${q(cnfPath)} --default-character-set=utf8mb4 --database=${q(item.database)} < ${q(sql)}`);
  if (r.code === 127) throw new Error(`The mysql client is not installed on ${dest.label}. On Ubuntu: sudo apt install mysql-client`);
  if (r.code !== 0) throw new Error(`Restore into ${item.database} failed: ${r.text || 'exit ' + r.code}`);
  log.info(`${item.prefix}: restored into database ${item.database}`);
}

// Returns { ok, summary, lines }. Each database is handled on its own, so one bad file does not block the other.
async function runSync({ cfg, source, dest, now = () => new Date(), onLine }) {
  const log = makeLog(onLine);
  const failed = [];
  let done = 0;
  const cnfPath = px.join(cfg.dest.dir, `.dbsync-${process.pid}-${Date.now()}.cnf`);
  try {
    await dest.mkdirp(cfg.dest.dir);
    await dest.writeSecret(cnfPath, optionFile(cfg.mysql));
    for (const item of cfg.items) {
      try {
        await restoreOne({ source, dest, cfg, item, log, now, cnfPath });
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
  return { ok, summary: ok ? `Restored ${done} database(s)` : `Failed: ${failed.join(', ')} (${done} restored)`, lines: log.lines };
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
