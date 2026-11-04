'use strict';
// App database layer (MariaDB): placeholder binding and migration shape. No database needed.
const test = require('node:test');
const assert = require('node:assert');
const { bindNamed } = require('../src/db');
const { MIGRATIONS } = require('../src/db/migrations');

test('bindNamed turns @names into ? in order and reuses repeated names', () => {
  const r = bindNamed('SELECT * FROM t WHERE a = @a AND (@b IS NULL OR c <> @b) AND d = @a', { a: 1, b: null });
  assert.strictEqual(r.sql, 'SELECT * FROM t WHERE a = ? AND (? IS NULL OR c <> ?) AND d = ?');
  assert.deepStrictEqual(r.values, [1, null, null, 1]);
});

test('bindNamed leaves string literals alone, maps booleans to 1/0, and undefined to NULL', () => {
  const r = bindNamed(`UPDATE s SET v = '@not_a_param', w = @w, x = @x, y = @y`, { w: true, x: false, y: undefined });
  assert.strictEqual(r.sql, `UPDATE s SET v = '@not_a_param', w = ?, x = ?, y = ?`);
  assert.deepStrictEqual(r.values, [1, 0, null]);
});

test('bindNamed refuses a placeholder with no value (a typo must not bind NULL)', () => {
  assert.throws(() => bindNamed('SELECT @missing', {}), /@missing/);
});

test('migrations are MariaDB DDL: no T-SQL left, every statement re-runnable', () => {
  for (const m of MIGRATIONS) {
    assert.ok(Array.isArray(m));
    for (const st of m) {
      assert.doesNotMatch(st, /NVARCHAR|IDENTITY|SYSUTCDATETIME|DATETIME2|\bBIT\b/i);
      assert.match(st, /^(CREATE TABLE IF NOT EXISTS|INSERT IGNORE)/);
    }
  }
});
