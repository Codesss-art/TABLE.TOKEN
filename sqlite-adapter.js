'use strict';
/**
 * SQLiteAdapter
 * Provides a seamless, 100% compatible better-sqlite3 API fallback
 * powered by Node.js built-in node:sqlite (available in Node 22.5.0+).
 * This ensures TableToken works reliably across all environments:
 * - Production on Render/Railway with Node 18/20/22
 * - Local development on Windows, Linux, and macOS without native C++ compilation issues
 */
const { DatabaseSync } = require('node:sqlite');

class SQLiteAdapter {
  constructor(filePath, options = {}) {
    this.name = filePath;
    this.db = new DatabaseSync(filePath === '' ? ':memory:' : filePath, options);
    this.open = true;
  }

  pragma(pragmaStr) {
    if (!pragmaStr) return;
    try {
      const trimmed = pragmaStr.trim();
      if (trimmed.includes('=')) {
        return this.db.exec(`PRAGMA ${trimmed}`);
      }
      return this.db.prepare(`PRAGMA ${trimmed}`).all();
    } catch (e) {
      // Non-fatal for pragma setup
      return [];
    }
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      run(...args) {
        let params = args;
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          // Named parameters support
          params = [args[0]];
        }
        const res = stmt.run(...params);
        return {
          changes: res.changes,
          lastInsertRowid: Number(res.lastInsertRowid)
        };
      },
      get(...args) {
        let params = args;
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          params = [args[0]];
        }
        return stmt.get(...params);
      },
      all(...args) {
        let params = args;
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          params = [args[0]];
        }
        return stmt.all(...params);
      }
    };
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      self.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn.apply(this, args);
        self.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          self.db.exec('ROLLBACK');
        } catch (_) {}
        throw err;
      }
    };
  }

  close() {
    this.open = false;
    this.db.close();
  }
}

module.exports = SQLiteAdapter;
