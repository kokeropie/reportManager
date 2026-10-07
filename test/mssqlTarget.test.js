'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mssqlTarget, mssqlConnectionConfig } = require('../src/mssqlTarget');

test('plain host uses the port', () => {
  assert.deepStrictEqual(mssqlTarget('10.0.0.1', 1433), { server: '10.0.0.1', port: 1433, instanceName: undefined });
  assert.strictEqual(mssqlTarget('10.0.0.1', 14330).port, 14330);
});

test('host\\instance uses the instance name via SQL Browser', () => {
  const t = mssqlTarget('117.102.85.247\\ins', 1433);
  assert.deepStrictEqual(t, { server: '117.102.85.247', port: undefined, instanceName: 'ins' });
  const cfg = mssqlConnectionConfig('117.102.85.247\\ins', 1433, true);
  assert.strictEqual(cfg.server, '117.102.85.247');
  assert.strictEqual(cfg.options.instanceName, 'ins');
  assert.strictEqual('port' in cfg, false, 'port and instanceName must not both be set');
  assert.strictEqual(cfg.options.trustServerCertificate, true);
});

test('host\\instance with an explicit non-default port uses the port (SQL Browser blocked)', () => {
  const cfg = mssqlConnectionConfig('117.102.85.247\\ins', 51433, false);
  assert.strictEqual(cfg.port, 51433);
  assert.strictEqual(cfg.options.instanceName, undefined);
});

test('bad instance name is refused', () => {
  assert.throws(() => mssqlTarget('host\\', 1433));
  assert.throws(() => mssqlTarget('\\ins', 1433));
});
