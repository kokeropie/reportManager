'use strict';
const sql = require('mssql');
const { mssqlConnectionConfig } = require('../mssqlTarget');

function poolFor(db, database) {
  return new sql.ConnectionPool({
    ...mssqlConnectionConfig(db.server, db.port, db.trustServerCertificate),
    database, user: db.user, password: db.password, connectionTimeout: 15000, requestTimeout: 15000,
  });
}

function hint(e) {
  const m = (e && e.message) || '';
  if (/Cannot open database/i.test(m)) return null;
  if (/ELOGIN|Login failed/i.test(m + (e.code || ''))) return 'The server answered, but refused this login. Check the login name and password, and that SQL Server allows SQL logins (mixed mode).';
  if (/ESOCKET|ETIMEOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Failed to connect|getaddrinfo/i.test(m + (e.code || ''))) {
    return 'Could not reach the server. Check the VPN, the host\\instance name, and that SQL Server allows TCP/IP. For a named instance you can also enter its fixed port.';
  }
  return null;
}

// SQL Server resolves table names when it compiles a statement, so a query that mentions a table that does not
// exist yet fails even inside a CASE. Check which tables exist first, then count only those.
async function countsIn(pool) {
  const t = await pool.request().query(
    `SELECT CASE WHEN OBJECT_ID('users','U') IS NULL THEN 0 ELSE 1 END AS has_users,
            CASE WHEN OBJECT_ID('connections','U') IS NULL THEN 0 ELSE 1 END AS has_connections`
  );
  const has = t.recordset[0];
  const count = async (table) => (await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`)).recordset[0].n;
  return {
    users: has.has_users ? await count('users') : 0,
    connections: has.has_connections ? await count('connections') : 0,
  };
}

// Read-only check. Returns { ok, missingDb, users, connections, error, hint }.
async function inspectAppDb(db) {
  let pool = poolFor(db, db.database);
  try {
    await pool.connect();
    const c = await countsIn(pool);
    return { ok: true, missingDb: false, users: c.users, connections: c.connections };
  } catch (e) {
    if (/Cannot open database/i.test(e.message || '')) {
      // Either it does not exist, or the login may not use it. Ask master which.
      const master = poolFor(db, 'master');
      try {
        await master.connect();
        const r = await master.request().input('n', sql.NVarChar, db.database).query('SELECT DB_ID(@n) AS id');
        if (!r.recordset[0].id) return { ok: true, missingDb: true, users: 0, connections: 0 };
        return { ok: false, error: `The database "${db.database}" exists, but this login cannot open it. Grant it access (db_owner).` };
      } catch (e2) {
        return { ok: false, error: e2.message, hint: hint(e2) };
      } finally {
        master.close().catch(() => {});
      }
    }
    return { ok: false, error: e.message, hint: hint(e) };
  } finally {
    pool.close().catch(() => {});
  }
}

async function createDatabase(db) {
  if (!/^[A-Za-z0-9_]{1,100}$/.test(db.database)) throw new Error('Database name may only contain letters, digits and underscores');
  const master = poolFor(db, 'master');
  await master.connect();
  try { await master.request().query(`CREATE DATABASE [${db.database}]`); } finally { await master.close(); }
}

module.exports = { inspectAppDb, createDatabase };
