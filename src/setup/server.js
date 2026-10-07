'use strict';
// First-run setup site. It runs INSTEAD of the app when .env is incomplete (or with --setup), asks for the
// SQL Server details, checks them, creates the database if needed, writes .env, then hands over to the real app.
// Everything is gated by a one-time code printed in the server console/log, so nobody else on the network can
// reconfigure the server.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { writeEnvFile } = require('./env');
const { checkUsername, checkPassword } = require('../auth/users');
const { safeEqual } = require('../auth/middleware');

const bad = (res, error, status = 400, extra) => res.status(status).json({ error, ...extra });

function validateForm(b) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const server = str(b.server);
  if (!server || server.length > 255 || /[\s\0'"]/.test(server)) return { error: 'SQL Server host is required, for example 10.0.0.5 or 10.0.0.5\\INSTANCE' };
  const portRaw = str(String(b.port === undefined || b.port === null ? '' : b.port));
  let port = 1433;
  if (portRaw) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be between 1 and 65535 (or empty)' };
  }
  const database = str(b.database) || 'ReportServer';
  if (!/^[A-Za-z0-9_]{1,100}$/.test(database)) return { error: 'Database name may only contain letters, digits and underscores' };
  const user = str(b.user);
  if (!user || user.length > 128) return { error: 'Login name is required' };
  const password = typeof b.password === 'string' ? b.password : '';
  if (!password) return { error: 'Password is required' };
  if (/[\r\n\0]/.test(password) || (password.includes("'") && password.includes('"'))) {
    return { error: 'The password cannot contain line breaks, or both single and double quotes' };
  }
  return { value: { server, port, database, user, password, trustServerCertificate: b.trustCert !== false } };
}

function createSetupApp({ envPath, templatePath, code, existingKeyOk, inspect, createDb, onApplied }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ hsts: false, contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } } }));
  app.use(express.json({ limit: '20kb' }));

  app.get('/healthz', (req, res) => res.status(503).json({ ok: false, setup: true }));
  app.get('/setup/info', (req, res) => res.json({ hasEncryptionKey: !!existingKeyOk }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' },
  });
  const gate = (req, res, next) => {
    if (!safeEqual(String((req.body || {}).code || '').trim().toUpperCase(), code)) {
      return bad(res, 'Wrong setup code. It is printed in the console where the server was started (or in logs\\out.log).', 403);
    }
    next();
  };

  app.post('/setup/test', limiter, gate, async (req, res) => {
    const f = validateForm(req.body || {});
    if (f.error) return bad(res, f.error);
    const r = await inspect(f.value);
    if (!r.ok) return bad(res, r.error, 502, { hint: r.hint });
    if (r.missingDb) {
      return res.json({ ok: true, message: req.body.createDb === false
        ? `Connected, but the database "${f.value.database}" does not exist. Tick "create it" or create it yourself.`
        : `Connected. The database "${f.value.database}" does not exist yet and will be created.`, missingDb: true, users: 0 });
    }
    res.json({ ok: true, message: `Connected. The database "${f.value.database}" exists and has ${r.users} user(s).`, users: r.users });
  });

  let applying = false;
  app.post('/setup/apply', limiter, gate, async (req, res) => {
    if (applying) return bad(res, 'Setup is already running', 409);
    applying = true;
    try {
      const body = req.body || {};
      const f = validateForm(body);
      if (f.error) return bad(res, f.error);

      let r = await inspect(f.value);
      if (!r.ok) return bad(res, r.error, 502, { hint: r.hint });
      if (r.missingDb) {
        if (body.createDb === false) return bad(res, `The database "${f.value.database}" does not exist. Tick "create it" or create it yourself.`);
        try { await createDb(f.value); } catch (e) {
          return bad(res, `Could not create the database: ${e.message}. This login may not be allowed to create databases; create it with an administrator login and try again.`, 502);
        }
        r = await inspect(f.value);
        if (!r.ok) return bad(res, r.error, 502, { hint: r.hint });
      }

      let admin = null;
      if (r.users === 0) {
        const e = checkUsername(body.adminUsername) || checkPassword(body.adminPassword);
        if (e) return bad(res, `The database has no users yet, so a first admin is needed. ${e}`);
        admin = { username: body.adminUsername, password: body.adminPassword };
      }

      // Secrets: keep what is already there. A new ENCRYPTION_KEY would make saved connection passwords unreadable.
      const updates = {
        APP_DB_SERVER: f.value.server, APP_DB_PORT: String(f.value.port), APP_DB_NAME: f.value.database,
        APP_DB_USER: f.value.user, APP_DB_PASSWORD: f.value.password, APP_DB_TRUST_CERT: String(f.value.trustServerCertificate),
      };
      const supplied = typeof body.encryptionKey === 'string' ? body.encryptionKey.trim() : '';
      if (supplied) {
        if (!/^[0-9a-fA-F]{64}$/.test(supplied)) return bad(res, 'The encryption key must be 64 hex characters');
        updates.ENCRYPTION_KEY = supplied;
      } else if (!existingKeyOk) {
        if (r.connections > 0) return bad(res, `This database already has ${r.connections} saved connection(s), which were encrypted with the original ENCRYPTION_KEY. Enter that key to continue.`);
        updates.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
      }
      if (!body.keepSessionSecret) updates.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
      writeEnvFile(envPath, templatePath, updates);

      res.on('finish', () => onApplied({ admin, newKey: !!updates.ENCRYPTION_KEY && !supplied }));
      res.json({ ok: true, users: r.users, createdAdmin: !!admin, newEncryptionKey: !!updates.ENCRYPTION_KEY && !supplied });
    } catch (e) {
      console.error('Setup failed:', e);
      bad(res, e.message || 'Setup failed', 500);
    } finally {
      applying = false;
    }
  });

  const pub = path.join(__dirname, '..', '..', 'public');
  app.get('/', (req, res) => res.redirect('/setup.html'));
  for (const f of ['setup.html', 'js/setup.js', 'js/api.js', 'css/style.css']) {
    app.get('/' + f, (req, res) => res.sendFile(path.join(pub, f)));
  }
  app.use((req, res) => res.status(404).json({ error: 'The server is in setup mode. Open /setup.html' }));
  return app;
}

function newSetupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

module.exports = { createSetupApp, newSetupCode, validateForm };
