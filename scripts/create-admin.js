'use strict';
// Usage: node scripts/create-admin.js <username> <password>
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { createUserService } = require('../src/auth/users');

(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password>');
    process.exit(1);
  }
  const db = await createDb(load().appDb);
  try {
    await createUserService(db).create({ username, password, role: 'admin' });
    console.log(`Admin "${username}" created.`);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
