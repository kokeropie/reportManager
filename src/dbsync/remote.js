'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

// Wraps one machine the module works on, so the sync code does not care whether it is reached over SSH or is this
// machine. Both kinds offer the same calls: list, size, readStream, writeStream, rename, remove, mkdirp, writeSecret, exec.
// Remote paths are always POSIX ("/home/backup_db"), so path.posix is used for them.

const TAIL = 4000; // keep only the end of command output; mysqldump restores can be chatty

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // shell quoting for one argument

function tailCollector() {
  let buf = '';
  return { push(c) { buf = (buf + c).slice(-TAIL); }, get text() { return buf.trim(); } };
}

function sshTarget({ host, port = 22, username, password, privateKey, passphrase, hostKey, pinHostKey = false, readyTimeout = 20000 }) {
  const conn = new Client();
  let sftp = null;
  let seenKey = null;
  let rejected = false;

  const connect = () => new Promise((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', (e) => reject(Object.assign(new Error(friendlySsh(e, host)), { cause: e })));
    if (password) conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => password)));
    const auth = {};
    if (privateKey) { auth.privateKey = privateKey; if (passphrase) auth.passphrase = passphrase; } // tried first
    if (password) { auth.password = password; auth.tryKeyboard = true; }
    try { conn.connect({
      host, port, username, ...auth, readyTimeout, keepaliveInterval: 15000,
      hostHash: 'sha256',
      // Trust on first use: the key is pinned when an admin presses Test, and every later run must match it.
      hostVerifier: (hash) => {
        seenKey = hash;
        if (pinHostKey) return true;
        rejected = !(hostKey && hostKey === hash);
        return !rejected;
      },
    }); } catch (e) { reject(Object.assign(new Error(friendlySsh(e, host)), { cause: e })); } // a key that cannot be read throws here
  });

  const getSftp = () => new Promise((resolve, reject) => {
    if (sftp) return resolve(sftp);
    conn.sftp((err, s) => { if (err) return reject(err); sftp = s; resolve(s); });
  });
  const call = async (fn, ...args) => {
    const s = await getSftp();
    return new Promise((resolve, reject) => s[fn](...args, (err, res) => (err ? reject(err) : resolve(res))));
  };

  const t = {
    kind: 'ssh',
    label: `${username}@${host}`,
    async open() {
      try { await connect(); } catch (e) {
        if (rejected) {
          throw new Error(hostKey
            ? `The host key of ${host} changed since it was trusted. If the server was reinstalled, press Test connection to trust the new key.`
            : `The host key of ${host} is not trusted yet. Press Test connection first.`);
        }
        throw e;
      }
      return t;
    },
    get fingerprint() { return seenKey; },
    async list(dir) {
      const rows = await call('readdir', dir);
      return rows.filter((r) => r.attrs.isFile()).map((r) => ({ name: r.filename, size: r.attrs.size }));
    },
    async size(file) { return (await call('stat', file)).size; },
    readStream: async (file) => (await getSftp()).createReadStream(file),
    writeStream: async (file, mode = 0o600) => (await getSftp()).createWriteStream(file, { mode }),
    rename: (a, b) => call('rename', a, b).catch(async () => { await call('unlink', b).catch(() => {}); return call('rename', a, b); }),
    remove: (file) => call('unlink', file),
    async mkdirp(dir) { const r = await t.exec(`mkdir -p -- ${q(dir)}`); if (r.code !== 0) throw new Error(r.text || `Cannot create ${dir}`); },
    async writeSecret(file, content) {
      const w = await t.writeStream(file, 0o600);
      await new Promise((resolve, reject) => { w.on('error', reject); w.on('close', resolve); w.end(content); });
    },
    // Runs a shell command. Resolves { code, text } where text is the tail of stdout+stderr; never rejects on a non-zero exit.
    exec(cmd) {
      return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          const out = tailCollector();
          stream.on('data', (c) => out.push(c.toString()));
          stream.stderr.on('data', (c) => out.push(c.toString()));
          stream.on('close', (code, signal) => resolve({ code: code === null || code === undefined ? (signal ? 255 : 0) : code, text: out.text }));
        });
      });
    },
    close() { try { conn.end(); } catch (e) { /* already closed */ } },
  };
  return t;
}

function friendlySsh(e, host) {
  const m = String((e && e.message) || e);
  if (/passphrase|Cannot parse privateKey|Encrypted private (OpenSSH )?key|bad decrypt|Malformed OpenSSH|Unsupported key format/i.test(m)) return `The private key for ${host} could not be read: ${/passphrase|encrypted|decrypt/i.test(m) ? 'it is protected by a passphrase that is missing or wrong.' : 'paste the whole private key file (not the .pub file).'}`;
  if (/All configured authentication methods failed/i.test(m)) return `Sign-in to ${host} was refused. Check the user name, and the password or private key (the server must have the matching public key in ~/.ssh/authorized_keys).`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m) || (e && /ENOTFOUND|EAI_AGAIN/.test(e.code || ''))) return `Cannot find ${host}. Check the address.`;
  if (/ECONNREFUSED/.test(m)) return `${host} refused the connection. Is SSH running and is the port right?`;
  if (/ETIMEDOUT|Timed out|timeout/i.test(m)) return `${host} did not answer in time. Check the address, port and firewall.`;
  if (/Handshake failed|Unable to verify|host key/i.test(m)) return `Could not verify the host key of ${host}.`;
  return m;
}

// "This machine": used when the app already runs on the Ubuntu server that holds the target folder.
function localTarget() {
  const t = {
    kind: 'local',
    label: 'this server',
    async open() { return t; },
    async list(dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }));
    },
    async size(file) { return fs.statSync(file).size; },
    readStream: async (file) => fs.createReadStream(file),
    writeStream: async (file, mode = 0o600) => fs.createWriteStream(file, { mode }),
    async rename(a, b) { fs.renameSync(a, b); },
    async remove(file) { fs.unlinkSync(file); },
    async mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); },
    async writeSecret(file, content) { fs.writeFileSync(file, content, { mode: 0o600 }); fs.chmodSync(file, 0o600); },
    exec(cmd) {
      return new Promise((resolve, reject) => {
        const p = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = tailCollector();
        p.stdout.on('data', (c) => out.push(c.toString()));
        p.stderr.on('data', (c) => out.push(c.toString()));
        p.on('error', reject);
        p.on('close', (code) => resolve({ code: code === null ? 255 : code, text: out.text }));
      });
    },
    close() {},
  };
  return t;
}

// Copies a stream and resolves only once the destination has been flushed and closed.
function copyStream(from, to, onProgress) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let last = 0;
    from.on('data', (c) => {
      bytes += c.length;
      if (onProgress && Date.now() - last > 1000) { last = Date.now(); onProgress(bytes); }
    });
    from.on('error', (e) => { to.destroy(); reject(e); });
    to.on('error', (e) => { from.destroy(); reject(e); });
    to.on('close', () => resolve(bytes));
    from.pipe(to);
  });
}

module.exports = { sshTarget, localTarget, copyStream, q, friendlySsh };
