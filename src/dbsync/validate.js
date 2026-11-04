'use strict';
const { normalize } = require('../subscriptions/schedule');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const noControl = (s) => !/[\u0000-\u001f]/.test(s);

function dir(v, label) {
  const s = text(v, 300).replace(/\/+$/, '') || '';
  if (!/^\/[^\0]*$/.test(s) || !noControl(s) || s.split('/').includes('..') || s === '') throw bad(`${label} must be a full Linux path such as /home/backup_db`);
  return s;
}
function port(v, def) {
  if (v === '' || v === undefined || v === null) return def;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('Port must be between 1 and 65535');
  return n;
}
function host(v, label, required) {
  const s = text(v, 255);
  if (!s && required) throw bad(`${label} address is required`);
  if (s && !/^[A-Za-z0-9._:-]+$/.test(s)) throw bad(`${label} address has characters that are not allowed`);
  return s;
}
function user(v, label) {
  const s = text(v, 100);
  if (!s || !noControl(s)) throw bad(`${label} user name is required`);
  return s;
}
function secret(v, label) {
  const s = v === undefined || v === null ? '' : String(v);
  if (s.length > 200 || !noControl(s)) throw bad(`${label} password has characters that are not allowed`);
  return s; // blank = keep the stored one
}

// Pasted private key (OpenSSH or PEM). Blank = keep the stored one. Line endings are normalised; a key is multi-line.
function privateKey(v, label) {
  const s = v === undefined || v === null ? '' : String(v).replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  if (s.length > 20000 || /[\u0000-\u0008\u000b-\u001f]/.test(s)) throw bad(`${label} private key has characters that are not allowed`);
  if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(s)) {
    throw bad(`${label} private key must be the whole key file, from "-----BEGIN ... PRIVATE KEY-----" to "-----END ... PRIVATE KEY-----". Do not paste the .pub file.`);
  }
  return s + '\n';
}

// Prefix is the part of the file name before the date stamp; database is where that file is restored.
function items(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) throw bad('Add at least one database to restore');
  const seen = new Set();
  return v.map((x) => {
    const prefix = text(x && x.prefix, 100);
    const database = text(x && x.database, 64);
    if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) throw bad('File name prefix may only use letters, digits, _ . and -');
    if (!/^[A-Za-z0-9_$]+$/.test(database)) throw bad('Database name may only use letters, digits, _ and $');
    if (seen.has(prefix)) throw bad(`Prefix ${prefix} is listed twice`);
    seen.add(prefix);
    return { prefix, database };
  });
}

// Schedules reuse the subscription rules, but only daily/weekly/monthly make sense for a nightly copy.
function schedule(v, label) {
  const s = normalize(v);
  if (s.type === 'interval') throw bad(`${label} must be daily, weekly or monthly`);
  return s;
}

function validateConfig(b, { platform = process.platform } = {}) {
  const body = b || {};
  const s = body.source || {}, d = body.dest || {}, m = body.mysql || {};
  const out = {
    enabled: !!body.enabled,
    source: { host: host(s.host, 'Backup server', true), port: port(s.port, 22), username: user(s.username, 'Backup server'), password: secret(s.password, 'Backup server'), privateKey: privateKey(s.privateKey, 'Backup server'), passphrase: secret(s.passphrase, 'Backup server key'), clearKey: !!s.clearKey, dir: dir(s.dir, 'Backup folder') },
    dest: { host: host(d.host, 'Ubuntu server', false), port: port(d.port, 22), username: text(d.username, 100), password: secret(d.password, 'Ubuntu server'), privateKey: privateKey(d.privateKey, 'Ubuntu server'), passphrase: secret(d.passphrase, 'Ubuntu server key'), clearKey: !!d.clearKey, dir: dir(d.dir, 'Target folder') },
    mysql: { host: host(m.host, 'MySQL', true), port: port(m.port, 3306), username: user(m.username, 'MySQL'), password: secret(m.password, 'MySQL') },
    items: items(body.items),
    syncSchedule: schedule(body.syncSchedule, 'Copy and restore schedule'),
    cleanupSchedule: schedule(body.cleanupSchedule, 'Cleanup schedule'),
  };
  if (out.dest.host) { if (!out.dest.username) throw bad('Ubuntu server user name is required'); }
  else if (platform === 'win32') throw bad('On Windows the Ubuntu server address is required, because the folder is on another machine');
  return out;
}

module.exports = { validateConfig };
