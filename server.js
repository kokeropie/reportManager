'use strict';
const path = require('path');
const { load, validate, envPath, freshEnv } = require('./src/config');
const { createDb } = require('./src/db');
const { createApp } = require('./src/app');

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e && e.stack ? e.stack : e); process.exit(1); }); // the service manager restarts us

// Runs the setup site until the user finishes it. Resolves with the first admin to create (if any).
function runSetup(config, reason) {
  const http = require('http');
  const { createSetupApp, newSetupCode } = require('./src/setup/server');
  const { inspectAppDb, createDatabase } = require('./src/setup/db');
  const code = newSetupCode();
  const keyOk = /^[0-9a-fA-F]{64}$/.test(freshEnv().ENCRYPTION_KEY || '');

  return new Promise((resolve) => {
    const sockets = new Set();
    let server;
    const app = createSetupApp({
      envPath,
      templatePath: path.join(__dirname, '.env.example'),
      code,
      existingKeyOk: keyOk,
      inspect: inspectAppDb,
      createDb: createDatabase,
      onApplied: (result) => {
        server.close(() => resolve(result));
        for (const s of sockets) s.destroy(); // keep-alive connections would hold the port
      },
    });
    server = http.createServer(app);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(config.port, () => {
      console.log('');
      console.log('==================================================================');
      console.log(` SETUP MODE (${reason})`);
      console.log(` Open  http://localhost:${config.port}  in a browser`);
      console.log(` Setup code:  ${code}`);
      console.log('==================================================================');
      console.log('');
    });
  });
}

async function main() {
  let config = load();
  let admin = null;

  const forced = process.argv.includes('--setup') || process.env.SETUP_MODE === '1';
  const problems = validate(config);
  if (forced || problems.length) {
    const reason = forced ? 'requested with --setup' : 'configuration incomplete: ' + problems.join('; ');
    const result = await runSetup(config, reason);
    config = load(freshEnv());
    admin = result.admin;
    console.log('Setup saved. Starting the app...');
  }

  const errors = validate(config);
  if (errors.length) {
    console.error('Configuration problems (see .env.example):\n - ' + errors.join('\n - '));
    process.exit(1);
  }

  let db;
  try {
    db = await createDb(config.appDb);
  } catch (e) {
    console.error(`Could not connect to the app database: ${e.message}`);
    console.error('Fix .env, or run   node server.js --setup   to open the setup page and enter the details in a browser.');
    process.exit(1);
  }
  const { app, users, pools, scheduler } = createApp({ db, config });

  // First start: create the initial admin (from the setup page, or from .env).
  if ((await users.count()) === 0) {
    const username = admin ? admin.username : config.adminUsername;
    const password = admin ? admin.password : config.adminPassword;
    if (!password) {
      console.error('No users exist. Run `node server.js --setup`, or set ADMIN_USERNAME and ADMIN_PASSWORD in .env, or run: npm run create-admin');
      process.exit(1);
    }
    await users.create({ username, password, role: 'admin' });
    console.log(`Created first admin "${username}".${admin ? '' : ' Remove ADMIN_PASSWORD from .env now.'}`);
  }

  const server = app.listen(config.port, () => console.log(`Report server listening on port ${config.port}`));
  if (config.schedulerEnabled) { scheduler.start(); console.log('Scheduler started'); }
  const shutdown = () => { scheduler.stop(); server.close(() => Promise.all([pools.closeAll(), db.close()]).finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
