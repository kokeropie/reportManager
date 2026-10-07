'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateConnection } = require('../src/connections/validate');
const { checkPassword, checkUsername } = require('../src/auth/users');
const { load, validate } = require('../src/config');

const good = { name: 'PTES', type: 'mssql', host: '10.0.0.5', database: 'db', username: 'u', password: 'p' };

test('connection: defaults port per type', () => {
  assert.strictEqual(validateConnection(good, { requirePassword: true }).value.port, 1433);
  assert.strictEqual(validateConnection({ ...good, type: 'mysql' }, { requirePassword: true }).value.port, 3306);
});

test('connection: rejects bad type, port, missing fields', () => {
  assert.ok(validateConnection({ ...good, type: 'oracle' }, { requirePassword: true }).error);
  assert.ok(validateConnection({ ...good, port: 70000 }, { requirePassword: true }).error);
  assert.ok(validateConnection({ ...good, host: ' ' }, { requirePassword: true }).error);
  assert.ok(validateConnection(null, { requirePassword: true }).error);
});

test('connection: password required on create, optional on update', () => {
  assert.ok(validateConnection({ ...good, password: '' }, { requirePassword: true }).error);
  assert.strictEqual(validateConnection({ ...good, password: '' }, { requirePassword: false }).value.password, '');
});

test('connection: trust cert only applies to mssql', () => {
  assert.strictEqual(validateConnection({ ...good, trustServerCert: true }, { requirePassword: true }).value.trustServerCert, true);
  assert.strictEqual(validateConnection({ ...good, type: 'mysql', trustServerCert: true }, { requirePassword: true }).value.trustServerCert, false);
});

test('user input checks', () => {
  assert.ok(checkPassword('short'));
  assert.strictEqual(checkPassword('long-enough-1'), null);
  assert.ok(checkUsername('a b'));
  assert.strictEqual(checkUsername('kusuma.p'), null);
});

test('config validation flags missing secrets', () => {
  assert.ok(validate(load({})).length >= 3);
  const ok = load({ SESSION_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'a'.repeat(64), APP_DB_USER: 'sa', APP_DB_PASSWORD: 'x' });
  assert.deepStrictEqual(validate(ok), []);
});
