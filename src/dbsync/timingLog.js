'use strict';
const fs = require('fs');
const path = require('path');

// A separate log file just for DB Sync timings (copy / unzip / restore per database). It is not the report
// server's log and not the dbsync_runs history in the database. Plain text, one line per step, append-only.
// Never throws: a full disk or a bad path must not fail a restore.

const MAX_BYTES = 5 * 1024 * 1024; // rotate to dbsync-timing.log.1 (one old file kept)
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${p2(Math.round(s - m * 60))}s`;
}

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function createTimingLog({ dir, now = () => new Date() } = {}) {
  if (!dir) return { write() {}, file: null };
  const file = path.join(dir, 'dbsync-timing.log');
  let ready = false;

  function write(line) {
    try {
      if (!ready) { fs.mkdirSync(dir, { recursive: true }); ready = true; }
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch (e) { /* no file yet */ }
      fs.appendFileSync(file, `${stamp(now())} ${line}\n`);
    } catch (e) { /* logging must never break a run */ }
  }
  return { write, file };
}

// Times one step. Writes "<db> | <step> | OK/FAILED | <duration> [| size ...]" and returns the milliseconds.
async function timed(tlog, run, db, step, fn, extra) {
  const t0 = Date.now();
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    const ms = Date.now() - t0;
    const more = typeof extra === 'function' ? extra() : extra;
    tlog.write(`run=${run} | ${db} | ${step} | ${ok ? 'OK' : 'FAILED'} | ${fmtMs(ms)} (${ms} ms)${more ? ' | ' + more : ''}`);
  }
}

module.exports = { createTimingLog, timed, fmtMs, fmtBytes };
