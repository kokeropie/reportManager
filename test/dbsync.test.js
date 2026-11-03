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
    async query(text, p) { calls.push({ text, p }); return []; },
    async one(text, p) {
      calls.push({ text, p });
      if (/INSERT INTO dbsync_runs/.test(text)) return { id: 7 };
      if (/SELECT \* FROM dbsync_config/.test(text)) return cfgRow;
      if (/UPDATE dbsync_config/.test(text)) return { id: 1 };
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
