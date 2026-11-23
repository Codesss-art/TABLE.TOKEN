'use strict';

const session = require('express-session');

/**
 * SQLiteSessionStore
 * Clean, lightweight, zero-dependency SQLite session store for express-session.
 * Persists customer and owner sessions across server restarts.
 */
class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);

    // Clean up expired sessions periodically (every 15 mins)
    this.cleanupTimer = setInterval(() => {
      try {
        const now = Date.now();
        this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(now);
      } catch (_) {}
    }, 15 * 60 * 1000);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  get(sid, fn) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return fn(null, null);
      if (row.expired < Date.now()) {
        this.destroy(sid, () => {});
        return fn(null, null);
      }
      return fn(null, JSON.parse(row.sess));
    } catch (err) {
      return fn(err);
    }
  }

  set(sid, sess, fn) {
    try {
      let maxAge = 3 * 60 * 60 * 1000; // default 3 hours
      if (sess && sess.cookie && sess.cookie.maxAge) {
        maxAge = sess.cookie.maxAge;
      }
      const expired = Date.now() + maxAge;
      const json = JSON.stringify(sess);
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, json, expired);
      return fn ? fn(null) : undefined;
    } catch (err) {
      return fn ? fn(err) : undefined;
    }
  }

  destroy(sid, fn) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return fn ? fn(null) : undefined;
    } catch (err) {
      return fn ? fn(err) : undefined;
    }
  }

  touch(sid, sess, fn) {
    try {
      let maxAge = 3 * 60 * 60 * 1000;
      if (sess && sess.cookie && sess.cookie.maxAge) {
        maxAge = sess.cookie.maxAge;
      }
      const expired = Date.now() + maxAge;
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
      return fn ? fn(null) : undefined;
    } catch (err) {
      return fn ? fn(err) : undefined;
    }
  }
}

module.exports = SQLiteSessionStore;
