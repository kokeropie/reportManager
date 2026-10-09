'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const { writeCsv, csvText, BOM } = require('../src/export/csv');
const { writeXlsx, excelNumFmt } = require('../src/export/xlsx');
const { parseRdl } = require('../src/rdl/parser');
const { renderGrid, resolveParams } = require('../src/rdl/engine');
const { createAuditService } = require('../src/audit/service');
const { createRunService } = require('../src/reports/runService');
const { Limiter } = require('../src/runner/limiter');
const { RunStore } = require('../src/runner/runStore');
const T = fs.existsSync(require('path').join(__dirname, '..', 'sampleReport')) ? test : (name, fn) => test(name, { skip: 'sampleReport/ is not in the repo (kept private)' }, fn);

const D = (y, m, d, h = 0) => new Date(Date.UTC(y, m - 1, d, h));
const collect = (stream) => new Promise((resolve) => { const b = []; stream.on('data', (c) => b.push(c)); stream.on('end', () => resolve(Buffer.concat(b))); });

const grid = {
  columns: [{ width: 1, name: 'Name' }, { width: 1, name: 'Amount' }, { width: 1, name: 'Date' }],
  rowCount: 2,
  rows: [
    { kind: 'header', cells: [{ value: 'Name' }, { value: 'Amount' }, { value: 'Date' }] },
    { kind: 'detail', cells: [{ value: 'Smith, "Bob"\nJr' }, { value: 1234.5 }, { value: D(2026, 3, 5) }] },
    { kind: 'detail', cells: [{ value: '=HYPERLINK("x")' }, { value: null }, { value: D(2026, 3, 5, 14) }] },
    { kind: 'footer', cells: [{ value: 'Total', span: 2 }, { value: 1234.5, format: '#,##0.00' }] },
  ],
};

test('CSV: UTF-8 BOM, quoting, header from the RDL, formula neutralised (FR-22)', async () => {
  const s = new PassThrough();
  const done = collect(s);
  await writeCsv(s, grid);
  const text = (await done).toString('utf8');
  assert.ok(text.startsWith(BOM));
  const lines = text.slice(1).split('\r\n');
  assert.strictEqual(lines[0], 'Name,Amount,Date');
  assert.ok(text.includes('"Smith, ""Bob""\nJr",1234.5,2026-03-05'));
  assert.ok(text.includes('"\'=HYPERLINK(""x"")",,2026-03-05 14:00:00'), 'text starting with = is neutralised');
  assert.ok(text.includes('Total,,1,234.50') || text.includes('Total,,"1,234.50"'), 'colspan keeps columns aligned, RDL format applied');
});

test('CSV: negative numbers are not mangled, negative-looking text is', () => {
  assert.strictEqual(csvText({ value: -5 }), '-5');
  assert.strictEqual(csvText({ value: '-5' }), '-5');
  assert.strictEqual(csvText({ value: '-abc' }), "'-abc");
});

test('XLSX: bold frozen header, real numbers and dates, widths (FR-23, AC-3)', async () => {
  const s = new PassThrough();
  const done = collect(s);
  await writeXlsx(s, grid, { sheetName: 'My/Report: v1' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await done);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.name, 'My Report  v1');
  assert.strictEqual(ws.views[0].state, 'frozen');
  assert.strictEqual(ws.views[0].ySplit, 1);
  assert.strictEqual(ws.getRow(1).getCell(1).font.bold, true);
  assert.strictEqual(ws.getRow(2).getCell(2).value, 1234.5);
  assert.strictEqual(typeof ws.getRow(2).getCell(2).value, 'number');
  const d = ws.getRow(2).getCell(3).value;
  assert.ok(d instanceof Date && d.getUTCFullYear() === 2026 && d.getUTCMonth() === 2 && d.getUTCDate() === 5 && d.getUTCHours() === 0);
  assert.strictEqual(ws.getRow(2).getCell(3).numFmt, 'yyyy-mm-dd');
  assert.strictEqual(ws.getRow(3).getCell(3).numFmt, 'yyyy-mm-dd hh:mm:ss');
  assert.strictEqual(ws.getRow(3).getCell(1).value, "'=HYPERLINK(\"x\")");
  assert.strictEqual(ws.getRow(4).getCell(3).numFmt, '#,##0.00');
  assert.strictEqual(ws.getRow(4).getCell(1).font.bold, true);
  assert.ok(ws.getColumn(1).width >= 8);
});

test('XLSX: title row, thin borders, RDL colours and merged cells like the SSRS Excel render', async () => {
  const g = {
    columns: [{ width: 1 }, { width: 1 }, { width: 1 }],
    heading: ['AR Report'], headingStyle: { size: 18 },
    rows: [
      { kind: 'header', cells: [{ value: 'Name', style: { bg: '365838', color: 'FFFFFF' } }, { value: null, span: 2 }] },
      { kind: 'detail', cells: [{ value: 'A', vspan: 2 }, { value: 'x' }, { value: 5, format: 'N2' }] },
      { kind: 'detail', cells: [{ value: null }, { value: 'y' }, { value: 6, format: 'N2' }] },
    ],
  };
  const s = new PassThrough(); const d = collect(s); await writeXlsx(s, g, { sheetName: 'T' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await d);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getCell('A1').value, 'AR Report');
  assert.strictEqual(ws.getCell('A3').value, 'Name');
  assert.strictEqual(ws.getCell('A3').fill.fgColor.argb, 'FF365838');
  assert.strictEqual(ws.getCell('A3').font.color.argb, 'FFFFFFFF');
  assert.strictEqual(ws.getCell('A3').border.left.style, 'thin');
  assert.strictEqual(ws.getCell('C4').numFmt, '#,##0.00');
  const merged = Object.keys(ws._merges);
  assert.ok(merged.includes('A1') && merged.includes('B3') && merged.includes('A4'), 'title, column span and row-group label are merged');
});

test('number format mapping', () => {
  assert.strictEqual(excelNumFmt('N0'), '#,##0');
  assert.strictEqual(excelNumFmt('P1'), '0.0%');
  assert.strictEqual(excelNumFmt('dd/MM/yyyy HH:mm', true), 'dd/mm/yyyy hh:mm');
  assert.strictEqual(excelNumFmt(null), null);
});

T('XLSX/CSV from a real sample report keep the same rows as the screen grid (AC-3)', async () => {
  const def = parseRdl(fs.readFileSync(path.join(__dirname, '..', 'sampleReport', 'ePRV Data Export (General - Process to) Outstanding.rdl'), 'utf8'));
  const { values } = resolveParams(def, { Parameter1: '2026-01-01', Parameter2: '2026-01-31' });
  const g = renderGrid(def, [{ Status: 'Open', PRVID: 'P1' }, { Status: 'Open', PRVID: 'P2' }, { Status: 'Paid', PRVID: 'P3' }], values);
  const s1 = new PassThrough(); const d1 = collect(s1); await writeCsv(s1, g);
  const csvLines = (await d1).toString('utf8').slice(1).split('\r\n').filter(Boolean);
  const s2 = new PassThrough(); const d2 = collect(s2); await writeXlsx(s2, g, { sheetName: 'x' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await d2);
  assert.strictEqual(csvLines.length, g.rows.length);
  assert.strictEqual(wb.worksheets[0].actualRowCount, g.rows.length + (g.heading.length ? 1 : 0)); // the title row is the extra one
  assert.strictEqual(csvLines[0].split(',').length, def.table.columns.length);
});

test('audit: writes parameters, IP and browser; clips; never throws (FR-26, 26a)', async () => {
  const calls = [];
  const audit = createAuditService({ query: async (sql, p) => { calls.push(p); }, one: async () => ({ n: 0 }) });
  await audit.log({ userId: 2, username: 'viewer', action: 'run', reportId: 7, reportName: 'PJTI', params: { startDate: '2026-01-01' }, rowCount: 3, ip: '10.0.0.9', userAgent: 'U'.repeat(500) });
  assert.strictEqual(calls[0].ip, '10.0.0.9');
  assert.strictEqual(calls[0].ua.length, 300);
  assert.strictEqual(calls[0].params, '{"startDate":"2026-01-01"}');
  assert.strictEqual(calls[0].status, 'ok');
  const broken = createAuditService({ query: async () => { throw new Error('db down'); } });
  const orig = console.error; console.error = () => {};
  await assert.doesNotReject(broken.log({ action: 'run' }));
  console.error = orig;
});

test('audit list builds filters with bound parameters', async () => {
  const seen = [];
  const db = { one: async (sql, p) => { seen.push({ sql, p }); return { n: 250 }; }, query: async (sql, p) => { seen.push({ sql, p }); return []; } };
  const out = await createAuditService(db).list({ page: 2, pageSize: 100, user: "x'; DROP TABLE t;--", from: '2026-01-01', to: '2026-01-31' });
  assert.strictEqual(out.totalPages, 3);
  assert.ok(!seen[0].sql.includes('DROP'), 'filter text is never in the SQL');
  assert.strictEqual(seen[1].p.off, 100);
  assert.strictEqual(seen[0].p.to.getUTCDate(), 1, 'end date is inclusive (next day, exclusive)');
});

function runFixture({ rowCount, truncated }) {
  const def = parseRdl(fs.readFileSync(path.join(__dirname, '..', 'sampleReport', 'Invoice List - PJTI (autoDate).rdl'), 'utf8'));
  const row = { id: 7, name: 'PJTI', connection_id: 3, updated_at: new Date(), warnings: '[]' };
  const seen = {};
  const svc = createRunService({
    reports: { getRow: async () => row, loadDef: async () => def, publicReport: () => ({}) },
    connections: { getWithSecret: async () => ({ id: 3, type: 'mssql', updatedAt: '1' }) },
    pools: { get: async () => ({}) },
    execute: async (e, b, opts) => { seen.opts = opts; return { rows: Array.from({ length: rowCount }, (_, i) => ({ InvoiceID: 'I' + i })), truncated }; },
    limiter: new Limiter(1), runStore: new RunStore(), cfg: { maxRows: 100, exportMaxRows: 500, queryTimeoutSeconds: 5, pageSize: 10 },
  });
  return { svc, seen };
}

T('export uses its own larger cap and runs the query again (FR-24)', async () => {
  const { svc, seen } = runFixture({ rowCount: 300, truncated: false });
  const out = await svc.exportData(7, { startDate: '2026-01-01', endDate: '2026-01-02' });
  assert.strictEqual(seen.opts.maxRows, 500);
  assert.strictEqual(out.grid.rowCount, 300);
});

T('export over the cap is refused, never silently cut', async () => {
  const { svc } = runFixture({ rowCount: 501, truncated: true });
  await assert.rejects(svc.exportData(7, { startDate: '2026-01-01', endDate: '2026-01-02' }), (e) => e.status === 413 && /export limit/.test(e.message));
});
