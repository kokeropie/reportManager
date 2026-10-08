'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqlSessionStore = require('./auth/sessionStore');
const { createUserService } = require('./auth/users');
const { createAuthRouter, createUsersRouter } = require('./auth/routes');
const { requireAuth, requireAdmin, csrfProtect, requirePasswordChange } = require('./auth/middleware');
const { createConnectionService } = require('./connections/service');
const { createConnectionsRouter } = require('./connections/routes');
const { createFoldersRouter } = require('./folders/routes');
const { createReportService } = require('./reports/service');
const { createRunService } = require('./reports/runService');
const { createReportsRouter } = require('./reports/routes');
const { createAuditService } = require('./audit/service');
const { createAuditRouter } = require('./audit/routes');
const { createSubscriptionService } = require('./subscriptions/service');
const { createSubscriptionsRouter } = require('./subscriptions/routes');
const { createScheduler } = require('./subscriptions/scheduler');
const { createPools, execute } = require('./runner/pools');
const { Limiter } = require('./runner/limiter');
const { RunStore } = require('./runner/runStore');

function createApp({ db, config, execute: executeOverride, pools: poolsOverride }) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  // LAN, often plain HTTP: do not force HTTPS upgrades unless the site really is HTTPS.
  app.use(
    helmet({
      hsts: config.cookieSecure,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { 'upgrade-insecure-requests': config.cookieSecure ? [] : null },
      },
    })
  );
  // RDL uploads are JSON-wrapped files, so those two routes get a larger body limit than the rest.
  const smallJson = express.json({ limit: '100kb' });
  const bigJson = express.json({ limit: '8mb' });
  app.use((req, res, next) => (/^\/api\/(folders\/\d+\/reports|reports\/\d+\/rdl)$/.test(req.path) ? bigJson : smallJson)(req, res, next));

  const store = new SqlSessionStore(db);
  app.use(
    session({
      name: 'rs.sid',
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true, // idle timeout, not absolute (FR-2)
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionHours * 3600 * 1000,
      },
    })
  );

  const audit = createAuditService(db);
  const users = createUserService(db);
  const pools = poolsOverride || createPools({ poolSize: config.poolSize, queryTimeoutMs: config.queryTimeoutSeconds * 1000 });
  const connections = createConnectionService(db, config.encryptionKey, { onChange: (id) => pools.invalidate(id) });
  const reports = createReportService({ db, reportsDir: config.reportsDir });
  const runs = createRunService({
    reports, connections, pools, execute: executeOverride || execute,
    limiter: new Limiter(config.maxConcurrentRuns), runStore: new RunStore(), cfg: config,
  });

  const scheduler = createScheduler({ db, runs, audit, outputDir: config.outputDir, retentionDays: config.outputRetentionDays });
  const subs = createSubscriptionService({ db, reports, outputDir: config.outputDir, onChange: () => scheduler.wake() });

  // Unauthenticated liveness check for the Windows service / monitoring. Reveals nothing but up/down.
  app.get('/healthz', async (req, res) => {
    try { await db.one('SELECT 1 AS ok'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  });

  const api = express.Router();
  api.use('/auth', createAuthRouter({ users, store, db, audit }));
  // Everything below needs a session and a CSRF token on writes (FR-3).
  api.use(requireAuth, csrfProtect, requirePasswordChange);
  api.use('/users', createUsersRouter({ users, store }));
  api.use('/connections', createConnectionsRouter({ connections }));
  api.use('/folders', createFoldersRouter({ db, reports }));
  api.use('/reports', createReportsRouter({ reports, runs, cfg: config, audit }));

  api.use('/subscriptions', createSubscriptionsRouter({ subs, audit }));
  api.use('/audit', createAuditRouter({ audit }));

  // FR-2a: admin switch for "single session per user".
  api.get('/settings', requireAdmin, async (req, res, next) => {
    try {
      const s = await db.one(`SELECT value FROM settings WHERE name = 'single_session'`);
      res.json({ singleSession: !!s && s.value === 'true' });
    } catch (e) { next(e); }
  });
  api.put('/settings', requireAdmin, async (req, res, next) => {
    try {
      const v = !!(req.body || {}).singleSession;
      await db.query(`UPDATE settings SET value = @v WHERE name = 'single_session'`, { v: String(v) });
      res.json({ singleSession: v });
    } catch (e) { next(e); }
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const body = { error: status >= 500 ? 'Internal server error' : err.message };
    if (err.reportCount !== undefined) body.reportCount = err.reportCount;
    if (err.detail) body.detail = err.detail;
    if (err.details) body.details = err.details;
    res.status(status).json(body);
  });

  return { app, users, store, pools, scheduler };
}

module.exports = { createApp };
