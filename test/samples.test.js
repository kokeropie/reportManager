'use strict';
// AC-1b/1c: every sample RDL parses, shows its parameters and columns, and passes the query guard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRdl, RdlError } = require('../src/rdl/parser');
const { checkQuery } = require('../src/rdl/guard');
const { defaultValues, resolveParams, renderGrid, displayOf } = require('../src/rdl/engine');
const { reportNameFromFile } = require('../src/reports/service');
const T = fs.existsSync(require('path').join(__dirname, '..', 'sampleReport')) ? test : (name, fn) => test(name, { skip: 'sampleReport/ is not in the repo (kept private)' }, fn);

const DIR = path.join(__dirname, '..', 'sampleReport');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.rdl')) : [];
const load = (f) => parseRdl(fs.readFileSync(path.join(DIR, f), 'utf8'));

T('sample folder has the 19 RDL files', () => assert.strictEqual(files.length, 19));

for (const f of files) {
  test(`parses cleanly: ${f}`, () => {
    const def = load(f);
    assert.deepStrictEqual(def.errors, [], 'no blocking errors');
    assert.ok(def.table.columns.length > 0, 'has columns');
    assert.ok(def.table.rows.some((r) => r.kind === 'detail'), 'has a detail row');
    assert.ok(def.table.rows.some((r) => r.kind === 'header'), 'has a header row');
    assert.strictEqual(checkQuery(def.dataset.commandText), null);
    assert.deepStrictEqual(def.warnings.filter((w) => /Unsupported function|syntax|not in the dataset|not defined/.test(w)), []);
    for (const q of def.dataset.queryParameters) {
      assert.ok(q.paramRef && def.parameters.some((p) => p.name.toLowerCase() === q.paramRef.toLowerCase()));
    }
  });
}

T('2005 Table and 2008 Tablix both parse (FR-29)', () => {
  assert.strictEqual(load('Bank Transaction List (exclude Void) - Backup.rdl').schema, '2005');
  assert.strictEqual(load('Invoice List - PJTI (autoDate).rdl').schema, '2008');
});

T('parameters are read dynamically: names, counts and types differ per report (AC-1a, FR-16a)', () => {
  const a = load('Corporate Billing_All v2.rdl');
  assert.deepStrictEqual(a.parameters.map((p) => [p.name, p.type]), [['startdate', 'DateTime'], ['enddate', 'DateTime'], ['clientName', 'String']]);
  const b = load('Billing List - Arjuna (autoDate H-1).rdl');
  assert.deepStrictEqual(b.parameters.map((p) => p.name), ['Parameter1', 'Parameter2']);
  assert.strictEqual(b.dataset.queryParameters[0].positional, true);
});

T('autoDate defaults: start = yesterday, end = today (AC-1c, FR-32)', () => {
  const d = defaultValues(load('Invoice List - PJTI (autoDate).rdl'));
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  assert.strictEqual(d.endDate, iso(now));
  assert.strictEqual(d.startDate, iso(y));
});

T('.rdl.data and other files are rejected on upload (FR-35)', () => {
  assert.throws(() => reportNameFromFile('Invoice Proforma List - Void Only.rdl.data'), /not an .rdl file/);
  assert.throws(() => reportNameFromFile('notes.txt'), /not an .rdl file/);
  assert.strictEqual(reportNameFromFile('C:\\x\\My Report.RDL'), 'My Report');
});

T('invalid files are rejected with a clear message (AC-5)', () => {
  assert.throws(() => parseRdl('hello'), RdlError);
  assert.throws(() => parseRdl('<html/>'), /not an RDL report/);
  assert.throws(() => parseRdl('<Report xmlns="x"><DataSets/></Report>'), RdlError);
});

T('grouped report: group header row appears once per group, detail rows follow (ePRV Outstanding)', () => {
  const def = load('ePRV Data Export (General - Process to) Outstanding.rdl');
  assert.deepStrictEqual(def.table.rows.map((r) => r.kind), ['header', 'groupHeader', 'detail']);
  const rows = [
    { Status: 'Open', PRVID: 'P1' }, { Status: 'Paid', PRVID: 'P2' }, { Status: 'Open', PRVID: 'P3' },
  ];
  const { values } = resolveParams(def, { Parameter1: '2026-01-01', Parameter2: '2026-01-31' });
  const g = renderGrid(def, rows, values);
  assert.deepStrictEqual(g.rows.map((r) => r.kind), ['header', 'groupHeader', 'detail', 'detail', 'groupHeader', 'detail']);
  assert.strictEqual(displayOf(g.rows[1].cells[0]), 'Open');
  assert.strictEqual(displayOf(g.rows[2].cells[1]), 'P1');
  assert.strictEqual(displayOf(g.rows[3].cells[1]), 'P3');
  assert.strictEqual(displayOf(g.rows[4].cells[0]), 'Paid');
});

T('Corporate Billing: grouped by client, detail sorted by invoice (AC-1d style check)', () => {
  const def = load('Corporate Billing_All v2.rdl');
  const rows = [
    { ClientName: 'B', InvoiceID: 'INV2', IndexInvoiceDetails: 2, uniqueValue: 'u3', DateOfCreated: new Date(Date.UTC(2026, 0, 5)) },
    { ClientName: 'A', InvoiceID: 'INV9', IndexInvoiceDetails: 1, uniqueValue: 'u2', DateOfCreated: new Date(Date.UTC(2026, 0, 6)) },
    { ClientName: 'B', InvoiceID: 'INV1', IndexInvoiceDetails: 1, uniqueValue: 'u1', DateOfCreated: new Date(Date.UTC(2026, 0, 7)) },
  ];
  const { values } = resolveParams(def, { startdate: '2026-01-01', enddate: '2026-01-31', clientName: 'x' });
  const g = renderGrid(def, rows, values);
  const detail = g.rows.filter((r) => r.kind === 'detail');
  assert.strictEqual(detail.length, 3);
  // groups keep first-seen order (B then A); inside B the details are sorted by InvoiceID
  assert.deepStrictEqual(detail.map((r) => displayOf(r.cells[2])), ['INV1', 'INV2', 'INV9']);
  assert.match(g.heading.join('|'), /RECONCILIATION/);
});

T('eFaktur: date text expression Day-Mon-Year', () => {
  const def = load('eFaktur v5 (invoice_detail CA Only autoDate).rdl');
  const { values } = resolveParams(def, defaultValues(def));
  const g = renderGrid(def, [{ DateOfCreated: new Date(Date.UTC(2026, 9, 1)), InvoiceID: 'I1', ClientName: '  Acme ' }], values);
  const detail = g.rows.find((r) => r.kind === 'detail');
  assert.strictEqual(displayOf(detail.cells[0]), '1-Oct-2026');
  assert.strictEqual(displayOf(detail.cells[3]), 'Acme');
});

T('zero rows still renders the header', () => {
  const def = load('Invoice List - PJTI (autoDate).rdl');
  const g = renderGrid(def, [], resolveParams(def, defaultValues(def)).values);
  assert.deepStrictEqual(g.rows.map((r) => r.kind), ['header']);
  assert.strictEqual(g.columns[0].name, 'Divisi');
});
