const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'links.db');

let db;

function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      category TEXT,
      tags TEXT DEFAULT '[]',
      source TEXT DEFAULT 'web',
      note TEXT,
      read INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error_msg TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_created ON links(created_at);
    CREATE INDEX IF NOT EXISTS idx_category ON links(category);
    CREATE INDEX IF NOT EXISTS idx_status ON links(status);
  `);
  // Add error_msg column if upgrading from older schema
  try { db.exec(`ALTER TABLE links ADD COLUMN error_msg TEXT`); } catch (_) {}
  return db;
}

function getDB() {
  if (!db) initDB();
  return db;
}

module.exports = { initDB, getDB };
