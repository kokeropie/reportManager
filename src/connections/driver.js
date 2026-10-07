'use strict';
const mssql = require('mssql');
const mysql = require('mysql2/promise');

const TIMEOUT_MS = 10000;

// FR-6: report success, or the driver's own error message. Never throws.
async function testConnection(c) {
  const started = Date.now();
  try {
    if (c.type === 'mssql') {
      const pool = new mssql.ConnectionPool({
        server: c.host,
        port: c.port,
        database: c.database,
        user: c.username,
        password: c.password,
        connectionTimeout: TIMEOUT_MS,
        requestTimeout: TIMEOUT_MS,
        options: { encrypt: true, trustServerCertificate: !!c.trustServerCert },
      });
      await pool.connect();
      try { await pool.request().query('SELECT 1 AS ok'); } finally { await pool.close(); }
    } else {
      const conn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        database: c.database,
        user: c.username,
        password: c.password,
        connectTimeout: TIMEOUT_MS,
      });
      try { await conn.query('SELECT 1'); } finally { await conn.end(); }
    }
    return { ok: true, message: `Connected in ${Date.now() - started} ms` };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

module.exports = { testConnection };
