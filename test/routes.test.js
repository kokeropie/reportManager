'use strict';
// HTTP-level tests of auth, CSRF and the admin-only rules, using fake services (no SQL Server needed).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const session = require('express-session');
const { createAuthRouter, createUsersRouter } = require('../src/auth/routes');
const { requireAuth, csrfProtect } = require('../src/auth/middleware');
const { createConnectionsRouter } = require('../src/connections/routes');
const { createFoldersRouter } = require('../src/folders/routes');
const { createReportsRouter } = require('../src/reports/routes');
const { createAuditRouter } = require('../src/audit/routes');
const { publicConnection } = require('../src/connections/service');

const USERS = {
  admin: { id: 1, username: 'admin', role: 'admin', password: 'admin-pass-1' },
  viewer: { id: 2, username: 'viewer', role: 'viewer', password: 'viewer-pass-1' },
};
const SECRET_ROW = { id: 1, name: 'PTES', type: 'mssql', host: 'h', port: 1433, database_name: 'd', username: 'u', password_enc: 'v1:SECRET', trust_server_cert: 0 };

async function start() {
  const users = {
    authenticate: async (u, p) => (USERS[u] && USERS[u].password === p ? USERS[u] : null),
    list: async () => [], get: async () => null, countActiveAdmins: async () => 2,
  };
  const store = { destroyForUser: async () => {} };
  const db = {
    one: async () => ({ value: 'false' }),
    query: async (sql, p) => [
      { id: 1, name: 'Accounting', is_system: 0 },
      { id: 3, name: 'Connection', is_system: 1 },
    ].filter((f) => p.admin || !f.is_system),
  };
  const connections = {
    list: async () => [publicConnection(SECRET_ROW, 0)],
    get: async () => publicConnection(SECRET_ROW),
  };
  const app = express();
  app.use(express.json());
  app.use(session({ name: 'rs.sid', secret: 'test', resave: false, saveUninitialized: false }));
  const api = express.Router();
  api.use('/auth', createAuthRouter({ users, store, db }));
  api.use(requireAuth, csrfProtect);
  api.use('/users', createUsersRouter({ users, store }));
  api.use('/connections', createConnectionsRouter({ connections }));
  api.use('/folders', createFoldersRouter({ db, reports: {} }));
  const logged = [];
  const audit = { log: async (e) => { logged.push(e); }, list: async () => ({ rows: [], total: 0, page: 1, totalPages: 1, pageSize: 100 }) };
  const runs = {
    run: async () => ({ runId: 'r1', reportName: 'PJTI', dataRows: 2, page: 1, rows: [] }),
    exportData: async () => ({ reportName: 'My: Report', grid: { columns: [{ width: 1, name: 'A' }], rowCount: 1, rows: [{ kind: 'header', cells: [{ value: 'A' }] }, { kind: 'detail', cells: [{ value: 'x,y' }] }] } }),
  };
  api.use('/reports', createReportsRouter({ reports: { getRow: async () => ({ name: 'PJTI' }) }, runs, cfg: { pageSize: 100 }, audit }));
  api.use('/audit', createAuditRouter({ audit }));
  app.use('/api', api);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { logged, server, base: `http://127.0.0.1:${server.address().port}/api` };
}

function client(base) {
  let cookie = '';
  let csrf = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
  };
  call.cookie = () => cookie;
  call.csrf = () => csrf;
  call.login = async (u, p) => {
    csrf = (await call('GET', '/auth/csrf')).body.csrfToken;
    const r = await call('POST', '/auth/login', { username: u, password: p });
    if (r.status === 200) csrf = r.body.csrfToken;
    return r;
  };
  return call;
}

test('auth, CSRF and role rules', async (t) => {
  const { server, base, logged } = await start();
  t.after(() => server.close());

  await t.test('routes need a session', async () => {
    assert.strictEqual((await client(base)('GET', '/folders')).status, 401);
  });

  await t.test('login without CSRF token is refused', async () => {
    const c = client(base);
    const r = await c('POST', '/auth/login', { username: 'admin', password: 'admin-pass-1' });
    assert.strictEqual(r.status, 403);
  });

  await t.test('wrong password gives 401', async () => {
    assert.strictEqual((await client(base).login('admin', 'nope')).status, 401);
  });

  await t.test('writes without CSRF token are refused after login', async () => {
    const c = client(base);
    await c.login('admin', 'admin-pass-1');
    const bad = await fetch(base + '/auth/logout', { method: 'POST', headers: { cookie: 'x' } });
    assert.ok([401, 403].includes(bad.status));
  });

  await t.test('viewer: no Connection folder, 404 on connections and users (AC-4)', async () => {
    const c = client(base);
    assert.strictEqual((await c.login('viewer', 'viewer-pass-1')).status, 200);
    const folders = await c('GET', '/folders');
    assert.deepStrictEqual(folders.body.map((f) => f.name), ['Accounting']);
    assert.strictEqual((await c('GET', '/connections')).status, 404);
    assert.strictEqual((await c('GET', '/connections/1')).status, 404);
    assert.strictEqual((await c('POST', '/connections', {})).status, 404);
    assert.strictEqual((await c('GET', '/users')).status, 404);
    // viewers cannot upload, replace, move, delete or create folders (FR-9, AC-4)
    assert.strictEqual((await c('POST', '/folders/1/reports', { fileName: 'a.rdl', content: '<Report/>' })).status, 404);
    assert.strictEqual((await c('PUT', '/reports/1', { connectionId: 1 })).status, 404);
    assert.strictEqual((await c('PUT', '/reports/1/rdl', { content: 'x' })).status, 404);
    assert.strictEqual((await c('DELETE', '/reports/1')).status, 404);
    assert.strictEqual((await c('POST', '/folders', { name: 'X' })).status, 404);
    assert.strictEqual((await c('DELETE', '/folders/1')).status, 404);
    assert.strictEqual((await c('GET', '/audit')).status, 404, 'audit log is admin-only');
  });

  await t.test('viewer can run and export; both are audited with the computer details (FR-26a)', async () => {
    logged.length = 0;
    const c = client(base);
    await c.login('viewer', 'viewer-pass-1');
    const run = await c('POST', '/reports/7/run', { params: { startDate: '2026-01-01' } });
    assert.strictEqual(run.status, 200);
    assert.strictEqual(run.body.reportName, undefined, 'internal fields are not leaked');
    assert.strictEqual(logged[0].action, 'run');
    assert.strictEqual(logged[0].username, 'viewer');
    assert.deepStrictEqual(logged[0].params, { startDate: '2026-01-01' });
    assert.ok(logged[0].ip && 'userAgent' in logged[0]);
    assert.strictEqual((await c('POST', '/reports/7/export?format=pdf', {})).status, 400);
    const res = await fetch(base + '/reports/7/export?format=csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: c.cookie(), 'x-csrf-token': c.csrf() },
      body: JSON.stringify({ params: {} }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="My_ Report \d{8}-\d{4}\.csv"/);
    const bytes = Buffer.from(await res.arrayBuffer()); // res.text() would strip the BOM
    assert.deepStrictEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM present');
    assert.strictEqual(bytes.slice(3).toString('utf8'), 'A\r\n"x,y"\r\n');
    assert.strictEqual(logged[1].action, 'export-csv');
  });

  await t.test('admin: sees Connection folder; connection payload never contains a password (FR-5)', async () => {
    const c = client(base);
    assert.strictEqual((await c.login('admin', 'admin-pass-1')).status, 200);
    const folders = await c('GET', '/folders');
    assert.deepStrictEqual(folders.body.map((f) => f.name).sort(), ['Accounting', 'Connection']);
    const list = await c('GET', '/connections');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body[0].hasPassword, true);
    assert.ok(!list.raw.includes('SECRET') && !/password_enc|"password"/.test(list.raw));
  });
});
