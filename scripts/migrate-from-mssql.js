'use strict';
// Copies users (password hashes), folders, folder access and subscriptions from the old SQL Server app database
// (the Windows Server 2012 install) into this install's MariaDB app database.
//
// Run it on the new (Ubuntu) server, from the app folder, with the app's normal .env in place:
//
//   node scripts/migrate-from-mssql.js            # dry run: shows what would change, writes nothing
//   node scripts/migrate-from-mssql.js --apply    # really writes
//
// It connects to the old database at 192.168.7.222\ins (SQL Server 2016, named instance "ins") and asks for the
// SQL login and password when it starts; the password is not shown and not stored anywhere.
// Optional overrides: OLD_DB_SERVER, OLD_DB_PORT (set it if SQL Browser / UDP 1434 is blocked), OLD_DB_NAME
// (default reportserver), OLD_DB_TRUST_CERT (default true), OLD_DB_USER / OLD_DB_PASSWORD (skips the questions).
//
// Ids differ between the two databases, so rows are matched by name: users by username, folders by name, reports
// by folder + report name. It only adds or updates, never deletes, and running it twice changes nothing more.
// The old database is only read.
const { normalize, nextRun } = require('../src/subscriptions/schedule');

const key = (s) => String(s === null || s === undefined ? '' : s).trim().toLowerCase();

// src: { query(sql) -> rows } on the old SQL Server database. db: query/one on MariaDB (pass a transaction).
async function migrateData({ src, db, now = new Date(), log = () => {} }) {
  const stats = {
    users: { added: 0, passwordUpdated: 0, same: 0 },
    folders: { added: 0, same: 0 },
    folderAccess: { added: 0, same: 0, skipped: 0 },
    subscriptions: { added: 0, same: 0, skipped: 0 },
  };
  const has = (await src.query(`SELECT OBJECT_ID('subscriptions') AS subs, OBJECT_ID('folder_access') AS fa`))[0] || {};

  // --- users: same username gets the old password hash; a missing user is created as it was ---
  const users = new Map();
  for (const u of await db.query('SELECT id, username, password_hash, must_change_password FROM users')) users.set(key(u.username), u);
  for (const u of await src.query('SELECT * FROM users ORDER BY id')) {
    const mcp = !!u.must_change_password; // column is missing on very old installs
    const cur = users.get(key(u.username));
    if (!cur) {
      const r = await db.query(
        `INSERT INTO users (username, password_hash, role, disabled, must_change_password) VALUES (@username, @hash, @role, @disabled, @mcp)`,
        { username: u.username, hash: u.password_hash, role: u.role, disabled: !!u.disabled, mcp });
      users.set(key(u.username), { id: r.insertId, username: u.username });
      stats.users.added++;
      log(`user "${u.username}": created (${u.role}${u.disabled ? ', disabled' : ''})`);
    } else if (cur.password_hash !== u.password_hash || !!cur.must_change_password !== mcp) {
      await db.query('UPDATE users SET password_hash = @hash, must_change_password = @mcp WHERE id = @id', { hash: u.password_hash, mcp, id: cur.id });
      stats.users.passwordUpdated++;
      log(`user "${u.username}": password replaced with the one from the old server`);
    } else stats.users.same++;
  }

  // --- folders ---
  const folders = new Map();
  for (const f of await db.query('SELECT id, name FROM folders')) folders.set(key(f.name), f.id);
  for (const f of await src.query('SELECT name, is_system FROM folders ORDER BY id')) {
    if (folders.has(key(f.name))) { stats.folders.same++; continue; }
    const r = await db.query('INSERT INTO folders (name, is_system) VALUES (@name, @isSystem)', { name: f.name, isSystem: !!f.is_system });
    folders.set(key(f.name), r.insertId);
    stats.folders.added++;
    log(`folder "${f.name}": created`);
  }

  // --- folder access (which viewers may open a restricted folder) ---
  if (has.fa) {
    const have = new Set((await db.query('SELECT folder_id, user_id FROM folder_access')).map((a) => `${a.folder_id}:${a.user_id}`));
    const rows = await src.query(
      `SELECT f.name AS folder_name, u.username FROM folder_access a JOIN folders f ON f.id = a.folder_id JOIN users u ON u.id = a.user_id`);
    for (const a of rows) {
      const folderId = folders.get(key(a.folder_name));
      const user = users.get(key(a.username));
      if (!folderId || !user) { stats.folderAccess.skipped++; continue; }
      if (have.has(`${folderId}:${user.id}`)) { stats.folderAccess.same++; continue; }
      await db.query('INSERT INTO folder_access (folder_id, user_id) VALUES (@folderId, @userId)', { folderId, userId: user.id });
      have.add(`${folderId}:${user.id}`);
      stats.folderAccess.added++;
      log(`folder access: "${a.username}" may open "${a.folder_name}"`);
    }
  }

  // --- subscriptions (run history and saved files are not copied) ---
  if (has.subs) {
    const byPath = new Map();
    const byName = new Map();
    for (const r of await db.query('SELECT r.id, r.name, f.name AS folder_name FROM reports r JOIN folders f ON f.id = r.folder_id')) {
      byPath.set(`${key(r.folder_name)}/${key(r.name)}`, r.id);
      byName.set(key(r.name), (byName.get(key(r.name)) || []).concat(r.id));
    }
    const have = new Set((await db.query('SELECT user_id, report_id, name FROM subscriptions')).map((s) => `${s.user_id}:${s.report_id}:${key(s.name)}`));
    const rows = await src.query(
      `SELECT s.name, s.params, s.format, s.schedule, s.folder, s.enabled, u.username, r.name AS report_name, f.name AS folder_name
       FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN reports r ON r.id = s.report_id JOIN folders f ON f.id = r.folder_id
       ORDER BY s.id`);
    for (const s of rows) {
      const label = `subscription "${s.name}" of "${s.username}" (${s.folder_name}/${s.report_name})`;
      const skip = (why) => { stats.subscriptions.skipped++; log(`${label}: SKIPPED, ${why}`); };
      const user = users.get(key(s.username));
      if (!user) { skip('user not found'); continue; }
      let reportId = byPath.get(`${key(s.folder_name)}/${key(s.report_name)}`);
      if (!reportId) {
        // Same report uploaded into a different folder on the new server: accept it only when the name is unique.
        const same = byName.get(key(s.report_name)) || [];
        if (same.length !== 1) { skip(same.length ? 'report name exists in several folders, none of them matching' : 'report is not uploaded on this server'); continue; }
        reportId = same[0];
      }
      let schedule;
      try { schedule = normalize(JSON.parse(s.schedule)); JSON.parse(s.params); } catch (e) { skip(`stored schedule or parameters are not valid (${e.message})`); continue; }
      const id = `${user.id}:${reportId}:${key(s.name)}`;
      if (have.has(id)) { stats.subscriptions.same++; continue; }
      const enabled = !!s.enabled;
      await db.query(
        `INSERT INTO subscriptions (user_id, report_id, name, params, format, schedule, folder, enabled, next_run_at)
         VALUES (@userId, @reportId, @name, @params, @format, @schedule, @folder, @enabled, @next)`,
        { userId: user.id, reportId, name: s.name, params: s.params, format: s.format, schedule: JSON.stringify(schedule),
          folder: s.folder || '', enabled, next: enabled ? nextRun(schedule, now) : null });
      have.add(id);
      stats.subscriptions.added++;
      log(`${label}: created${enabled ? '' : ' (paused, as on the old server)'}`);
    }
  }
  return stats;
}

const DEFAULT_SERVER = '192.168.7.222\\ins';

// Asks for the SQL login and password on the terminal (one readline for both, so piped input also works).
// The password is not echoed.
function askLogin(needUser, needPassword) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const write = rl._writeToOutput;
  const ask = (question, hidden) => new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('No answer given.'));
    rl.once('close', onClose);
    rl.question(question, (answer) => {
      rl.removeListener('close', onClose);
      rl._writeToOutput = write;
      if (hidden) process.stdout.write('\n');
      resolve(hidden ? answer : answer.trim());
    });
    if (hidden) rl._writeToOutput = () => {}; // the prompt is already printed; swallow the typed characters
  });
  return (async () => {
    try {
      const user = needUser ? await ask('SQL Server login: ') : undefined;
      const password = needPassword ? await ask('Password: ', true) : undefined;
      return { user, password };
    } finally { rl.close(); }
  })();
}

async function main() {
  const apply = process.argv.includes('--apply');
  const env = process.env;
  const server = env.OLD_DB_SERVER || DEFAULT_SERVER;
  const database = env.OLD_DB_NAME || 'reportserver';
  console.log(`Old database: ${database} on ${server} (SQL Server). Mode: ${apply ? 'APPLY' : 'dry run'}.`);
  const typed = await askLogin(!env.OLD_DB_USER, env.OLD_DB_PASSWORD === undefined);
  const user = env.OLD_DB_USER || typed.user;
  const password = env.OLD_DB_PASSWORD !== undefined ? env.OLD_DB_PASSWORD : typed.password;
  if (!user) { console.error('A login name is needed.'); process.exit(1); }
  const sql = require('mssql');
  const { load } = require('../src/config');
  const { createDb } = require('../src/db');
  const { mssqlConnectionConfig } = require('../src/mssqlTarget');

  const pool = new sql.ConnectionPool({
    ...mssqlConnectionConfig(server, env.OLD_DB_PORT, String(env.OLD_DB_TRUST_CERT || 'true').toLowerCase() === 'true'),
    database,
    user,
    password,
    connectionTimeout: 15000,
    requestTimeout: 60000,
  });
  await pool.connect();
  const src = { query: async (text) => (await pool.request().query(text)).recordset || [] };
  const db = await createDb(load().appDb);
  const DRY = new Error('dry run');
  try {
    let stats;
    await db.transaction(async (tx) => {
      stats = await migrateData({ src, db: tx, log: (m) => console.log('  ' + m) });
      if (!apply) throw DRY; // roll everything back
    }).catch((e) => { if (e !== DRY) throw e; });
    console.log('\n' + (apply ? 'Done.' : 'DRY RUN, nothing was written. Add --apply to write.'));
    for (const [name, s] of Object.entries(stats)) console.log(`  ${name}: ${Object.entries(s).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  } finally {
    await db.close();
    await pool.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { migrateData };
