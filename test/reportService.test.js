'use strict';
// Upload rules with a tiny fake database and a temp folder (AC-5, FR-9..FR-12, FR-30, FR-35).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReportService } = require('../src/reports/service');
const T = fs.existsSync(require('path').join(__dirname, '..', 'sampleReport')) ? test : (name, fn) => test(name, { skip: 'sampleReport/ is not in the repo (kept private)' }, fn);

const DIR = path.join(__dirname, '..', 'sampleReport');
const xml = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

function setup({ connections = [{ id: 5, name: 'PTES_SVRINS02' }], existing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-'));
  const inserted = [];
  const db = {
    one: async (sql, p) => {
      if (/FROM reports WHERE folder_id/.test(sql)) return existing ? { id: 1 } : null;
      if (/FROM connections WHERE LOWER/.test(sql)) return connections.find((c) => c.name.toLowerCase() === String(p.name).toLowerCase()) || null;
      if (/FROM connections WHERE id/.test(sql)) return connections.find((c) => c.id === p.id) || null;
      if (/INSERT INTO reports/.test(sql)) { inserted.push(p); return { id: 11 }; }
      return null;
    },
    query: async () => [],
  };
  return { svc: createReportService({ db, reportsDir: dir }), dir, inserted };
}

T('upload stores the file and matches the connection by data source name (FR-30)', async () => {
  const { svc, dir, inserted } = setup();
  const out = await svc.create({ folderId: 2, fileName: 'Invoice List - PJTI (autoDate).rdl', xml: xml('Invoice List - PJTI (autoDate).rdl'), userId: 1 });
  assert.strictEqual(out.id, 11);
  assert.strictEqual(out.connectionId, 5);
  assert.strictEqual(out.autoMatched, true);
  assert.strictEqual(inserted[0].name, 'Invoice List - PJTI (autoDate)');
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]{36}\.rdl$/, 'stored under a random name, never the uploaded name');
});

T('no matching connection leaves the report unassigned (viewers see "Not configured")', async () => {
  const { svc } = setup({ connections: [] });
  const out = await svc.create({ folderId: 2, fileName: 'a.rdl', xml: xml('Invoice List - PJTI (autoDate).rdl'), userId: 1 });
  assert.strictEqual(out.connectionId, null);
});

T('rejected uploads save nothing (AC-5)', async () => {
  const { svc, dir } = setup();
  await assert.rejects(svc.create({ folderId: 2, fileName: 'x.rdl.data', xml: 'zzz', userId: 1 }), /not an .rdl file/);
  await assert.rejects(svc.create({ folderId: 2, fileName: 'x.rdl', xml: 'not xml at all', userId: 1 }), /not an RDL|not valid XML/);
  const evil = xml('Invoice List - PJTI (autoDate).rdl').replace(/<CommandText>[\s\S]*?<\/CommandText>/, '<CommandText>DELETE FROM dbo.Invoice</CommandText>');
  await assert.rejects(svc.create({ folderId: 2, fileName: 'evil.rdl', xml: evil, userId: 1 }), /cannot be used.*SELECT or WITH/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

T('uploading the same name again replaces the existing report', async () => {
  const { svc } = setup({ existing: true });
  const calls = [];
  svc.replace = async (id) => { calls.push(id); return { id, warnings: [] }; };
  const out = await svc.create({ folderId: 2, fileName: 'a.rdl', xml: xml('Invoice List - PJTI (autoDate).rdl'), userId: 1 });
  assert.strictEqual(out.replaced, true);
  assert.strictEqual(calls.length, 1);
});

T('missing @parameter in the RDL is an upload error, not a run-time surprise (FR-16b)', async () => {
  const { svc } = setup();
  const broken = xml('Invoice List - PJTI (autoDate).rdl').replace('BETWEEN @startDate AND @endDate', 'BETWEEN @startDate AND @mystery');
  await assert.rejects(svc.create({ folderId: 2, fileName: 'b.rdl', xml: broken, userId: 1 }), /@mystery/);
});

T('every one of the 20 samples is accepted (AC-1b)', async () => {
  const { svc } = setup();
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.rdl'));
  let n = 0;
  for (const f of files) {
    const out = await svc.create({ folderId: 2, fileName: f, xml: xml(f), userId: 1 });
    assert.ok(out.id);
    n++;
  }
  assert.strictEqual(n, 20);
});
