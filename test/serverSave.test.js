'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createServerFoldersRouter } = require('../src/export/serverFolders');
const { createReportsRouter } = require('../src/reports/routes');

function start(outputDir, userId = 5) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId, username: 'u', role: 'viewer' }; next(); });
  const grid = { rowCount: 1, columns: [{ name: 'A' }], header: [{ cells: [{ text: 'A' }] }], rows: [{ kind: 'detail', cells: [{ value: 'Hello' }] }], footer: [] };
  const runs = { exportData: async () => ({ reportName: 'Rep', grid }) };
  const reports = { getRow: async () => ({ name: 'Rep' }), canAccess: async () => true };
  app.use('/folders', createServerFoldersRouter({ outputDir }));
  app.use('/reports', createReportsRouter({ reports, runs, cfg: { outputDir, pageSize: 10 } }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
}

function call(s, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: s.address().port, method, path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('server folders: list, create, and no escaping the user area', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  const s = await start(dir);
  try {
    assert.deepStrictEqual((await call(s, 'GET', '/folders')).body.folders, []);
    assert.strictEqual((await call(s, 'POST', '/folders', { path: '', name: 'Finance' })).status, 201);
    assert.strictEqual((await call(s, 'POST', '/folders', { path: 'Finance', name: 'Daily' })).status, 201);
    const d = (await call(s, 'GET', '/folders?path=Finance')).body;
    assert.deepStrictEqual(d.folders, ['Daily']);
    assert.strictEqual(d.parent, '');
    assert.ok(fs.existsSync(path.join(dir, '5', 'Finance', 'Daily')));
    for (const bad of ['..', '../6', 'C:']) assert.strictEqual((await call(s, 'GET', '/folders?path=' + encodeURIComponent(bad))).status, 400, bad);
    assert.strictEqual((await call(s, 'POST', '/folders', { path: '', name: '..' })).status, 400);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export with saveTo writes the file under the user area', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  const s = await start(dir);
  try {
    const r = await call(s, 'POST', '/reports/1/export?format=csv', { params: {}, saveTo: 'Finance/Daily' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.saved, true);
    assert.ok(r.body.location.startsWith(path.join(dir, '5', 'Finance', 'Daily')));
    assert.match(fs.readFileSync(r.body.location, 'utf8'), /Hello/);
    assert.strictEqual((await call(s, 'POST', '/reports/1/export?format=csv', { params: {}, saveTo: '../6' })).status, 400);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
