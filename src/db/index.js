'use strict';
const mysql = require('mysql2/promise');
const { migrate } = require('./migrations');

// Turns "@name" placeholders into "?" and orders the values to match. String literals are left alone.
// Throws if a placeholder has no value, so a typo cannot silently bind NULL.
function bindNamed(text, params = {}) {
  const values = [];
  const sql = text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|@([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
    if (!name) return m;
    if (!Object.prototype.hasOwnProperty.call(params, name)) throw new Error(`No value for SQL parameter @${name}`);
    const v = params[name];
    values.push(v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    return '?';
  });
  return { sql, values };
}

// SELECT gives the rows. INSERT/UPDATE/DELETE give an empty array that also carries affectedRows and insertId.
function shape(result) {
  if (Array.isArray(result)) return result;
  const out = [];
  out.affectedRows = result.affectedRows;
  out.insertId = result.insertId;
  return out;
}

function wrap(exec) {
  const query = async (text, params) => {
    const { sql, values } = bindNamed(text, params);
    const [result] = await exec(sql, values);
    return shape(result);
  };
  return { query, one: async (text, params) => (await query(text, params))[0] || null };
}

// Thin wrapper over a mysql2 pool (MariaDB 10.5+). Values are always bound, never concatenated.
async function createDb(appDb) {
  const pool = mysql.createPool({
    host: appDb.server,
    port: appDb.port,
    database: appDb.database,
    user: appDb.user,
    password: appDb.password,
    charset: 'utf8mb4',
    timezone: 'Z', // dates are naive wall-clock values held as UTC
    connectionLimit: 10,
    connectTimeout: 15000,
    waitForConnections: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
  });
  // A dropped connection must not crash the process; the pool reconnects on the next query.
  pool.on('error', (e) => console.error('App database connection error:', e.message));
  await pool.query('SELECT 1');

  const base = wrap((sql, values) => pool.query(sql, values));
  const db = {
    ...base,
    // Runs fn(tx) on one connection inside a transaction; tx has the same query/one. Rolls back if fn throws.
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(wrap((sql, values) => conn.query(sql, values)));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

module.exports = { createDb, bindNamed };
