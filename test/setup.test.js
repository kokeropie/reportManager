'use strict';
// First-run setup page: code gate, validation, .env writing, key safety, admin rule (no database needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSetupApp, newSetupCode, validateForm } = require('../src/setup/server');
const { updateEnvText, quote } = require('../src/setup/env');
const dotenv = require('dotenv');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
const GOOD = { code: 'abcd-efgh-jkmn', server: '117.102.85.247\\ins', port: '', database: 'ReportServer', user: 'sa', password: "p@ss#w0rd 'x", trustCert: true, createDb: true, adminUsername: 'boss', adminPassword: 'long-enough-1' };

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
  const envPath = path.join(dir, '.env');
  if (opts.existingEnv) fs.writeFileSync(envPath, opts.existingEnv);
  const calls = { created: 0, applied: null };
  let inspectResult = opts.inspect || { ok: true, missingDb: false, users: 0, connections: 0 };
  const app = createSetupApp({
    envPath, templatePath: path.join(__dirname, '..', '.env.example'), code: 'ABCD-EFGH-JKMN',
    existingKeyOk: !!opts.keyOk,
    inspect: async () => (typeof inspectResult === 'function' ? inspectResult() : inspectResult),
    createDb: async () => { calls.created++; if (opts.createFails) throw new Error('CREATE DATABASE permission denied'); inspectResult = { ok: true, missingDb: false, users: 0, connections: 0 }; },
    onApplied: (r) => { calls.applied = r; },
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { server, base, post, envPath, calls, dir };
}

test('code format', () => {
  assert.match(newSetupCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notStrictEqual(newSetupCode(), newSetupCode());
});

test('env writing: quoting and in-place update keep the rest of the file', () => {
  assert.strictEqual(quote('abc.123'), 'abc.123');
  assert.strictEqual(quote('117.102.85.247\\ins'), "'117.102.85.247\\ins'");
  assert.strictEqual(quote("it's"), '"it\'s"');
  assert.throws(() => quote('a\nb'));
  assert.throws(() => quote('both \' and "'));
  const out = updateEnvText('A=1\n# note\nB=2\n', { B: 'x y', C: 'new' });
  assert.strictEqual(out, "A=1\n# note\nB='x y'\nC=new\n");
});

test('wrong or missing setup code is refused (and nothing is written)', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  assert.strictEqual((await s.post('/setup/test', { ...GOOD, code: 'WRONG' })).status, 403);
  assert.strictEqual((await s.post('/setup/apply', { ...GOOD, code: undefined })).status, 403);
  assert.strictEqual(fs.existsSync(s.envPath), false);
});

test('form validation', () => {
  assert.ok(validateForm({ ...GOOD, server: '' }).error);
  assert.ok(validateForm({ ...GOOD, port: '70000' }).error);
  assert.ok(validateForm({ ...GOOD, database: 'x]; DROP DATABASE y;--' }).error);
  assert.ok(validateForm({ ...GOOD, user: '' }).error);
  assert.ok(validateForm({ ...GOOD, password: '' }).error);
  assert.ok(validateForm({ ...GOOD, password: 'a\'b"c' }).error);
  assert.strictEqual(validateForm(GOOD).value.port, 1433);
});

test('apply: writes .env that the app can read back, then hands over with the first admin', async (t) => {
  const s = await start({ inspect: { ok: true, missingDb: true, users: 0, connections: 0 } });
  t.after(() => s.server.close());
  const r = await s.post('/setup/apply', GOOD);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.createdAdmin, true);
  assert.strictEqual(s.calls.created, 1, 'missing database was created');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepStrictEqual(s.calls.applied.admin, { username: 'boss', password: 'long-enough-1' });
  const env = dotenv.parse(fs.readFileSync(s.envPath));
  assert.strictEqual(env.APP_DB_SERVER, '117.102.85.247\\ins');
  assert.strictEqual(env.APP_DB_USER, 'sa');
  assert.strictEqual(env.APP_DB_PASSWORD, "p@ss#w0rd 'x", 'password with # space and quote survives');
  assert.match(env.ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.ok(env.SESSION_SECRET.length >= 32);
  assert.ok(!('ADMIN_PASSWORD' in env) || env.ADMIN_PASSWORD === '', 'admin password is never written to disk');
  assert.ok(!fs.readFileSync(s.envPath, 'utf8').includes('long-enough-1'));
});

test('apply: an existing ENCRYPTION_KEY is kept, never replaced', async (t) => {
  const key = 'ab'.repeat(32);
  const s = await start({ existingEnv: TEMPLATE.replace(/^ENCRYPTION_KEY=.*$/m, 'ENCRYPTION_KEY=' + key), keyOk: true, inspect: { ok: true, missingDb: false, users: 3, connections: 5 } });
  t.after(() => s.server.close());
  const r = await s.post('/setup/apply', { ...GOOD, adminPassword: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.createdAdmin, false, 'database already has users, so no admin is needed');
  assert.strictEqual(dotenv.parse(fs.readFileSync(s.envPath)).ENCRYPTION_KEY, key);
});

test('apply: refuses to invent a new key when the database has saved connections', async (t) => {
  const s = await start({ inspect: { ok: true, missingDb: false, users: 2, connections: 4 } });
  t.after(() => s.server.close());
  const r = await s.post('/setup/apply', GOOD);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /original ENCRYPTION_KEY/);
  assert.strictEqual(fs.existsSync(s.envPath), false);
  const ok = await s.post('/setup/apply', { ...GOOD, encryptionKey: 'cd'.repeat(32) });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(dotenv.parse(fs.readFileSync(s.envPath)).ENCRYPTION_KEY, 'cd'.repeat(32));
});

test('apply: a first admin is required for an empty database', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const r = await s.post('/setup/apply', { ...GOOD, adminPassword: 'short' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /first admin/);
  assert.strictEqual(fs.existsSync(s.envPath), false);
});

test('apply: connection failure and create-database failure are reported, nothing written', async (t) => {
  const s1 = await start({ inspect: { ok: false, error: "Login failed for user 'sa'.", hint: 'Check the password.' } });
  t.after(() => s1.server.close());
  const r1 = await s1.post('/setup/apply', GOOD);
  assert.strictEqual(r1.status, 502);
  assert.match(r1.body.error, /Login failed/);
  assert.strictEqual(r1.body.hint, 'Check the password.');
  const s2 = await start({ inspect: { ok: true, missingDb: true, users: 0, connections: 0 }, createFails: true });
  t.after(() => s2.server.close());
  const r2 = await s2.post('/setup/apply', GOOD);
  assert.strictEqual(r2.status, 502);
  assert.match(r2.body.error, /permission denied/);
  assert.strictEqual(fs.existsSync(s2.envPath), false);
  const s3 = await start({ inspect: { ok: true, missingDb: true, users: 0, connections: 0 } });
  t.after(() => s3.server.close());
  assert.strictEqual((await s3.post('/setup/apply', { ...GOOD, createDb: false })).status, 400);
});

test('test endpoint is read-only and says whether the database will be created', async (t) => {
  const s = await start({ inspect: { ok: true, missingDb: true, users: 0, connections: 0 } });
  t.after(() => s.server.close());
  const r = await s.post('/setup/test', GOOD);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.message, /will be created/);
  assert.strictEqual(s.calls.created, 0);
  assert.strictEqual(fs.existsSync(s.envPath), false);
});

test('only the setup page is served; everything else is 404, healthz says not ready', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  assert.strictEqual((await fetch(s.base + '/setup.html')).status, 200);
  assert.strictEqual((await fetch(s.base + '/api/users')).status, 404);
  assert.strictEqual((await fetch(s.base + '/login.html')).status, 404);
  assert.strictEqual((await fetch(s.base + '/healthz')).status, 503);
});

test('inspect counts never mention a table that may not exist (fresh database)', async () => {
  const sql = require('mssql');
  const queries = [];
  const orig = sql.ConnectionPool;
  sql.ConnectionPool = class {
    async connect() {}
    async close() {}
    request() {
      const self = { input() { return self; }, async query(q) { queries.push(q); return { recordset: [{ has_users: 0, has_connections: 0 }] }; } };
      return self;
    }
  };
  try {
    const { inspectAppDb } = require('../src/setup/db');
    const r = await inspectAppDb({ server: 'h', port: 1433, database: 'ReportServer', user: 'u', password: 'p', trustServerCertificate: true });
    assert.deepStrictEqual([r.ok, r.users, r.connections], [true, 0, 0]);
    assert.ok(queries.every((q) => !/FROM\s+(users|connections)/i.test(q)), 'no query touches a missing table');
  } finally {
    sql.ConnectionPool = orig;
  }
});
