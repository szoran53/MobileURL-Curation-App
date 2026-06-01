const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'links.db');

let db;

function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_created ON links(created_at);
    CREATE INDEX IF NOT EXISTS idx_category ON links(category);
    CREATE INDEX IF NOT EXISTS idx_status ON links(status);
  `);
  return db;
}

function getDB() {
  if (!db) initDB();
  return db;
}

module.exports = { initDB, getDB };
