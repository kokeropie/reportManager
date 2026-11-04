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
      .one('SELECT sess FROM sessions WHERE sid = @sid AND expires_at > UTC_TIMESTAMP(3)', { sid })
      .then((row) => cb(null, row ? JSON.parse(row.sess) : null))
      .catch(cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86400000);
    const userId = sess.userId || null;
    this.db
      .query(
        `INSERT INTO sessions (sid, sess, user_id, expires_at) VALUES (@sid, @sess, @userId, @expires)
         ON DUPLICATE KEY UPDATE sess = VALUES(sess), user_id = VALUES(user_id), expires_at = VALUES(expires_at)`,
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
    return this.db.query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
  }
}

module.exports = SqlSessionStore;
