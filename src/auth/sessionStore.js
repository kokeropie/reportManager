'use strict';
const session = require('express-session');

// express-session store backed by the app database (sessions table).
class SqlSessionStore extends session.Store {
  constructor(db, { cleanupMinutes = 15 } = {}) {
    super();
    this.db = db;
    this.timer = setInterval(() => this.cleanup().catch(() => {}), cleanupMinutes * 60 * 1000);
    this.timer.unref();
  }

  get(sid, cb) {
    this.db
      .one('SELECT sess FROM sessions WHERE sid = @sid AND expires_at > SYSUTCDATETIME()', { sid })
      .then((row) => cb(null, row ? JSON.parse(row.sess) : null))
      .catch(cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86400000);
    const userId = sess.userId || null;
    this.db
      .query(
        `MERGE sessions AS t USING (SELECT @sid AS sid) AS s ON t.sid = s.sid
         WHEN MATCHED THEN UPDATE SET sess = @sess, user_id = @userId, expires_at = @expires
         WHEN NOT MATCHED THEN INSERT (sid, sess, user_id, expires_at) VALUES (@sid, @sess, @userId, @expires);`,
        { sid, sess: JSON.stringify(sess), userId, expires }
      )
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86400000);
    this.db
      .query('UPDATE sessions SET expires_at = @expires WHERE sid = @sid', { sid, expires })
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }

  destroy(sid, cb) {
    this.db
      .query('DELETE FROM sessions WHERE sid = @sid', { sid })
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }

  destroyForUser(userId, exceptSid) {
    return this.db.query('DELETE FROM sessions WHERE user_id = @userId AND (@except IS NULL OR sid <> @except)', {
      userId,
      except: exceptSid || null,
    });
  }

  cleanup() {
    return this.db.query('DELETE FROM sessions WHERE expires_at <= SYSUTCDATETIME()');
  }
}

module.exports = SqlSessionStore;
