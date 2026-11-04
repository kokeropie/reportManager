'use strict';
// Creates the (empty) app database named in .env if it does not exist yet, using the .env login.
// The login needs the right to create databases (for example root). Usage: node scripts/create-app-database.js
const { load } = require('../src/config');
const { inspectAppDb, createDatabase } = require('../src/setup/db');

(async () => {
  const { appDb } = load();
  const r = await inspectAppDb(appDb);
  if (!r.ok) throw new Error(r.error);
  if (!r.missingDb) { console.log(`Database ${appDb.database} already exists.`); return; }
  await createDatabase(appDb);
  console.log(`Created database ${appDb.database}.`);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
