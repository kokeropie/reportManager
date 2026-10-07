'use strict';
// Creates the (empty) app database named in .env if it does not exist yet, using the .env login.
// The login needs the right to create databases (for example sa). Usage: node scripts/create-app-database.js
const sql = require('mssql');
const { load } = require('../src/config');
const { mssqlConnectionConfig } = require('../src/mssqlTarget');

(async () => {
  const { appDb } = load();
  if (!/^[A-Za-z0-9_]+$/.test(appDb.database)) throw new Error('APP_DB_NAME may only contain letters, digits and underscores');
  const pool = new sql.ConnectionPool({
    ...mssqlConnectionConfig(appDb.server, appDb.port, appDb.trustServerCertificate),
    database: 'master', user: appDb.user, password: appDb.password, connectionTimeout: 20000,
  });
  await pool.connect();
  try {
    const r = await pool.request().input('n', sql.NVarChar, appDb.database).query('SELECT DB_ID(@n) AS id');
    if (r.recordset[0].id) { console.log(`Database ${appDb.database} already exists.`); return; }
    await pool.request().query(`CREATE DATABASE [${appDb.database}]`);
    console.log(`Created database ${appDb.database}.`);
  } finally {
    await pool.close();
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
