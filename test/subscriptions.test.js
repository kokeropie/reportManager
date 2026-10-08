'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, nextRun, describe } = require('../src/subscriptions/schedule');
const { cleanFolder, resolveUnder, cleanParams } = require('../src/subscriptions/service');
const { createScheduler, writeFile } = require('../src/subscriptions/scheduler');
const { defaultValues, withDefaults, resolveParams } = require('../src/rdl/engine');
const { wallToday } = require('../src/rdl/expressions');

const L = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test('daily: next run is today if still ahead, else tomorrow', () => {
  assert.deepStrictEqual(nextRun({ type: 'daily', time: '08:00' }, L(2026, 10, 8, 7, 0)), L(2026, 10, 8, 8, 0));
  assert.deepStrictEqual(nextRun({ type: 'daily', time: '08:00' }, L(2026, 10, 8, 8, 0)), L(2026, 10, 9, 8, 0));
});

test('weekly: picks the next chosen weekday', () => {
  // 2026-10-08 is a Thursday (4). Mon+Fri -> Friday the 9th.
  assert.deepStrictEqual(nextRun({ type: 'weekly', time: '06:30', days: [1, 5] }, L(2026, 10, 8, 12)), L(2026, 10, 9, 6, 30));
  assert.deepStrictEqual(nextRun({ type: 'weekly', time: '06:30', days: [4] }, L(2026, 10, 8, 12)), L(2026, 10, 15, 6, 30));
});

test('monthly: day 31 falls back to the last day of a short month', () => {
  assert.deepStrictEqual(nextRun({ type: 'monthly', time: '01:00', day: 31 }, L(2026, 4, 1)), L(2026, 4, 30, 1, 0));
  assert.deepStrictEqual(nextRun({ type: 'monthly', time: '01:00', day: 1 }, L(2026, 12, 15)), L(2027, 1, 1, 1, 0));
});

test('interval: minimum 15 minutes, counted from the last time', () => {
  assert.deepStrictEqual(nextRun({ type: 'interval', everyMinutes: 60 }, L(2026, 10, 8, 10)), L(2026, 10, 8, 11));
  assert.throws(() => normalize({ type: 'interval', everyMinutes: 5 }), /between 15/);
  assert.match(describe({ type: 'interval', everyMinutes: 120 }), /2 hour/);
});

test('schedule validation', () => {
  assert.throws(() => normalize({ type: 'daily', time: '25:00' }), /HH:MM/);
  assert.throws(() => normalize({ type: 'weekly', time: '08:00', days: [] }), /weekday/);
  assert.throws(() => normalize({ type: 'yearly' }), /Schedule type/);
});

test('folder names cannot escape the user root', () => {
  assert.strictEqual(cleanFolder(''), '');
  assert.strictEqual(cleanFolder('Finance\\Daily/ Reports '), 'Finance/Daily/Reports');
  for (const bad of ['..', '../x', 'a/../b', 'C:', 'a:b', 'con', 'x.', '/etc/passwd/..']) assert.throws(() => cleanFolder(bad), /not allowed/, bad);
  assert.strictEqual(resolveUnder('/srv/out/5', '../6/x'), null);
  assert.ok(resolveUnder('/srv/out/5', 'a/b.csv'));
});

test('blank params are dropped so the report default applies at run time', () => {
  assert.deepStrictEqual(cleanParams({ a: '', b: null, c: 'x', d: 3, e: false }), { c: 'x', d: 3, e: false });
  assert.throws(() => cleanParams({ a: { x: 1 } }), /invalid/);
});

// ---- date defaults ----
const dp = (name, extra = {}) => ({ name, prompt: name, type: 'DateTime', nullable: false, ...extra });
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => wallToday();
const yesterday = () => new Date(today().getTime() - 86400000);

test('blank start/end dates default to yesterday / today by name', () => {
  const v = defaultValues({ parameters: [dp('startdate'), dp('enddate')] });
  assert.strictEqual(v.startdate, iso(yesterday()));
  assert.strictEqual(v.enddate, iso(today()));
  const w = defaultValues({ parameters: [dp('EndDate'), dp('FromDate')] });
  assert.strictEqual(w.FromDate, iso(yesterday()));
  assert.strictEqual(w.EndDate, iso(today()));
});

test('Parameter1/Parameter2 (no telling names) become yesterday then today', () => {
  const v = defaultValues({ parameters: [dp('Parameter1'), dp('Parameter2')] });
  assert.strictEqual(v.Parameter1, iso(yesterday()));
  assert.strictEqual(v.Parameter2, iso(today()));
});

test('defaults from the RDL are never overridden; nullable and non-date params untouched', () => {
  const { compile } = require('../src/rdl/expressions');
  const withRdl = dp('startdate', { defaultCompiled: compile('=DateAdd("d",-7,Today())') });
  const v = defaultValues({ parameters: [withRdl, dp('enddate'), dp('opt', { nullable: true }), { name: 'client', prompt: 'c', type: 'String', nullable: false }] });
  assert.strictEqual(v.startdate, iso(new Date(today().getTime() - 7 * 86400000)));
  assert.strictEqual(v.enddate, iso(today()));
  assert.strictEqual(v.opt, null);
  assert.strictEqual(v.client, null);
});

test('withDefaults fills only what was left blank', () => {
  const def = { parameters: [dp('startdate'), dp('enddate')] };
  const out = withDefaults(def, { startdate: '2026-01-01', enddate: '' });
  assert.strictEqual(out.startdate, '2026-01-01');
  assert.strictEqual(out.enddate, iso(today()));
  assert.deepStrictEqual(resolveParams(def, withDefaults(def, {})).errors, []);
});

// ---- files + scheduler ----
const grid = {
  columns: [{ width: 1, name: 'A' }, { width: 1, name: 'B' }],
  rowCount: 1,
  rows: [
    { kind: 'header', cells: [{ value: 'A' }, { value: 'B' }] },
    { kind: 'detail', cells: [{ value: 'x' }, { value: 5 }] },
  ],
};

test('writeFile produces a complete csv and xlsx, with no .tmp left', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const csv = path.join(dir, 'a', 'r.csv');
  const xlsx = path.join(dir, 'a', 'r.xlsx');
  await writeFile(csv, 'csv', { grid, reportName: 'R' });
  const size = await writeFile(xlsx, 'xlsx', { grid, reportName: 'R' });
  assert.strictEqual(fs.readFileSync(csv, 'utf8'), '﻿A,B\r\nx,5\r\n');
  assert.ok(size > 1000);
  assert.strictEqual(fs.readFileSync(xlsx).slice(0, 2).toString(), 'PK');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a')).sort(), ['r.csv', 'r.xlsx']);
});

function fakeDb(sub) {
  const state = { sub: { ...sub }, runs: [], claims: 0 };
  const db = {
    state,
    query: async (sql, p) => {
      if (/FROM subscriptions s/.test(sql)) return state.sub.enabled && state.sub.next_run_at <= p.now ? [{ ...state.sub }] : [];
      if (/INSERT INTO subscription_runs/.test(sql)) { state.runs.push(p); return []; }
      if (/UPDATE subscriptions SET last_run_at/.test(sql)) {
        state.sub.last_status = p.status;
        if (p.failed) { state.sub.failures++; if (state.sub.failures >= 5) state.sub.enabled = 0; } else state.sub.failures = 0;
        return [];
      }
      if (/UPDATE subscriptions SET enabled = 0/.test(sql)) { state.sub.enabled = 0; return []; }
      if (/FROM subscription_runs WHERE started_at/.test(sql)) return [];
      throw new Error('unexpected SQL ' + sql);
    },
    one: async (sql, p) => {
      if (/OUTPUT INSERTED.id/.test(sql) && /UPDATE subscriptions SET next_run_at/.test(sql)) {
        if (+state.sub.next_run_at !== +p.old) return null;
        state.sub.next_run_at = p.next; state.claims++; return { id: p.id };
      }
      throw new Error('unexpected SQL ' + sql);
    },
  };
  return db;
}

const baseSub = (over = {}) => ({
  id: 1, user_id: 7, report_id: 3, name: 'Daily PJTI', params: '{}', format: 'csv', schedule: JSON.stringify({ type: 'daily', time: '06:00' }),
  folder: 'Finance/Daily', enabled: 1, next_run_at: L(2026, 10, 8, 6, 0), failures: 0,
  report_name: 'PJTI', username: 'kusuma', role: 'viewer', user_disabled: 0, folder_is_system: 0, ...over,
});
const quiet = { error() {} };

test('tick runs a due subscription once, saves the file under the user\'s own folder, schedules tomorrow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const db = fakeDb(baseSub());
  const seen = [];
  const runs = { exportData: async (id, params, opts) => { seen.push({ id, params, opts }); return { reportName: 'PJTI', grid }; } };
  const audit = { log: async (e) => seen.push(e) };
  const t = L(2026, 10, 8, 6, 0, 5);
  const s = createScheduler({ db, runs, audit, outputDir: dir, now: () => t, log: quiet });
  assert.strictEqual(await s.tick(), 1);
  assert.strictEqual(await s.tick(), 0, 'already claimed, nothing due');
  assert.deepStrictEqual(db.state.sub.next_run_at, L(2026, 10, 9, 6, 0));
  assert.strictEqual(seen[0].opts.fillBlanks, true);
  const files = fs.readdirSync(path.join(dir, '7', 'Finance', 'Daily'));
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^Daily PJTI \d{8}-\d{6}\.csv$/);
  assert.strictEqual(db.state.runs[0].status, 'ok');
  assert.strictEqual(db.state.runs[0].file, 'Finance/Daily/' + files[0]);
  assert.strictEqual(seen.find((e) => e.action === 'scheduled-run').username, 'kusuma');
});

test('a failing run is recorded, and 5 failures in a row pause the subscription', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const db = fakeDb(baseSub());
  const runs = { exportData: async () => { throw Object.assign(new Error('Could not connect'), { detail: 'ELOGIN' }); } };
  let t = L(2026, 10, 8, 6, 0, 1);
  const s = createScheduler({ db, runs, audit: { log: async () => {} }, outputDir: dir, now: () => t, log: quiet });
  for (let i = 0; i < 5; i++) { await s.tick(); t = new Date(t.getTime() + 86400000); }
  assert.strictEqual(db.state.runs.length, 5);
  assert.match(db.state.runs[0].error, /Could not connect \(ELOGIN\)/);
  assert.strictEqual(db.state.sub.enabled, 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a disabled owner or a lost folder right stops the run and pauses it, without querying', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  let queried = 0;
  const runs = { exportData: async () => { queried++; return { reportName: 'x', grid }; } };
  for (const over of [{ user_disabled: 1 }, { folder_is_system: 1 }]) {
    const db = fakeDb(baseSub(over));
    await createScheduler({ db, runs, audit: { log: async () => {} }, outputDir: dir, now: () => L(2026, 10, 8, 7), log: quiet }).tick();
    assert.strictEqual(db.state.sub.enabled, 0);
  }
  assert.strictEqual(queried, 0);
});

test('service: create validates, scopes to the owner, hides the Connection folder from viewers', async () => {
  const { createSubscriptionService } = require('../src/subscriptions/service');
  const { compile } = require('../src/rdl/expressions');
  const def = { parameters: [dp('startdate'), dp('enddate')] };
  const rows = [];
  const db = {
    one: async (sql, p) => {
      if (/FROM reports r JOIN folders/.test(sql)) return p.id === 9 ? { id: 9, name: 'Secret', is_system: 1 } : { id: 3, name: 'PJTI', is_system: 0 };
      if (/INSERT INTO subscriptions/.test(sql)) { rows.push({ ...p, id: 11, report_name: 'PJTI', report_id: p.reportId, user_id: p.userId, enabled: 1, params: p.params, schedule: p.schedule, folder: p.folder }); return { id: 11 }; }
      if (/WHERE s.id = @id AND s.user_id/.test(sql)) return p.userId === 5 ? rows[0] : null;
      throw new Error('unexpected ' + sql);
    },
    query: async () => [],
  };
  const reports = { getRow: async () => ({}), loadDef: async () => def };
  const svc = createSubscriptionService({ db, reports, outputDir: '/tmp/x', now: () => L(2026, 10, 8, 7) });
  const viewer = { id: 5, role: 'viewer' };
  const sub = await svc.create(viewer, { reportId: 3, format: 'xlsx', schedule: { type: 'daily', time: '08:00' }, folder: 'Finance/Daily', params: { startdate: '' } });
  assert.strictEqual(sub.name, 'PJTI');
  assert.strictEqual(sub.scheduleText, 'Every day at 08:00');
  assert.deepStrictEqual(rows[0].next, L(2026, 10, 8, 8, 0));
  assert.strictEqual(rows[0].params, '{}');
  await assert.rejects(svc.create(viewer, { reportId: 9, format: 'csv', schedule: { type: 'daily', time: '08:00' } }), /Not found/);
  await assert.rejects(svc.create(viewer, { reportId: 3, format: 'pdf', schedule: { type: 'daily', time: '08:00' } }), /Format/);
  await assert.rejects(svc.create(viewer, { reportId: 3, format: 'csv', schedule: { type: 'daily', time: '08:00' }, folder: '../..' }), /not allowed/);
  await assert.rejects(svc.update({ id: 6, role: 'viewer' }, 11, { enabled: false }), /Not found/);
});

test('nextDelay sleeps until the earliest run, within 1 second and 5 minutes', async () => {
  const t = L(2026, 10, 8, 6, 0, 0);
  const mk = (next) => createScheduler({ db: { one: async () => ({ t: next }) }, runs: {}, audit: {}, outputDir: '/x', now: () => t, log: quiet });
  assert.strictEqual(await mk(new Date(t.getTime() + 90000)).nextDelay(), 90000);
  assert.strictEqual(await mk(new Date(t.getTime() + 3600000)).nextDelay(), 300000, 'capped');
  assert.strictEqual(await mk(new Date(t.getTime() - 5000)).nextDelay(), 1000, 'overdue: look again in a second');
  assert.strictEqual(await mk(null).nextDelay(), 300000, 'nothing scheduled');
  const broken = createScheduler({ db: { one: async () => { throw new Error('down'); } }, runs: {}, audit: {}, outputDir: '/x', now: () => t, log: quiet });
  assert.strictEqual(await broken.nextDelay(), 300000, 'db error: fall back to the cap');
});

test('start/wake/stop leave no timer running', async () => {
  const s = createScheduler({ db: { one: async () => null, query: async () => [] }, runs: {}, audit: {}, outputDir: '/x', log: quiet });
  s.start(); s.wake(); s.wake(); s.stop(); s.wake();
});

test('service: update changes schedule, params and folder, keeps ownership, wakes the scheduler', async () => {
  const { createSubscriptionService } = require('../src/subscriptions/service');
  const def = { parameters: [dp('startdate'), dp('enddate')] };
  let row = { id: 11, user_id: 5, report_id: 3, report_name: 'PJTI', name: 'Old', params: '{}', format: 'csv',
    schedule: JSON.stringify({ type: 'daily', time: '08:00' }), folder: '', enabled: 1, failures: 3 };
  let updated = null;
  let woke = 0;
  const db = {
    one: async (sql, p) => {
      if (/FROM reports r JOIN folders/.test(sql)) return { id: 3, name: 'PJTI', is_system: 0 };
      if (/WHERE s.id = @id AND s.user_id/.test(sql)) return p.userId === 5 ? row : null;
      throw new Error('unexpected ' + sql);
    },
    query: async (sql, p) => {
      if (/^\s*UPDATE subscriptions SET name/.test(sql)) {
        updated = p;
        row = { ...row, name: p.name, params: p.params, format: p.format, schedule: p.schedule, folder: p.folder, enabled: p.enabled ? 1 : 0, next_run_at: p.next };
        return [];
      }
      throw new Error('unexpected ' + sql);
    },
  };
  const svc = createSubscriptionService({ db, reports: { getRow: async () => ({}), loadDef: async () => def }, outputDir: '/tmp/x', now: () => L(2026, 10, 8, 7), onChange: () => woke++ });
  const out = await svc.update({ id: 5, role: 'viewer' }, 11, {
    name: 'New', format: 'xlsx', folder: 'Finance/Weekly', params: { startdate: '2026-01-01', enddate: '' },
    schedule: { type: 'weekly', time: '09:30', days: [1] },
  });
  assert.strictEqual(out.name, 'New');
  assert.strictEqual(out.scheduleText, 'Every Mon at 09:30');
  assert.deepStrictEqual(JSON.parse(updated.params), { startdate: '2026-01-01' });
  assert.deepStrictEqual(updated.next, L(2026, 10, 12, 9, 30)); // next Monday
  assert.strictEqual(updated.folder, 'Finance/Weekly');
  assert.strictEqual(updated.userId, 5);
  assert.strictEqual(woke, 1);
  // a partial edit keeps everything else
  await svc.update({ id: 5, role: 'viewer' }, 11, { name: 'Renamed' });
  assert.strictEqual(row.format, 'xlsx');
  assert.strictEqual(row.folder, 'Finance/Weekly');
  // a bad schedule is refused and nothing is saved
  updated = null;
  await assert.rejects(svc.update({ id: 5, role: 'viewer' }, 11, { schedule: { type: 'interval', everyMinutes: 1 } }), /between 15/);
  assert.strictEqual(updated, null);
});
