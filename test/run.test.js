'use strict';
// Binding and run pipeline, with a fake database executor (no SQL Server or MySQL needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRdl } = require('../src/rdl/parser');
const { resolveParams } = require('../src/rdl/engine');
const { buildBinding } = require('../src/runner/binding');
const { createRunService, explain } = require('../src/reports/runService');
const { Limiter } = require('../src/runner/limiter');
const { RunStore } = require('../src/runner/runStore');
const T = fs.existsSync(require('path').join(__dirname, '..', 'sampleReport')) ? test : (name, fn) => test(name, { skip: 'sampleReport/ is not in the repo (kept private)' }, fn);

const DIR = path.join(__dirname, '..', 'sampleReport');
const load = (f) => parseRdl(fs.readFileSync(path.join(DIR, f), 'utf8'));
const NOW = new Date();

T('MSSQL: named parameters bound with the SQL text spelling and RDL types (FR-18)', () => {
  const def = load('Corporate Billing_All v2.rdl');
  const { values } = resolveParams(def, { startdate: '2026-01-01', enddate: '2026-01-31', clientName: "x'; DROP TABLE t;--" });
  const b = buildBinding(def, values, 'mssql', NOW);
  assert.strictEqual(b.sql, def.dataset.commandText, 'SQL is sent exactly as written');
  assert.deepStrictEqual(b.named.map((p) => [p.name, p.type]), [['startdate', 'DateTime'], ['enddate', 'DateTime'], ['clientName', 'String']]);
  assert.strictEqual(b.named[2].value, "x'; DROP TABLE t;--", 'user input is a bound value, never in the SQL');
  assert.ok(!b.sql.includes('DROP TABLE'));
});

T('MySQL: positional ? parameters bound in RDL order (FR-31)', () => {
  const def = load('Billing List - Arjuna (autoDate H-1).rdl');
  const { values } = resolveParams(def, { Parameter1: '2026-02-01', Parameter2: '2026-02-02' });
  const b = buildBinding(def, values, 'mysql', NOW);
  assert.deepStrictEqual(b.values.map((d) => d.toISOString().slice(0, 10)), ['2026-02-01', '2026-02-02']);
  assert.throws(() => buildBinding(def, values, 'mssql', NOW), /MySQL/);
});

T('MySQL: named @params are converted to ? in order of appearance (FR-18)', () => {
  const def = load('Invoice List - PJTI (autoDate).rdl');
  def.dataset.commandText = "SELECT '@startDate' AS lit, a FROM t WHERE d >= @startDate AND d < @endDate AND e > @startDate";
  const { values } = resolveParams(def, { startDate: '2026-01-01', endDate: '2026-01-05' });
  const b = buildBinding(def, values, 'mysql', NOW);
  assert.strictEqual(b.sql, "SELECT '@startDate' AS lit, a FROM t WHERE d >= ? AND d < ? AND e > ?");
  assert.deepStrictEqual(b.values.map((d) => d.getUTCDate()), [1, 5, 1]);
});

T('parameter validation is generated from the RDL (FR-16a)', () => {
  const def = load('Corporate Billing_All v2.rdl');
  assert.ok(resolveParams(def, {}).errors.length >= 2);
  assert.match(resolveParams(def, { startdate: 'tomorrow', enddate: '2026-01-02', clientName: 'x' }).errors[0], /date/);
  assert.deepStrictEqual(resolveParams(def, { startdate: '2026-01-01', enddate: '2026-01-02', clientName: 'x' }).errors, []);
});

function fixture({ rows, configured = true, fail } = {}) {
  const def = load('Invoice List - PJTI (autoDate).rdl');
  const row = { id: 7, name: 'PJTI', connection_id: configured ? 3 : null, updated_at: new Date(), warnings: '[]', datasource_name: 'PTES_SVRINS02', folder_id: 1, folder_name: 'Finance' };
  const reports = { getRow: async () => row, loadDef: async () => def, publicReport: () => ({ id: 7, name: 'PJTI' }) };
  const connections = { getWithSecret: async () => ({ id: 3, type: 'mssql', updatedAt: '1' }) };
  const calls = [];
  const execute = async (entry, binding, opts) => {
    calls.push({ binding, opts });
    if (fail) throw fail;
    return { rows: rows || [], truncated: false };
  };
  const cfg = { maxRows: 100000, queryTimeoutSeconds: 120, pageSize: 10 };
  const svc = createRunService({ reports, connections, pools: { get: async () => ({}) }, execute, limiter: new Limiter(2), runStore: new RunStore(), cfg });
  return { svc, calls, def };
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({ Divisi: 'D' + i, InvoiceID: 'I' + i, ClientName: 'C', DateOfCreated: new Date(Date.UTC(2026, 0, 1)), ORGAMT: i }));
const P = { startDate: '2026-01-01', endDate: '2026-01-02' };

T('run: pages rows, keeps header on every page, footer only on the last (FR-20)', async () => {
  const { svc, calls } = fixture({ rows: mk(25) });
  const r = await svc.run(7, P, { userId: 1 });
  assert.strictEqual(r.totalRows, 25);
  assert.strictEqual(r.totalPages, 3);
  assert.strictEqual(r.rows.length, 10);
  assert.strictEqual(r.header.length, 1);
  assert.strictEqual(r.rows[0].cells[0].text, 'D0');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.timeoutMs, 120000);
  const p3 = svc.page(r.runId, 1, 3, 10);
  assert.strictEqual(p3.rows.length, 5);
  assert.strictEqual(calls.length, 1, 'paging does not re-run the query');
  assert.throws(() => svc.page(r.runId, 999, 1, 10), /expired/);
});

T('run: report with no connection says so (FR-11)', async () => {
  const { svc } = fixture({ configured: false });
  await assert.rejects(svc.run(7, P, { userId: 1 }), /Not configured, contact an administrator/);
});

T('run: bad parameters are reported before touching the database', async () => {
  const { svc, calls } = fixture();
  await assert.rejects(svc.run(7, { startDate: 'nope', endDate: '2026-01-02' }, { userId: 1 }), /startDate|start Date/i);
  assert.strictEqual(calls.length, 0);
});

T('run: driver errors become plain language with detail (FR-21, AC-6)', async () => {
  const { svc } = fixture({ fail: Object.assign(new Error('Login failed for user "x"'), { code: 'ELOGIN' }) });
  await assert.rejects(svc.run(7, P, { userId: 1 }), (e) => e.status === 502 && /Could not connect/.test(e.message) && /Login failed/.test(e.detail));
  const t = explain(Object.assign(new Error('Timeout: Request failed to complete in 120000ms'), { code: 'ETIMEOUT' }), { queryTimeoutSeconds: 120 });
  assert.match(t.message, /longer than 120 seconds/);
  assert.match(explain(new Error('Invalid column name Foo'), { queryTimeoutSeconds: 1 }).message, /The query failed/);
});

T('limiter never exceeds its cap', async () => {
  const lim = new Limiter(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => lim.run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  })));
  assert.strictEqual(peak, 2);
});
