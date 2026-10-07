'use strict';
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'viewer'];
const MIN_PASSWORD = 8;
// Compared against when the username is unknown, so response time does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 72) return 'Password must be at most 72 characters';
  return null;
}

function checkUsername(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._@-]{3,100}$/.test(name)) {
    return 'Username must be 3-100 characters: letters, digits, . _ @ -';
  }
  return null;
}

function publicUser(r) {
  return { id: r.id, username: r.username, role: r.role, disabled: !!r.disabled, createdAt: r.created_at };
}

function createUserService(db) {
  return {
    async authenticate(username, password) {
      const user = await db.one('SELECT * FROM users WHERE username = @username', { username: String(username || '') });
      const ok = await bcrypt.compare(String(password || ''), user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok || user.disabled) return null;
      return user;
    },
    async list() {
      return (await db.query('SELECT id, username, role, disabled, created_at FROM users ORDER BY username')).map(publicUser);
    },
    async get(id) {
      return db.one('SELECT id, username, role, disabled, created_at FROM users WHERE id = @id', { id });
    },
    async create({ username, password, role }) {
      const err = checkUsername(username) || checkPassword(password) || (ROLES.includes(role) ? null : 'Role must be admin or viewer');
      if (err) throw Object.assign(new Error(err), { status: 400 });
      const exists = await db.one('SELECT id FROM users WHERE username = @username', { username });
      if (exists) throw Object.assign(new Error('Username already exists'), { status: 409 });
      const hash = await bcrypt.hash(password, 10);
      const row = await db.one(
        `INSERT INTO users (username, password_hash, role) OUTPUT INSERTED.id, INSERTED.username, INSERTED.role, INSERTED.disabled, INSERTED.created_at
         VALUES (@username, @hash, @role)`,
        { username, hash, role }
      );
      return publicUser(row);
    },
    async update(id, { role, disabled }) {
      if (role !== undefined && !ROLES.includes(role)) throw Object.assign(new Error('Role must be admin or viewer'), { status: 400 });
      await db.query(
        'UPDATE users SET role = COALESCE(@role, role), disabled = COALESCE(@disabled, disabled) WHERE id = @id',
        { id, role: role === undefined ? null : role, disabled: disabled === undefined ? null : !!disabled }
      );
    },
    async setPassword(id, password) {
      const err = checkPassword(password);
      if (err) throw Object.assign(new Error(err), { status: 400 });
      await db.query('UPDATE users SET password_hash = @hash WHERE id = @id', { id, hash: await bcrypt.hash(password, 10) });
    },
    async countActiveAdmins() {
      return (await db.one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`)).n;
    },
    async count() {
      return (await db.one('SELECT COUNT(*) AS n FROM users')).n;
    },
  };
}

module.exports = { createUserService, checkPassword, checkUsername, MIN_PASSWORD };
