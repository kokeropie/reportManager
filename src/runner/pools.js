'use strict';
// One pooled client per report connection (FR-28), so many users share a few DB sessions.
const mssql = require('mssql');
const mysql = require('mysql2/promise');

function createPools({ poolSize = 10, queryTimeoutMs = 120000 } = {}) {
  const entries = new Map(); // connection id -> { key, pool, engine }

  async function build(c) {
    if (c.type === 'mssql') {
      const pool = new mssql.ConnectionPool({
        server: c.host, port: c.port, database: c.database, user: c.username, password: c.password,
        options: { encrypt: true, trustServerCertificate: !!c.trustServerCert },
        pool: { max: poolSize, min: 0, idleTimeoutMillis: 60000 },
        connectionTimeout: 15000,
        requestTimeout: queryTimeoutMs,
      });
      pool.on('error', () => entries.delete(c.id));
      await pool.connect();
      return pool;
    }
    return mysql.createPool({
      host: c.host, port: c.port, database: c.database, user: c.username, password: c.password,
      connectionLimit: poolSize, connectTimeout: 15000, timezone: 'Z', decimalNumbers: true,
    });
  }

  async function close(entry) {
    try { await (entry.engine === 'mssql' ? entry.pool.close() : entry.pool.end()); } catch (e) { /* already gone */ }
  }

  return {
    // `c` comes from connections.getWithSecret(); a changed updatedAt (edited connection) builds a fresh pool.
    async get(c) {
      const key = `${c.updatedAt}|${c.host}|${c.port}|${c.database}|${c.username}`;
      const cur = entries.get(c.id);
      if (cur && cur.key === key) return cur;
      if (cur) { entries.delete(c.id); close(cur); }
      const pool = await build(c);
      const entry = { key, pool, engine: c.type };
      entries.set(c.id, entry);
      return entry;
    },
    invalidate(id) {
      const cur = entries.get(id);
      if (cur) { entries.delete(id); close(cur); }
    },
    async closeAll() {
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map(close));
    },
  };
}

// Run one query, stopping once maxRows + 1 rows are seen. Resolves { rows, truncated }.
function executeMssql(entry, binding, { maxRows }) {
  return new Promise((resolve, reject) => {
    const req = entry.pool.request();
    req.stream = true;
    for (const p of binding.named) {
      const t = { DateTime: mssql.DateTime, Integer: mssql.Int, Float: mssql.Float, Boolean: mssql.Bit }[p.type] || mssql.NVarChar;
      req.input(p.name, t, p.value);
    }
    const rows = [];
    let truncated = false;
    req.on('row', (r) => {
      if (truncated) return;
      if (rows.length >= maxRows) { truncated = true; req.cancel(); return; }
      rows.push(r);
    });
    req.on('error', (e) => (truncated ? resolve({ rows, truncated }) : reject(e)));
    req.on('done', () => resolve({ rows, truncated }));
    req.query(binding.sql);
  });
}

async function executeMysql(entry, binding, { maxRows, timeoutMs }) {
  const conn = await entry.pool.getConnection();
  return new Promise((resolve, reject) => {
    const rows = [];
    let done = false;
    const finish = (err, truncated, destroy) => {
      if (done) return;
      done = true;
      if (destroy) conn.destroy(); else conn.release();
      err ? reject(err) : resolve({ rows, truncated: !!truncated });
    };
    const stream = conn.connection.query({ sql: binding.sql, values: binding.values, timeout: timeoutMs }).stream();
    stream.on('data', (r) => {
      if (done) return;
      if (rows.length >= maxRows) { finish(null, true, true); return; } // drop this connection mid-result
      rows.push(r);
    });
    stream.on('error', (e) => finish(e, false, true));
    stream.on('end', () => finish(null, false, false));
  });
}

function execute(entry, binding, opts) {
  return entry.engine === 'mssql' ? executeMssql(entry, binding, opts) : executeMysql(entry, binding, opts);
}

module.exports = { createPools, execute };
