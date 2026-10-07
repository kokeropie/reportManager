'use strict';
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// Values as they are in .env right now (used after setup rewrote it), laid over the process environment.
function freshEnv() {
  let file = {};
  try { file = dotenv.parse(fs.readFileSync(envPath)); } catch (e) { /* no .env */ }
  return Object.assign({}, process.env, file);
}

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return String(v).toLowerCase() === 'true';
}

function load(env = process.env) {
  const cfg = {
    port: parseInt(env.PORT || '3000', 10),
    sessionSecret: env.SESSION_SECRET || '',
    sessionHours: parseFloat(env.SESSION_HOURS || '8'),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, false),
    encryptionKey: env.ENCRYPTION_KEY || '',
    appDb: {
      server: env.APP_DB_SERVER || 'localhost',
      port: parseInt(env.APP_DB_PORT || '1433', 10),
      database: env.APP_DB_NAME || 'ReportServer',
      user: env.APP_DB_USER || '',
      password: env.APP_DB_PASSWORD || '',
      trustServerCertificate: bool(env.APP_DB_TRUST_CERT, true),
    },
    reportsDir: env.REPORTS_DIR || path.join(__dirname, '..', 'reports'),
    queryTimeoutSeconds: parseInt(env.QUERY_TIMEOUT_SECONDS || '120', 10),
    maxRows: parseInt(env.MAX_ROWS || '100000', 10),
    exportMaxRows: parseInt(env.EXPORT_MAX_ROWS || '500000', 10),
    pageSize: parseInt(env.PAGE_SIZE || '100', 10),
    poolSize: parseInt(env.POOL_SIZE || '10', 10),
    maxConcurrentRuns: parseInt(env.MAX_CONCURRENT_RUNS || '5', 10),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
  };
  return cfg;
}

function validate(cfg) {
  const errors = [];
  if (cfg.sessionSecret.length < 32) errors.push('SESSION_SECRET must be at least 32 characters');
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.encryptionKey)) errors.push('ENCRYPTION_KEY must be 64 hex characters');
  if (!cfg.appDb.user) errors.push('APP_DB_USER is required');
  if (!cfg.appDb.password) errors.push('APP_DB_PASSWORD is required');
  if (!(cfg.sessionHours > 0)) errors.push('SESSION_HOURS must be a positive number');
  return errors;
}

module.exports = { load, validate, envPath, freshEnv };
