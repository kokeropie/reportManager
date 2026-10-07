'use strict';
const { encrypt, decrypt } = require('../crypto');

// The browser never receives password_enc or the plaintext password (FR-5): only hasPassword.
function publicConnection(r, reportCount) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    host: r.host,
    port: r.port,
    database: r.database_name,
    username: r.username,
    trustServerCert: !!r.trust_server_cert,
    hasPassword: !!r.password_enc,
    reportCount: reportCount === undefined ? undefined : reportCount,
    updatedAt: r.updated_at,
  };
}

function createConnectionService(db, encryptionKey, { onChange } = {}) {
  const changed = (id) => { if (onChange) onChange(id); };
  const conflict = () => Object.assign(new Error('A connection with that name already exists'), { status: 409 });

  return {
    async list() {
      const rows = await db.query(
        `SELECT c.*, (SELECT COUNT(*) FROM reports r WHERE r.connection_id = c.id) AS report_count
         FROM connections c ORDER BY c.name`
      );
      return rows.map((r) => publicConnection(r, r.report_count));
    },
    async get(id) {
      const r = await db.one('SELECT * FROM connections WHERE id = @id', { id });
      return r ? publicConnection(r) : null;
    },
    // Plaintext password is only ever produced here, for the driver. Never send the result to a client.
    async getWithSecret(id) {
      const r = await db.one('SELECT * FROM connections WHERE id = @id', { id });
      if (!r) return null;
      return {
        id: r.id, updatedAt: String(r.updated_at && r.updated_at.getTime ? r.updated_at.getTime() : r.updated_at),
        type: r.type, host: r.host, port: r.port, database: r.database_name,
        username: r.username, trustServerCert: !!r.trust_server_cert,
        password: decrypt(r.password_enc, encryptionKey),
      };
    },
    async create(v) {
      if (await db.one('SELECT id FROM connections WHERE name = @name', { name: v.name })) throw conflict();
      const row = await db.one(
        `INSERT INTO connections (name, type, host, port, database_name, username, password_enc, trust_server_cert)
         OUTPUT INSERTED.*
         VALUES (@name, @type, @host, @port, @database, @username, @pw, @trust)`,
        { ...v, pw: encrypt(v.password, encryptionKey), trust: v.trustServerCert }
      );
      return publicConnection(row, 0);
    },
    async update(id, v) {
      const dup = await db.one('SELECT id FROM connections WHERE name = @name AND id <> @id', { name: v.name, id });
      if (dup) throw conflict();
      await db.query(
        `UPDATE connections SET name=@name, type=@type, host=@host, port=@port, database_name=@database,
           username=@username, trust_server_cert=@trust,
           password_enc = COALESCE(@pw, password_enc), updated_at = SYSUTCDATETIME()
         WHERE id=@id`,
        { id, ...v, trust: v.trustServerCert, pw: v.password ? encrypt(v.password, encryptionKey) : null }
      );
      changed(id);
    },
    async reportCount(id) {
      return (await db.one('SELECT COUNT(*) AS n FROM reports WHERE connection_id = @id', { id })).n;
    },
    // FR-7: refuse while reports use it, unless the caller confirms detaching them.
    async remove(id, { detach }) {
      const n = await this.reportCount(id);
      if (n > 0 && !detach) {
        throw Object.assign(new Error(`${n} report(s) use this connection. Confirm to detach them and delete.`), { status: 409, reportCount: n });
      }
      await db.query('UPDATE reports SET connection_id = NULL WHERE connection_id = @id', { id });
      await db.query('DELETE FROM connections WHERE id = @id', { id });
      changed(id);
    },
  };
}

module.exports = { createConnectionService, publicConnection };
