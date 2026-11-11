'use strict';
// scripts/migrate-from-mssql.js: rows are matched by name, not id. Fake source and target, no database needed.
const test = require('node:test');
const assert = require('node:assert');
const { migrateData } = require('../scripts/migrate-from-mssql');

function fakeSource(data) {
  return {
    async query(text) {
      if (/OBJECT_ID/.test(text)) return [{ subs: 1, fa: 1 }];
      if (/FROM folder_access/.test(text)) return data.access;
      if (/FROM subscriptions/.test(text)) return data.subs;
      if (/FROM users/.test(text)) return data.users;
      if (/FROM folders/.test(text)) return data.folders;
      throw new Error('unexpected source query: ' + text);
    },
  };
}

function fakeTarget(t) {
  let nextId = 100;
  const done = (id) => Object.assign([], { insertId: id, affectedRows: 1 });
  return {
    async query(text, p) {
      if (/^SELECT[\s\S]*FROM reports/.test(text)) return t.reports;
      if (/^SELECT[\s\S]*FROM folder_access/.test(text)) return t.access;
      if (/^SELECT[\s\S]*FROM subscriptions/.test(text)) return t.subs;
      if (/^SELECT[\s\S]*FROM users/.test(text)) return t.users;
      if (/^SELECT[\s\S]*FROM folders/.test(text)) return t.folders;
      if (/^INSERT INTO users/.test(text)) { const id = nextId++; t.users.push({ id, username: p.username, password_hash: p.hash, role: p.role, disabled: p.disabled, must_change_password: p.mcp }); return done(id); }
      if (/^UPDATE users/.test(text)) { Object.assign(t.users.find((u) => u.id === p.id), { password_hash: p.hash, must_change_password: p.mcp }); return done(0); }
      if (/^INSERT INTO folders/.test(text)) { const id = nextId++; t.folders.push({ id, name: p.name, is_system: p.isSystem }); return done(id); }
      if (/^INSERT INTO folder_access/.test(text)) { t.access.push({ folder_id: p.folderId, user_id: p.userId }); return done(0); }
      if (/^INSERT INTO subscriptions/.test(text)) { const id = nextId++; t.subs.push({ id, user_id: p.userId, report_id: p.reportId, name: p.name, enabled: p.enabled, next_run_at: p.next, schedule: p.schedule }); return done(id); }
      throw new Error('unexpected target query: ' + text);
    },
  };
}

const daily = JSON.stringify({ type: 'daily', time: '07:00' });
const sub = (o) => Object.assign({ params: '{}', format: 'xlsx', schedule: daily, folder: '', enabled: true }, o);

function setup() {
  const source = {
    users: [
      { id: 1, username: 'admin', password_hash: 'OLD-A', role: 'admin', disabled: false, must_change_password: false },
      { id: 2, username: 'Rina', password_hash: 'OLD-R', role: 'viewer', disabled: false, must_change_password: false },
      { id: 3, username: 'budi', password_hash: 'OLD-B', role: 'viewer', disabled: true, must_change_password: true },
    ],
    folders: [{ name: 'Finance', is_system: false }, { name: 'Tax', is_system: false }],
    access: [{ folder_name: 'Tax', username: 'Rina' }],
    subs: [
      sub({ name: 'Daily invoices', username: 'Rina', report_name: 'Invoice List', folder_name: 'Finance' }),
      sub({ name: 'Moved', username: 'Rina', report_name: 'Billing', folder_name: 'Tax', enabled: false }),
      sub({ name: 'Gone', username: 'Rina', report_name: 'Not uploaded', folder_name: 'Finance' }),
    ],
  };
  const target = {
    // ids deliberately differ from the source
    users: [{ id: 7, username: 'admin', password_hash: 'NEW-A', must_change_password: 0 }, { id: 8, username: 'rina', password_hash: 'NEW-R', must_change_password: 1 }],
    folders: [{ id: 20, name: 'Finance' }],
    reports: [{ id: 50, name: 'invoice list', folder_name: 'Finance' }, { id: 51, name: 'Billing', folder_name: 'Finance' }],
    access: [],
    subs: [],
  };
  return { source, target };
}

test('copies passwords, folders, access and subscriptions by name, and a second run changes nothing', async () => {
  const { source, target } = setup();
  const lines = [];
  const now = new Date(2026, 10, 11, 9, 0, 0);
  const run = () => migrateData({ src: fakeSource(source), db: fakeTarget(target), now, log: (m) => lines.push(m) });

  const s = await run();
  assert.deepStrictEqual(s.users, { added: 1, passwordUpdated: 2, same: 0 });
  assert.strictEqual(target.users.find((u) => u.id === 8).password_hash, 'OLD-R');
  assert.strictEqual(target.users.find((u) => u.id === 8).must_change_password, false);
  const budi = target.users.find((u) => u.username === 'budi');
  assert.strictEqual(budi.disabled, true);
  assert.strictEqual(budi.must_change_password, true);

  assert.deepStrictEqual(s.folders, { added: 1, same: 1 });
  const tax = target.folders.find((f) => f.name === 'Tax');
  assert.deepStrictEqual(target.access, [{ folder_id: tax.id, user_id: 8 }]);

  assert.deepStrictEqual(s.subscriptions, { added: 2, same: 0, skipped: 1 });
  const [a, b] = target.subs;
  assert.deepStrictEqual([a.user_id, a.report_id], [8, 50]);
  assert.deepStrictEqual(a.next_run_at, new Date(2026, 10, 12, 7, 0, 0)); // recomputed, not the old server's value
  assert.deepStrictEqual([b.report_id, b.enabled, b.next_run_at], [51, false, null]); // unique name in another folder; stays paused
  assert.ok(lines.some((l) => /"Gone".*SKIPPED.*not uploaded/.test(l)));

  const again = await run();
  assert.deepStrictEqual(again.users, { added: 0, passwordUpdated: 0, same: 3 });
  assert.deepStrictEqual(again.folders, { added: 0, same: 2 });
  assert.deepStrictEqual(again.folderAccess, { added: 0, same: 1, skipped: 0 });
  assert.deepStrictEqual(again.subscriptions, { added: 0, same: 2, skipped: 1 });
  assert.strictEqual(target.subs.length, 2);
});
