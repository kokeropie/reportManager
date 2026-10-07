'use strict';
const sql = require('mssql');
const { migrate } = require('./migrations');
const { mssqlConnectionConfig } = require('../mssqlTarget');

// Thin wrapper over an mssql pool. Parameters are always bound, never concatenated.
function inferType(v) {
  if (v === null || v === undefined) return sql.NVarChar;
  if (typeof v === 'boolean') return sql.Bit;
  if (typeof v === 'number') return Number.isInteger(v) ? sql.Int : sql.Float;
  if (v instanceof Date) return sql.DateTime2;
  return sql.NVarChar;
}

async function createDb(appDb) {
  const pool = new sql.ConnectionPool({
    ...mssqlConnectionConfig(appDb.server, appDb.port, appDb.trustServerCertificate),
    database: appDb.database,
    user: appDb.user,
    password: appDb.password,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  });
  // A dropped connection must not crash the process; the pool reconnects on the next query.
  pool.on('error', (e) => console.error('App database connection error:', e.message));
  await pool.connect();

  async function query(text, params = {}) {
    const req = pool.request();
    for (const [name, value] of Object.entries(params)) {
      req.input(name, inferType(value), value === undefined ? null : value);
    }
    const result = await req.query(text);
    return result.recordset || [];
  }

  const db = {
    query,
    one: async (text, params) => (await query(text, params))[0] || null,
    close: () => pool.close(),
  };
  await migrate(db);
  return db;
}

module.exports = { createDb };
