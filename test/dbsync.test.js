'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pickLatest, ownedFile, optionFile, runSync, runCleanup } = require('../src/dbsync/sync');
const { validateConfig } = require('../src/dbsync/validate');
const { localTarget, q } = require('../src/dbsync/remote');
const { createRunner, createDbSyncScheduler } = require('../src/dbsync/runner');

const f = (name, size = 1) => ({ name, size });

test('pickLatest: newest stamp wins, other prefixes and lookalikes are ignored', () => {
  const files = [
    f('dev_kenji_20261102_000000.sql.gz'), f('dev_kenji_20261103_000000.sql.gz'), f('dev_kenji_20261103_020000.sql.gz'),
    f('dev_kenji_arjuna_20261104_000000.sql.gz'), f('dev_kenji_20261105_000000.sql'), f('xdev_kenji_20261105_000000.sql.gz'),
    f('dev_arjuna_20261103_000000.sql.gz'),
  ];
  assert.strictEqual(pickLatest(files, 'dev_kenji').name, 'dev_kenji_20261103_020000.sql.gz');
  assert.strictEqual(pickLatest(files, 'dev_arjuna').name, 'dev_arjuna_20261103_000000.sql.gz');
  assert.strictEqual(pickLatest(files, 'dev_other'), null);
});

test('ownedFile only matches this module\'s files', () => {
  assert.ok(ownedFile('dev_kenji_20261103_000000.sql.gz', 'dev_kenji'));
  assert.ok(ownedFile('dev_kenji_20261103_000000.sql', 'dev_kenji'));
  assert.ok(ownedFile('dev_kenji_20261103_000000.sql.gz.part', 'dev_kenji'));
  assert.ok(!ownedFile('notes.txt', 'dev_kenji'));
  assert.ok(!ownedFile('dev_kenji_arjuna_20261103_000000.sql.gz', 'dev_kenji'));
});

test('optionFile quotes awkward passwords', () => {
  const t = optionFile({ host: 'h', port: 3306, username: 'u', password: 'a"b\\c #d' });
  assert.match(t, /password="a\\"b\\\\c #d"/);
});

test('shell quoting survives single quotes', () => assert.strictEqual(q("a'b"), `'a'\\''b'`));

const good = () => ({
  enabled: true,
  source: { host: '10.0.0.5', port: '22', username: 'bk', password: 'x', dir: '/home/backup_db/' },
  dest: { host: 'ubuntu26', username: 'u', password: 'y', dir: '/home/mysqlbackup' },
  mysql: { host: 'localhost', username: 'root', password: 'z' },
  items: [{ prefix: 'dev_arjuna', database: 'dev_arjuna' }, { prefix: 'dev_kenji', database: 'dev_kenji' }],
  syncSchedule: { type: 'daily', time: '02:00' }, cleanupSchedule: { type: 'daily', time: '18:00' },
});

test('validateConfig: accepts a good form, strips trailing slash, defaults ports', () => {
  const v = validateConfig(good());
  assert.strictEqual(v.source.dir, '/home/backup_db');
  assert.strictEqual(v.dest.port, 22);
  assert.strictEqual(v.mysql.port, 3306);
});

test('validateConfig: rejects path tricks, bad names, interval schedules, Windows without a server address', () => {
  const t = (mut, re, opts) => { const b = good(); mut(b); assert.throws(() => validateConfig(b, opts), re); };
  t((b) => { b.source.dir = 'home/x'; }, /full Linux path/);
  t((b) => { b.dest.dir = '/home/../etc'; }, /full Linux path/);
  t((b) => { b.items[0].database = 'x; DROP'; }, /Database name/);
  t((b) => { b.items[0].prefix = 'a b'; }, /prefix/i);
  t((b) => { b.items[1].prefix = 'dev_arjuna'; }, /twice/);
  t((b) => { b.items = []; }, /at least one/);
  t((b) => { b.source.port = 70000; }, /Port/);
  t((b) => { b.syncSchedule = { type: 'interval', everyMinutes: 60 }; }, /daily, weekly or monthly/);
  t((b) => { b.source.password = 'a\nb'; }, /not allowed/);
  t((b) => { b.dest.host = ''; }, /On Windows/, { platform: 'win32' });
  assert.doesNotThrow(() => { const b = good(); b.dest.host = ''; validateConfig(b, { platform: 'linux' }); });
});

// ---- the real copy / extract / restore on this machine, with a stand-in `mysql` ----

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsync-'));
  const src = path.join(root, 'backup_db'), dst = path.join(root, 'mysqlbackup'), bin = path.join(root, 'bin'), out = path.join(root, 'out');
  for (const d of [src, bin, out]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'mysql'), `#!/bin/sh
for a in "$@"; do case "$a" in --database=*) db="\${a#--database=}";; --defaults-extra-file=*) cnf="\${a#*=}";; esac; done
cat > "${out}/$db.sql"
echo "$@" > "${out}/$db.args"
if [ -f "${out}/FAIL_$db" ]; then cat "${out}/FAIL_$db" >&2; exit 1; fi
cp "$cnf" "${out}/$db.cnf"
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  const gz = (name, text) => fs.writeFileSync(path.join(src, name), zlib.gzipSync(text));
  const cfg = {
    source: { dir: src }, dest: { dir: dst }, mysql: { host: 'db', port: 3306, username: 'u', password: 'p w' },
    items: [{ prefix: 'dev_arjuna', database: 'dev_arjuna' }, { prefix: 'dev_kenji', database: 'dev_kenji' }],
  };
  return { root, src, dst, out, cfg, gz, done() { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); } };
}

test('runSync copies only the newest file per database, extracts and restores it, removes the secret file', async () => {
  const w = workspace();
  try {
    w.gz('dev_arjuna_20261102_000000.sql.gz', 'OLD ARJUNA');
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'SELECT 1; -- arjuna');
    w.gz('dev_kenji_20261103_000000.sql.gz', 'SELECT 2; -- kenji');
    const lines = [];
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2), onLine: (l) => lines.push(l) });
    assert.strictEqual(res.ok, true, res.lines.join('\n'));
    assert.deepStrictEqual(fs.readdirSync(w.dst).sort(), [
      'dev_arjuna_20261103_000000.sql', 'dev_arjuna_20261103_000000.sql.gz', 'dev_kenji_20261103_000000.sql', 'dev_kenji_20261103_000000.sql.gz']);
    assert.strictEqual(fs.readFileSync(path.join(w.out, 'dev_arjuna.sql'), 'utf8'), 'SELECT 1; -- arjuna');
    assert.strictEqual(fs.readFileSync(path.join(w.out, 'dev_kenji.sql'), 'utf8'), 'SELECT 2; -- kenji');
    assert.match(fs.readFileSync(path.join(w.out, 'dev_kenji.cnf'), 'utf8'), /password="p w"/);
    assert.ok(lines.length >= 8);
    assert.ok(!res.lines.some((l) => /WARN/.test(l)));
  } finally { w.done(); }
});

test('runSync writes copy / verify / unzip / restore timings per file to the separate timing log', async () => {
  const w = workspace();
  const logDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbsync-tlog-'));
  try {
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'SELECT 1; -- arjuna');
    w.gz('dev_kenji_20261103_000000.sql.gz', 'SELECT 2; -- kenji');
    const { createTimingLog } = require('../src/dbsync/timingLog');
    const tl = createTimingLog({ dir: logDir });
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2), timingLog: tl, runId: 7 });
    assert.strictEqual(res.ok, true, res.lines.join('\n'));
    const text = fs.readFileSync(path.join(logDir, 'dbsync-timing.log'), 'utf8');
    for (const step of ['copy', 'verify (gzip -t)', 'unzip', 'restore', 'TOTAL']) assert.match(text, new RegExp(`run=7 \\| dev_kenji_20261103_000000.sql.gz \\| ${step.replace(/[()]/g, '\\$&')} \\| OK`));
    assert.ok(!/password/i.test(text));
  } finally { w.done(); fs.rmSync(logDir, { recursive: true, force: true }); }
});

test('runSync: a broken file fails that database only; a stale date is flagged', async () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.src, 'dev_arjuna_20261103_000000.sql.gz'), 'this is not gzip');
    w.gz('dev_kenji_20261101_000000.sql.gz', 'SELECT 2;');
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2) });
    assert.strictEqual(res.ok, false);
    assert.match(res.summary, /dev_arjuna/);
    assert.match(res.lines.join('\n'), /not a valid gzip/);
    assert.match(res.lines.join('\n'), /WARN dev_kenji: the newest file is dated 20261101/);
    assert.strictEqual(fs.readFileSync(path.join(w.out, 'dev_kenji.sql'), 'utf8'), 'SELECT 2;');
    assert.ok(!fs.existsSync(path.join(w.out, 'dev_arjuna.sql')));
  } finally { w.done(); }
});

test('runSync: no matching file is reported by name', async () => {
  const w = workspace();
  try {
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget() });
    assert.strictEqual(res.ok, false);
    assert.match(res.lines.join('\n'), /No file named dev_arjuna_<date>_<time>\.sql\.gz/);
  } finally { w.done(); }
});

test('runCleanup deletes this module\'s files only', async () => {
  const w = workspace();
  try {
    fs.mkdirSync(w.dst);
    for (const n of ['dev_kenji_20261103_000000.sql.gz', 'dev_kenji_20261103_000000.sql', 'dev_arjuna_20261103_000000.sql', '.dbsync-1-2.cnf', 'keep-me.txt']) fs.writeFileSync(path.join(w.dst, n), 'x');
    const res = await runCleanup({ cfg: w.cfg, dest: localTarget() });
    assert.strictEqual(res.summary, 'Deleted 4 file(s)');
    assert.deepStrictEqual(fs.readdirSync(w.dst), ['keep-me.txt']);
    fs.rmSync(w.dst, { recursive: true });
    assert.strictEqual((await runCleanup({ cfg: w.cfg, dest: localTarget() })).ok, true); // missing folder is fine
  } finally { w.done(); }
});

// ---- runner and scheduler against a recording fake db ----

function fakeDb(cfgRow) {
  const calls = [];
  return {
    calls,
    async query(text, p) {
      calls.push({ text, p });
      if (/INSERT INTO dbsync_runs/.test(text)) return Object.assign([], { insertId: 7, affectedRows: 1 });
      if (/UPDATE dbsync_config/.test(text)) return Object.assign([], { affectedRows: 1 });
      return [];
    },
    async one(text, p) {
      calls.push({ text, p });
      if (/SELECT \* FROM dbsync_config/.test(text)) return cfgRow;
      return null;
    },
  };
}
const quiet = { error() {}, log() {} };

test('runner: records the run, refuses a second one at the same time', async () => {
  const w = workspace();
  try {
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'A'); w.gz('dev_kenji_20261103_000000.sql.gz', 'K');
    const db = fakeDb(null);
    // a source "host" is set so the form check passes; both ends are really this machine
    const service = { getWithSecret: async () => ({ ...w.cfg, source: { host: 'x', dir: w.src }, dest: { host: '', dir: w.dst } }) };
    const runner = createRunner({ db, service, open: () => localTarget(), log: quiet });
    const run = await runner.start('sync', 'manual');
    await assert.rejects(() => runner.start('cleanup', 'manual'), /already running/);
    const res = await run.done;
    assert.strictEqual(res.ok, true, res.summary);
    const fin = db.calls.find((c) => /SET finished_at/.test(c.text));
    assert.strictEqual(fin.p.s, 'ok');
    assert.strictEqual(runner.busy, null);
  } finally { w.done(); }
});

test('scheduler: runs a due job once and moves its next time; ignores a future or disabled one', async () => {
  const now = new Date(2026, 10, 3, 18, 0, 5);
  const row = (over) => ({ enabled: true, sync_schedule: '{"type":"daily","time":"02:00"}', cleanup_schedule: '{"type":"daily","time":"18:00"}',
    next_sync_at: new Date(2026, 10, 4, 2, 0), next_cleanup_at: new Date(2026, 10, 3, 18, 0), ...over });
  const started = [];
  const runner = { busy: null, start: async (k, by) => { started.push([k, by]); return { done: Promise.resolve() }; } };
  let db = fakeDb(row());
  assert.strictEqual(await createDbSyncScheduler({ db, runner, now: () => now, log: quiet }).tick(), 1);
  assert.deepStrictEqual(started, [['cleanup', 'schedule']]);
  const upd = db.calls.find((c) => /UPDATE dbsync_config SET next_cleanup_at/.test(c.text));
  assert.deepStrictEqual(upd.p.next, new Date(2026, 10, 4, 18, 0));

  started.length = 0;
  db = fakeDb(row({ next_cleanup_at: new Date(2026, 10, 4, 18, 0) }));
  assert.strictEqual(await createDbSyncScheduler({ db, runner, now: () => now, log: quiet }).tick(), 0);
  db = fakeDb(row({ enabled: false }));
  assert.strictEqual(await createDbSyncScheduler({ db, runner, now: () => now, log: quiet }).tick(), 0);
  assert.strictEqual(started.length, 0);
});

test('restore: SQL errors during import are ignored (--force); the run completes with a warning', async () => {
  const w = workspace();
  try {
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'A'); w.gz('dev_kenji_20261103_000000.sql.gz', 'K');
    fs.writeFileSync(path.join(w.out, 'FAIL_dev_arjuna'), "ERROR 1062 (23000) at line 42: Duplicate entry '1' for key 'PRIMARY'\nERROR 1146 (42S02) at line 90: Table 'x' doesn't exist\n");
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2, 0), onLine() {} });
    assert.strictEqual(res.ok, true, res.summary);
    assert.strictEqual(res.warnings, true);
    assert.match(res.summary, /Completed with errors in: dev_arjuna/);
    assert.match(res.lines.join('\n'), /2 error message\(s\), ignored/);
    assert.match(fs.readFileSync(path.join(w.out, 'dev_arjuna.args'), 'utf8'), /--force/);
    assert.strictEqual(fs.readFileSync(path.join(w.out, 'dev_kenji.sql'), 'utf8'), 'K', 'the other database is still restored');
  } finally { w.done(); }
});

test('restore: a login or connection failure still fails that database', async () => {
  const w = workspace();
  try {
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'A'); w.gz('dev_kenji_20261103_000000.sql.gz', 'K');
    fs.writeFileSync(path.join(w.out, 'FAIL_dev_kenji'), "ERROR 1045 (28000): Access denied for user 'u'@'localhost'\n");
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2, 0), onLine() {} });
    assert.strictEqual(res.ok, false);
    assert.match(res.summary, /Failed: dev_kenji/);
  } finally { w.done(); }
});

// ---- private-key login ----
const { utils: sshUtils, Server: SshServer } = require('ssh2');
const { sshTarget } = require('../src/dbsync/remote');

test('validateConfig: private key must be a whole key file; blank keeps; the .pub line is refused', () => {
  const key = sshUtils.generateKeyPairSync('ed25519');
  const b = good(); b.source.privateKey = key.private.replace(/\n/g, '\r\n');
  const v = validateConfig(b);
  assert.match(v.source.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.strictEqual(validateConfig(good()).source.privateKey, '');
  const pub = good(); pub.source.privateKey = key.public;
  assert.throws(() => validateConfig(pub), /whole key file/);
});

async function keyServer(authorizedPublic) {
  const host = sshUtils.generateKeyPairSync('ed25519');
  const allowed = sshUtils.parseKey(authorizedPublic);
  const seen = [];
  const server = new SshServer({ hostKeys: [host.private] }, (client) => {
    client.on('authentication', (ctx) => {
      seen.push(ctx.method);
      if (ctx.method === 'publickey' && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0) {
        if (!ctx.signature) return ctx.accept();
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject(['publickey']);
    });
    client.on('ready', () => {});
    client.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

test('sshTarget signs in with a private key (no password); a wrong key gives a readable message', async () => {
  const good1 = sshUtils.generateKeyPairSync('ed25519');
  const other = sshUtils.generateKeyPairSync('ed25519');
  const srv = await keyServer(good1.public);
  try {
    const ok = sshTarget({ host: '127.0.0.1', port: srv.port, username: 'bk', privateKey: good1.private, pinHostKey: true, readyTimeout: 5000 });
    await ok.open();
    assert.ok(srv.seen.includes('publickey'));
    ok.close();
    const wrong = sshTarget({ host: '127.0.0.1', port: srv.port, username: 'bk', privateKey: other.private, pinHostKey: true, readyTimeout: 5000 });
    await assert.rejects(() => wrong.open(), /Sign-in to 127\.0\.0\.1 was refused.*private key/);
    const garbage = sshTarget({ host: '127.0.0.1', port: srv.port, username: 'bk', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n', pinHostKey: true, readyTimeout: 5000 });
    await assert.rejects(() => garbage.open(), /private key .* could not be read/);
  } finally { srv.close(); }
});

test('service.save stores the key encrypted, never returns it, keeps it on blank, removes it on clearKey', async () => {
  const { createDbSyncService } = require('../src/dbsync/service');
  const { bindNamed } = require('../src/db');
  const keyHex = 'ab'.repeat(32);
  const row = { enabled: 0, src_host: '', src_port: 22, dst_host: '', dst_port: 22, src_hostkey: null, dst_hostkey: null,
    items: '[]', sync_schedule: '{"type":"daily","time":"02:00"}', cleanup_schedule: '{"type":"daily","time":"18:00"}' };
  const db = {
    one: async () => ({ ...row }),
    query: async (sql, p) => {
      const { values } = bindNamed(sql, p); // throws if a placeholder has no value
      assert.ok(values.length > 20);
      if (/UPDATE dbsync_config SET enabled/.test(sql)) {
        if (p.skk !== null) row.src_key_enc = p.skk;
        if (p.skp !== null) row.src_passphrase_enc = p.skp;
      }
      return [];
    },
  };
  const svc = createDbSyncService({ db, encryptionKey: keyHex });
  const k = sshUtils.generateKeyPairSync('ed25519').private;
  const saved = await svc.save({ ...good(), source: { ...good().source, privateKey: k, passphrase: 'pp' } });
  assert.strictEqual(saved.source.hasKey, true);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE KEY'));
  assert.ok(!row.src_key_enc.includes('PRIVATE KEY'), 'stored encrypted');
  const secret = await svc.getWithSecret();
  assert.strictEqual(secret.source.privateKey, k.replace(/\r\n?/g, '\n').trim() + '\n');
  assert.strictEqual(secret.source.passphrase, 'pp');
  await svc.save(good());
  assert.strictEqual((await svc.getWithSecret()).source.privateKey.length > 0, true, 'blank keeps the stored key');
  await svc.save({ ...good(), source: { ...good().source, clearKey: true } });
  assert.strictEqual((await svc.get()).source.hasKey, false);
});

test('runSync reports what it is doing: each step, which file, with start and done lines', async () => {
  const w = workspace();
  try {
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'A'); w.gz('dev_kenji_20261103_000000.sql.gz', 'K');
    const steps = [], lines = [];
    const res = await runSync({ cfg: w.cfg, source: localTarget(), dest: localTarget(), now: () => new Date(2026, 10, 3, 2), onLine: (l) => lines.push(l), onStep: (s) => steps.push(s) });
    assert.strictEqual(res.ok, true, res.summary);
    const all = steps.join('\n');
    assert.match(all, /\[1\/2\] dev_arjuna: copying dev_arjuna_20261103_000000\.sql\.gz/);
    assert.match(all, /\[1\/2\] dev_arjuna: checking/);
    assert.match(all, /\[2\/2\] dev_kenji: extracting/);
    assert.match(all, /\[2\/2\] dev_kenji: restoring dev_kenji_20261103_000000\.sql into database dev_kenji/);
    const text = lines.join('\n');
    assert.match(text, /dev_arjuna: copying dev_arjuna_20261103_000000\.sql\.gz \(.*\)\.\.\./);
    assert.match(text, /dev_arjuna: restored into database dev_arjuna in /);
  } finally { w.done(); }
});

test('Stop: kills a running restore, ends the run as stopped, skips the next database, removes leftovers', async () => {
  const w = workspace();
  try {
    // a restore that never finishes by itself
    fs.writeFileSync(path.join(w.root, 'bin', 'mysql'), `#!/bin/sh\necho $$ > "${w.out}/pid"\nsleep 60\n`, { mode: 0o755 });
    w.gz('dev_arjuna_20261103_000000.sql.gz', 'A'); w.gz('dev_kenji_20261103_000000.sql.gz', 'K');
    const db = fakeDb(null);
    const service = { getWithSecret: async () => ({ ...w.cfg, source: { host: 'x', dir: w.src }, dest: { host: '', dir: w.dst } }) };
    const runner = createRunner({ db, service, open: () => localTarget(), log: quiet });
    const run = await runner.start('sync', 'manual');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(w.out, 'pid')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(w.out, 'pid')), 'restore started');
    const pid = Number(fs.readFileSync(path.join(w.out, 'pid'), 'utf8'));
    runner.stop('kusuma');
    const res = await run.done;
    assert.strictEqual(res.stopped, true);
    assert.match(res.summary, /Stopped by kusuma/);
    const fin = db.calls.find((c) => /SET finished_at/.test(c.text));
    assert.strictEqual(fin.p.s, 'stopped');
    assert.match(fin.p.log, /partly loaded/);
    assert.ok(!fin.p.log.includes('dev_kenji: copying'), 'the second database was not started');
    assert.strictEqual(fs.existsSync(path.join(w.out, 'dev_kenji.sql')), false);
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = false; }
    assert.strictEqual(alive, false, 'the mysql process is gone');
    assert.strictEqual(runner.busy, null);
    assert.throws(() => runner.stop('x'), /Nothing is running/);
  } finally { w.done(); }
});
