'use strict';

// "host\instance" (a SQL Server named instance) is resolved through the SQL Browser service (UDP 1434).
// Tedious needs either a port or an instance name, never both. If a non-default port is given with an
// instance name, the port wins, which is the fix when SQL Browser is blocked (for example over a VPN).
function mssqlTarget(host, port) {
  const h = String(host || '').trim();
  const i = h.indexOf('\\');
  if (i < 0) return { server: h, port: Number(port) || 1433, instanceName: undefined };
  const server = h.slice(0, i);
  const instanceName = h.slice(i + 1);
  if (!server || !instanceName) throw new Error(`"${h}" is not a valid host\\instance name`);
  if (port && Number(port) !== 1433) return { server, port: Number(port), instanceName: undefined };
  return { server, port: undefined, instanceName };
}

// Spread into new mssql.ConnectionPool({...}) next to user/password/database.
function mssqlConnectionConfig(host, port, trustServerCertificate) {
  const t = mssqlTarget(host, port);
  // Old servers (Windows Server 2012 R2 with SQL Server 2012/2014) only offer TLS 1.0/1.1 and weak ciphers.
  // Node 17+ (OpenSSL 3) refuses those by default, which shows up as "socket hang up". Allow them on the
  // client side; the handshake still picks the best version the server supports.
  const cfg = {
    server: t.server,
    options: {
      encrypt: true,
      trustServerCertificate: !!trustServerCertificate,
      cryptoCredentialsDetails: { minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' },
    },
  };
  if (t.port) cfg.port = t.port;
  if (t.instanceName) cfg.options.instanceName = t.instanceName;
  return cfg;
}

module.exports = { mssqlTarget, mssqlConnectionConfig };
