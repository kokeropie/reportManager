'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/rdl/expressions');
const { checkQuery, scanParams } = require('../src/rdl/guard');
const { formatValue } = require('../src/rdl/formats');

const D = (y, m, d, h = 0) => new Date(Date.UTC(y, m - 1, d, h));
const row = { i: 0, f: { a: 10, b: 'x', n: null, d: D(2026, 3, 15, 14), name: 'Hello' } };
const ctx = { row, params: { p: 5 }, allRows: [row, { i: 1, f: { a: 20 } }], scopeRows: [row, { i: 1, f: { a: 20 } }] };
const ev = (s) => E.run(E.compile(s), ctx);

test('operators and precedence', () => {
  assert.strictEqual(ev('=1+2*3'), 7);
  assert.strictEqual(ev('=(1+2)*3'), 9);
  assert.strictEqual(ev('=2^3^2'), 64); // left to right in VB
  assert.strictEqual(ev('=7\\2'), 3);
  assert.strictEqual(ev('=7 Mod 3'), 1);
  assert.strictEqual(ev('="a" & 1 & Nothing & "b"'), 'a1b');
  assert.strictEqual(ev('=Fields!a.Value > 5 And Fields!b.Value = "x"'), true);
  assert.strictEqual(ev('=Not (1 = 2) Or False'), true);
  assert.strictEqual(ev('=Fields!n.Value = ""'), true);
  assert.strictEqual(ev('=-Fields!a.Value'), -10);
});

test('strings', () => {
  assert.strictEqual(ev('=Left(Fields!name.Value, 2)'), 'He');
  assert.strictEqual(ev('=Right(Fields!name.Value, 3)'), 'llo');
  assert.strictEqual(ev('=Right(Fields!name.Value, 0)'), '');
  assert.strictEqual(ev('=Mid(Fields!name.Value, 2, 3)'), 'ell');
  assert.strictEqual(ev('=Len(Fields!name.Value)'), 5);
  assert.strictEqual(ev('=UCase(Fields!name.Value) & LCase("AB")'), 'HELLOab');
  assert.strictEqual(ev('="  x ".length'.replace('.length', '')), '  x ');
  assert.strictEqual(ev('=LTrim(RTrim("  x "))'), 'x');
  assert.strictEqual(ev('=Replace("a-b-c","-","+")'), 'a+b+c');
  assert.strictEqual(ev('="say ""hi"""'), 'say "hi"');
});

test('dates', () => {
  assert.strictEqual(ev('=Day(Fields!d.Value)'), 15);
  assert.strictEqual(ev('=MonthName(Month(Fields!d.Value))'), 'March');
  assert.strictEqual(ev('=Left(MonthName(3),3)'), 'Mar');
  assert.strictEqual(ev('=Year(DateAdd("d", 20, Fields!d.Value))'), 2026);
  assert.strictEqual(ev('=Month(DateAdd("m", 11, Fields!d.Value))'), 2);
  assert.strictEqual(ev('=Day(DateAdd(DateInterval.Day, -15, Fields!d.Value))'), 28);
  assert.strictEqual(ev('=DateDiff("d", Fields!d.Value, DateAdd("d", 3, Fields!d.Value))'), 3);
  assert.ok(ev('=Today()') instanceof Date);
  assert.ok(ev('=Now') instanceof Date);
});

test('logic and nulls', () => {
  assert.strictEqual(ev('=IIF(Fields!a.Value > 5, "big", "small")'), 'big');
  assert.strictEqual(ev('=IIF(IsNothing(Fields!n.Value), "none", "some")'), 'none');
  assert.strictEqual(ev('=IIF(Fields!a.Value > 99, 1/0, 2)'), 2); // untaken branch not evaluated
  assert.strictEqual(ev('=Fields!n.Value + 1'), 1);
  assert.strictEqual(ev('=Switch(1=2, "a", 2=2, "b")'), 'b');
});

test('aggregates run over the scope rows', () => {
  assert.strictEqual(ev('=Sum(Fields!a.Value)'), 30);
  assert.strictEqual(ev('=Count(Fields!a.Value)'), 2);
  assert.strictEqual(ev('=Max(Fields!a.Value)'), 20);
  assert.strictEqual(ev('=Avg(Fields!a.Value)'), 15);
  assert.strictEqual(ev('=First(Fields!a.Value, "DS")'), 10);
  assert.strictEqual(ev('=Sum(Fields!a.Value) * 2'), 60);
});

test('parameters and unknowns', () => {
  assert.strictEqual(ev('=Parameters!p.Value + 1'), 6);
  assert.throws(() => ev('=Fields!nope.Value'), /Unknown field/);
  assert.throws(() => ev('=Parameters!zz.Value'), /Unknown parameter/);
  assert.throws(() => ev('=Frobnicate(1)'), /Unsupported function/);
  assert.throws(() => ev('=1/0'), /Division by zero/);
});

test('static analysis lists unsupported functions (FR-37) and syntax errors', () => {
  assert.deepStrictEqual(E.unsupportedFunctions(E.compile('=Foo(1) & Left("a",1) & Bar()')), ['Foo', 'Bar']);
  assert.ok(E.compile('=1 +').error);
  assert.strictEqual(E.compile('plain text').literal, 'plain text');
});

test('no code execution: JavaScript-looking input is just a syntax error (FR-36)', () => {
  for (const s of ['=constructor.constructor("return 1")()', '=process.exit()', '=require("fs")', '=this']) {
    const c = E.compile(s);
    assert.throws(() => E.run(c, ctx));
  }
});

test('formats', () => {
  assert.strictEqual(formatValue(1234.5, '#,##0.00'), '1,234.50');
  assert.strictEqual(formatValue(1234.5, 'N0'), '1,235');
  assert.strictEqual(formatValue(0.256, 'P1'), '25.6%');
  assert.strictEqual(formatValue(D(2026, 3, 5, 14), 'dd/MM/yyyy HH:mm'), '05/03/2026 14:00');
  assert.strictEqual(formatValue(D(2026, 3, 5), 'd-MMM-yy'), '5-Mar-26');
  assert.strictEqual(formatValue(7, '000'), '007');
  assert.strictEqual(formatValue(null, 'N2'), '');
});

test('query guard allows reads and UDF calls (FR-27, FR-27a)', () => {
  assert.strictEqual(checkQuery('SELECT TOP (100) PERCENT a, dbo.Part(x, DEFAULT) FROM dbo.[Clients X] WHERE d BETWEEN @s AND @e'), null);
  assert.strictEqual(checkQuery('WITH c AS (SELECT 1 AS x) SELECT * FROM c;'), null);
  assert.strictEqual(checkQuery("SELECT 'DROP TABLE x; -- delete' AS s -- UPDATE\nFROM t"), null);
  assert.strictEqual(checkQuery('SELECT [Update], `delete` FROM t'), null);
  assert.strictEqual(checkQuery('SELECT updated_at, deleted FROM t'), null);
});

test('query guard rejects writes and tricks', () => {
  for (const q of [
    'DELETE FROM t', 'UPDATE t SET a=1', 'SELECT 1; DROP TABLE t', 'EXEC sp_who', 'SELECT * INTO x FROM t',
    'SELECT * FROM t FOR UPDATE', 'INSERT INTO t VALUES (1)', 'SELECT xp_cmdshell(1)', "SELECT * FROM OPENROWSET('a','b','c')",
    'DECLARE @a INT SELECT @a', '', 'CALL proc()', "SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT 1 /* x */; SELECT 2',
  ]) assert.ok(checkQuery(q), `should reject: ${q}`);
});

test('scanParams finds @names and ? outside strings and comments', () => {
  assert.deepStrictEqual(scanParams("SELECT '@no', @a, @A, @@ROWCOUNT -- @c\n FROM t WHERE x=@b").named, ['a', 'b']);
  assert.strictEqual(scanParams("SELECT '?' , a FROM t WHERE x = ? AND y = ?").positional, 2);
});
