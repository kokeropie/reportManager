'use strict';
const mysql = require('mysql2/promise');

function connect(db, database) {
  return mysql.createConnection({
    host: db.server, port: db.port, user: db.user, password: db.password, database, connectTimeout: 15000, charset: 'utf8mb4',
  });
}

function hint(e) {
  const code = (e && e.code) || '';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') return 'The server answered, but refused this login. Check the login name and password, and that the login may connect from this machine (MariaDB logins are per host: \'user\'@\'host\').';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(code)) {
    return 'Could not reach the server. Check the host and port (3306), that MariaDB is running, and that bind-address in the MariaDB config allows connections from this machine.';
  }
  return null;
}

// Counts rows only in tables that exist, so a brand new empty database reports 0 and 0.
async function countsIn(conn) {
  const [tables] = await conn.query(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users','connections')`);
  const has = new Set(tables.map((t) => String(t.name || t.TABLE_NAME).toLowerCase()));
  const count = async (table) => (await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0][0].n;
  return { users: has.has('users') ? Number(await count('users')) : 0, connections: has.has('connections') ? Number(await count('connections')) : 0 };
}

// Read-only check. Returns { ok, missingDb, users, connections, error, hint }.
async function inspectAppDb(db) {
  let conn;
  try {
    conn = await connect(db, db.database);
    const c = await countsIn(conn);
    return { ok: true, missingDb: false, users: c.users, connections: c.connections };
  } catch (e) {
    if (e.code === 'ER_BAD_DB_ERROR') return { ok: true, missingDb: true, users: 0, connections: 0 };
    return { ok: false, error: e.message, hint: hint(e) };
  } finally {
    if (conn) conn.end().catch(() => {});
  }
}

async function createDatabase(db) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(db.database)) throw new Error('Database name may only contain letters, digits and underscores (max 64)');
  const conn = await connect(db, undefined);
  try { await conn.query(`CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4`); } finally { await conn.end(); }
}

module.exports = { inspectAppDb, createDatabase };
