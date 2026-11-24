'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRunner, createTcProfileScheduler } = require('../src/tcprofile/runner');
const { createTcProfileService, cleanSchedule } = require('../src/tcprofile/service');
const { download } = require('../src/tcprofile/fetch');

const quiet = { error() {}, log() {} };

function fakeDb() {
  const runs = [];
  const cfg = { enabled: 1, schedule: '{"type":"daily","time":"06:00"}', next_run_at: new Date(2026, 10, 24, 6, 0) };
  return {
    runs, cfg,
    one: async (sql) => (/FROM tcprofile_config/.test(sql) ? cfg : { m: runs.length }),
    query: async (sql, p) => {
      if (/INSERT INTO tcprofile_runs/.test(sql)) { runs.push({ id: runs.length + 1, status: 'running' }); return Object.assign([], { insertId: runs.length }); }
      if (/UPDATE tcprofile_runs SET finished_at/.test(sql)) { Object.assign(runs[p.id - 1], { status: p.s, summary: p.sum, size: p.size }); return []; }
      if (/UPDATE tcprofile_config SET next_run_at/.test(sql)) { const ok = cfg.next_run_at === p.old; if (ok) cfg.next_run_at = p.next; return Object.assign([], { affectedRows: ok ? 1 : 0 }); }
      return Object.assign([], { affectedRows: 1 });
    },
  };
}

const xlsx = (tmp) => { fs.writeFileSync(tmp, Buffer.concat([Buffer.from('PK'), Buffer.alloc(100)])); return 102; };

test('run replaces the old file but keeps the name; a bad download keeps the old file', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const db = fakeDb();
  let saved = 0, urlSeen = '';
  let fetchFile = async (url, key, tmp) => { urlSeen = url + '|' + key; return xlsx(tmp); };
  const r = createRunner({ db, outputDir: out, alvis: { apiKey: 'k', baseUrl: 'https://x/api/' }, now: () => new Date(2026, 10, 24), fetchFile: (...a) => fetchFile(...a), onFileSaved: () => saved++, log: quiet });
  const f = path.join(out, 'tcprofile', 'tcProfile_new.xlsx');
  assert.equal((await (await r.start('manual')).done).ok, true);
  assert.equal(urlSeen, 'https://x/api/service-performance/tc-profile/export?year=2026|k');
  assert.equal(fs.statSync(f).size, 102);
  assert.equal(saved, 1);
  // second run with different content replaces it
  fetchFile = async (url, key, tmp) => { fs.writeFileSync(tmp, Buffer.concat([Buffer.from('PK'), Buffer.alloc(500)])); return 502; };
  await (await r.start('schedule')).done;
  assert.equal(fs.statSync(f).size, 502);
  // not an xlsx: old file stays, no temp files left
  fetchFile = async (url, key, tmp) => { fs.writeFileSync(tmp, '<html>'); return 6; };
  const res = await (await r.start('manual')).done;
  assert.equal(res.ok, false);
  assert.equal(fs.statSync(f).size, 502);
  assert.deepEqual(fs.readdirSync(path.join(out, 'tcprofile')), ['tcProfile_new.xlsx']);
  assert.equal(db.runs[2].status, 'error');
  assert.equal(saved, 2);
});

test('missing API key fails plainly; only one run at a time', async () => {
  const db = fakeDb();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const r = createRunner({ db, outputDir: out, alvis: { apiKey: '', baseUrl: 'https://x' }, log: quiet });
  const a = await r.start('manual');
  await assert.rejects(() => r.start('manual'), (e) => e.status === 409);
  assert.match((await a.done).summary, /ALVIS_API_KEY/);
});

test('scheduler runs a due job once and moves next_run_at forward', async () => {
  const db = fakeDb();
  let n = 0;
  const runner = { busy: null, start: async () => { n++; return { done: Promise.resolve() }; } };
  const t = new Date(2026, 10, 24, 6, 1);
  const s = createTcProfileScheduler({ db, runner, now: () => t, log: quiet });
  assert.equal(await s.tick(), 1);
  assert.equal(await s.tick(), 0);
  assert.equal(n, 1);
  assert.equal(db.cfg.next_run_at.getTime(), new Date(2026, 10, 25, 6, 0).getTime());
});

test('schedule: only daily and monthly, monthly needs dates', () => {
  assert.deepEqual(cleanSchedule({ type: 'daily', time: '07:30' }), { type: 'daily', time: '07:30' });
  assert.deepEqual(cleanSchedule({ type: 'monthly', time: '07:30', days: [15, 1] }), { type: 'monthly', time: '07:30', days: [1, 15] });
  assert.throws(() => cleanSchedule({ type: 'weekly', time: '07:30', days: [1] }));
  assert.throws(() => cleanSchedule({ type: 'monthly', time: '07:30', days: [] }));
  assert.throws(() => cleanSchedule({ type: 'monthly', time: '07:30', days: [32] }));
});

test('service.save stores the schedule and next run', async () => {
  const sets = [];
  const row = { enabled: 1, schedule: '{"type":"monthly","time":"08:00","days":[5]}', next_run_at: null };
  const db = { one: async () => row, query: async (sql, p) => { sets.push(p); return []; } };
  const svc = createTcProfileService({ db, now: () => new Date(2026, 10, 24, 9, 0) });
  await svc.save({ enabled: true, schedule: { type: 'monthly', time: '08:00', days: [5] } });
  assert.equal(sets[0].n.getTime(), new Date(2026, 11, 5, 8, 0).getTime());
});

test('download sends the key header, follows nothing on 401 and reports it', async () => {
  let seen = '';
  const srv = http.createServer((req, res) => {
    seen = req.headers['x-api-key'];
    if (seen !== 'good') { res.statusCode = 401; return res.end('no'); }
    res.end(Buffer.from('PKdata'));
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/e`;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')), 'f');
  await assert.rejects(() => download(base, 'bad', tmp), /401/);
  assert.equal(await download(base, 'good', tmp), 6);
  srv.close();
});
