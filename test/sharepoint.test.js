'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSharePointSync } = require('../src/sharepoint/sync');
const { createGraphClient, cleanSegment, CHUNK } = require('../src/sharepoint/graph');
const { load, validate } = require('../src/config');

const quiet = { error() {}, log() {} };

function fakeDb(users) {
  const state = { folders: new Map(), uploads: new Map(), users: { ...users } };
  return {
    state,
    one: async (sql, p) => {
      if (/FROM sharepoint_user_folders/.test(sql)) { const f = state.folders.get(p.id); return f ? { folder_name: f } : null; }
      if (/FROM users/.test(sql)) return state.users[p.id] ? { username: state.users[p.id] } : null;
      throw new Error('unexpected SQL ' + sql);
    },
    query: async (sql, p) => {
      if (/INSERT IGNORE INTO sharepoint_user_folders/.test(sql)) {
        const taken = [...state.folders.values()].some((n) => n.toLowerCase() === p.name.toLowerCase());
        if (taken || state.folders.has(p.id)) return Object.assign([], { affectedRows: 0 });
        state.folders.set(p.id, p.name); return Object.assign([], { affectedRows: 1 });
      }
      if (/FROM sharepoint_uploads/.test(sql)) return [...state.uploads].filter(([k]) => k.startsWith(p.id + '|')).map(([k, v]) => ({ rel_path: k.slice(k.indexOf('|') + 1), ...v }));
      if (/INSERT INTO sharepoint_uploads/.test(sql)) { state.uploads.set(p.id + '|' + p.rel, { size: p.size, mtime_ms: p.mtime }); return []; }
      throw new Error('unexpected SQL ' + sql);
    },
  };
}

function setup(users) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const calls = [];
  const graph = { uploadFile: async (segs, abs) => { calls.push(segs.join('/')); } };
  const db = fakeDb(users);
  const sync = createSharePointSync({ db, graph, outputDir: dir, dest: 'Report Output', log: quiet });
  const put = (rel, text = 'x') => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  return { dir, calls, db, sync, put };
}

test('files go to <dest>/<username>/<same folders>/<file>; temp files are skipped; unchanged files are not sent twice', async () => {
  const { calls, sync, put } = setup({ 7: 'kusuma' });
  put('7/Finance/Daily/a.xlsx'); put('7/Finance/Daily/b.csv.tmp'); put('7/top.csv');
  const s = await sync.sweep();
  assert.strictEqual(s.uploaded, 2);
  assert.deepStrictEqual(calls.sort(), ['Report Output/kusuma/Finance/Daily/a.xlsx', 'Report Output/kusuma/top.csv']);
  calls.length = 0;
  assert.strictEqual((await sync.sweep()).uploaded, 0);
  put('7/Finance/Daily/a.xlsx', 'changed content');
  assert.strictEqual((await sync.sweep()).uploaded, 1);
});

test('renaming a user keeps the SharePoint folder; a new user gets their own folder automatically', async () => {
  const { calls, db, sync, put } = setup({ 7: 'kusuma', 8: 'budi' });
  put('7/Finance/a.csv');
  await sync.sweep();
  db.state.users[7] = 'kusuma-renamed';
  put('7/Finance/b.csv'); put('8/ORN/c.csv');
  await sync.sweep();
  assert.deepStrictEqual(calls.sort(), ['Report Output/budi/ORN/c.csv', 'Report Output/kusuma/Finance/a.csv', 'Report Output/kusuma/Finance/b.csv']);
});

test('two users whose names clean to the same folder do not share it', async () => {
  const { calls, sync, put } = setup({ 1: 'a:b', 2: 'a?b' });
  put('1/x.csv'); put('2/x.csv');
  await sync.sweep();
  assert.deepStrictEqual(calls.sort(), ['Report Output/a_b (2)/x.csv', 'Report Output/a_b/x.csv']);
});

test('a failed file is retried on the next sweep; a permission error stops the pass', async () => {
  const { dir, db, put } = setup({ 7: 'kusuma' });
  let fail = true; const sent = [];
  const graph = { uploadFile: async (segs) => { if (fail) throw Object.assign(new Error('boom'), { status: 500 }); sent.push(segs.join('/')); } };
  const sync = createSharePointSync({ db, graph, outputDir: dir, log: quiet });
  put('7/a.csv'); put('7/b.csv');
  assert.deepStrictEqual(await sync.sweep(), { uploaded: 0, failed: 2 });
  fail = false;
  assert.strictEqual((await sync.sweep()).uploaded, 2);
  const denied = createSharePointSync({ db: fakeDb({ 7: 'k' }), graph: { uploadFile: async () => { throw Object.assign(new Error('no'), { fatal: true, status: 403 }); } }, outputDir: dir, log: quiet });
  assert.strictEqual((await denied.sweep()).failed, 1, 'stopped after the first fatal error');
});

test('cleanSegment removes characters SharePoint refuses', () => {
  assert.strictEqual(cleanSegment('Daily: A/B? #1 100%'), 'Daily_ A_B_ _1 100_');
  assert.strictEqual(cleanSegment('report.'), 'report');
  assert.strictEqual(cleanSegment('~$tmp'), '_~$tmp');
});

function fakeFetch(log, { failFirstPut = false } = {}) {
  let puts = 0;
  return async (url, opts = {}) => {
    const res = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });
    log.push({ url: String(url), method: opts.method, headers: opts.headers, len: opts.body && opts.body.length });
    if (/oauth2\/v2\.0\/token/.test(url)) return res(200, { access_token: 'T', expires_in: 3600 });
    if (/createUploadSession/.test(url)) return res(200, { uploadUrl: 'https://upload.example/session1' });
    if (/upload\.example/.test(url)) return res(202, {});
    if (failFirstPut && puts++ === 0) return res(429, {}, { 'retry-after': '0' });
    return res(201, {});
  };
}

test('graph client: small file = one PUT with a safely encoded path; replace on conflict', async () => {
  const log = []; const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 'a.csv'); fs.writeFileSync(f, 'hello');
  const g = createGraphClient({ tenantId: 't', clientId: 'c', clientSecret: 's', driveId: 'b!abc', fetchImpl: fakeFetch(log, { failFirstPut: true }), sleepImpl: async () => {} });
  await g.uploadFile(['Report Output', 'kusuma', 'My Folder', 'a b.csv'], f);
  const puts = log.filter((l) => l.method === 'PUT');
  assert.strictEqual(puts.length, 2, 'retried after 429');
  assert.match(puts[1].url, /drives\/b!abc\/root:\/Report%20Output\/kusuma\/My%20Folder\/a%20b\.csv:\/content\?@microsoft\.graph\.conflictBehavior=replace/);
  assert.strictEqual(puts[1].headers.Authorization, 'Bearer T');
});

test('graph client: big file uses an upload session in 320 KiB-multiple chunks, without the bearer token on the session URL', async () => {
  const log = []; const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 'big.xlsx');
  fs.writeFileSync(f, Buffer.alloc(CHUNK * 2 + 100));
  const g = createGraphClient({ tenantId: 't', clientId: 'c', clientSecret: 's', driveId: 'd', fetchImpl: fakeFetch(log) });
  await g.uploadFile(['x', 'big.xlsx'], f);
  const chunks = log.filter((l) => /upload\.example/.test(l.url));
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(CHUNK % (320 * 1024), 0);
  assert.strictEqual(chunks[2].headers['Content-Range'], `bytes ${CHUNK * 2}-${CHUNK * 2 + 99}/${CHUNK * 2 + 100}`);
  assert.ok(chunks.every((c) => !c.headers.Authorization));
});

test('config: SharePoint is off unless all four settings are present; a half-filled set is an error', () => {
  const base = { SESSION_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'a'.repeat(64), APP_DB_USER: 'u', APP_DB_PASSWORD: 'p' };
  assert.strictEqual(load(base).sharepoint.enabled, false);
  assert.deepStrictEqual(validate(load(base)), []);
  const full = { ...base, GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', SHAREPOINT_DRIVE_ID: 'd' };
  assert.strictEqual(load(full).sharepoint.enabled, true);
  assert.match(validate(load({ ...base, GRAPH_CLIENT_SECRET: 's' }))[0], /SharePoint push needs all/);
});

test('tcprofile folder goes to <dest>/tcprofile/ and a replaced file is uploaded again', async () => {
  const { calls, sync, put } = setup({});
  put('tcprofile/tcProfile_new.xlsx', 'v1'); put('tcprofile/.tcProfile_new.xlsx.1.tmp', 'half');
  assert.strictEqual((await sync.sweep()).uploaded, 1);
  assert.deepStrictEqual(calls, ['Report Output/tcprofile/tcProfile_new.xlsx']);
  assert.strictEqual((await sync.sweep()).uploaded, 0);
  put('tcprofile/tcProfile_new.xlsx', 'version two');
  assert.strictEqual((await sync.sweep()).uploaded, 1);
});
