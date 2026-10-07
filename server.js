'use strict';
const { load, validate } = require('./src/config');
const { createDb } = require('./src/db');
const { createApp } = require('./src/app');

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e && e.stack ? e.stack : e); process.exit(1); }); // the service manager restarts us

async function main() {
  const config = load();
  const errors = validate(config);
  if (errors.length) {
    console.error('Configuration problems (see .env.example):\n - ' + errors.join('\n - '));
    process.exit(1);
  }

  const db = await createDb(config.appDb);
  const { app, users, pools } = createApp({ db, config });

  // First start: create the initial admin from .env (a Viewer cannot do this for itself).
  if ((await users.count()) === 0) {
    if (!config.adminPassword) {
      console.error('No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env, or run: npm run create-admin');
      process.exit(1);
    }
    await users.create({ username: config.adminUsername, password: config.adminPassword, role: 'admin' });
    console.log(`Created first admin "${config.adminUsername}". Remove ADMIN_PASSWORD from .env now.`);
  }

  const server = app.listen(config.port, () => console.log(`Report server listening on port ${config.port}`));
  const shutdown = () => server.close(() => Promise.all([pools.closeAll(), db.close()]).finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
