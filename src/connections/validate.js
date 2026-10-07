'use strict';

const TYPES = ['mssql', 'mysql'];
const DEFAULT_PORT = { mssql: 1433, mysql: 3306 };

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Returns { error } or { value }. `password` is '' when the caller wants to keep the stored one (update).
function validateConnection(body, { requirePassword }) {
  const b = body || {};
  const type = str(b.type);
  if (!TYPES.includes(type)) return { error: 'Type must be mssql or mysql' };
  const name = str(b.name);
  if (!name || name.length > 100) return { error: 'Name is required (max 100 characters)' };
  const host = str(b.host);
  if (!host || host.length > 255) return { error: 'Host or IP is required' };
  const port = b.port === undefined || b.port === null || b.port === '' ? DEFAULT_PORT[type] : Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be between 1 and 65535' };
  const database = str(b.database);
  if (!database) return { error: 'Database name is required' };
  const username = str(b.username);
  if (!username) return { error: 'Username is required' };
  const password = typeof b.password === 'string' ? b.password : '';
  if (requirePassword && !password) return { error: 'Password is required' };
  return {
    value: { name, type, host, port, database, username, password, trustServerCert: type === 'mssql' && !!b.trustServerCert },
  };
}

module.exports = { validateConnection, TYPES, DEFAULT_PORT };
