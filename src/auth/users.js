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
  return { id: r.id, username: r.username, role: r.role, disabled: !!r.disabled, mustChangePassword: !!r.must_change_password, createdAt: r.created_at };
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
      return (await db.query('SELECT id, username, role, disabled, must_change_password, created_at FROM users ORDER BY username')).map(publicUser);
    },
    async get(id) {
      return db.one('SELECT id, username, role, disabled, must_change_password, created_at FROM users WHERE id = @id', { id });
    },
    // mustChange: an admin-set password is temporary; the person picks their own at first sign-in.
    async create({ username, password, role, mustChange = false }) {
      const err = checkUsername(username) || checkPassword(password) || (ROLES.includes(role) ? null : 'Role must be admin or viewer');
      if (err) throw Object.assign(new Error(err), { status: 400 });
      const exists = await db.one('SELECT id FROM users WHERE username = @username', { username });
      if (exists) throw Object.assign(new Error('Username already exists'), { status: 409 });
      const hash = await bcrypt.hash(password, 10);
      const row = await db.one(
        `INSERT INTO users (username, password_hash, role, must_change_password)
         OUTPUT INSERTED.id, INSERTED.username, INSERTED.role, INSERTED.disabled, INSERTED.must_change_password, INSERTED.created_at
         VALUES (@username, @hash, @role, @mustChange)`,
        { username, hash, role, mustChange: !!mustChange }
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
    async setPassword(id, password, { mustChange = false } = {}) {
      const err = checkPassword(password);
      if (err) throw Object.assign(new Error(err), { status: 400 });
      await db.query('UPDATE users SET password_hash = @hash, must_change_password = @mustChange WHERE id = @id',
        { id, hash: await bcrypt.hash(password, 10), mustChange: !!mustChange });
    },
    // Self-service: needs the current password, and the new one must differ.
    async changeOwnPassword(id, current, password) {
      const row = await db.one('SELECT password_hash FROM users WHERE id = @id', { id });
      if (!row || !(await bcrypt.compare(String(current || ''), row.password_hash))) throw Object.assign(new Error('Current password is wrong'), { status: 400 });
      if (current === password) throw Object.assign(new Error('Choose a password different from the current one'), { status: 400 });
      await this.setPassword(id, password, { mustChange: false });
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
