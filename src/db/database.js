const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/webhook.db');

let db = null;

async function initDB() {
  const SQL = await initSqlJs();
  
  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createTables();
  saveDB();
  console.log('✅ Database initialized');
  return db;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 5 seconds
setInterval(saveDB, 5000);

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_types TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      max_retries INTEGER DEFAULT 5,
      timeout_ms INTEGER DEFAULT 10000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 5,
      next_retry_at TEXT,
      last_response_code INTEGER,
      last_response_body TEXT,
      last_response_time_ms INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      response_code INTEGER,
      response_body TEXT,
      response_time_ms INTEGER,
      error_message TEXT,
      attempted_at TEXT NOT NULL,
      FOREIGN KEY (delivery_id) REFERENCES deliveries(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS circuit_breakers (
      endpoint_id TEXT PRIMARY KEY,
      state TEXT DEFAULT 'closed',
      failure_count INTEGER DEFAULT 0,
      last_failure_at TEXT,
      next_attempt_at TEXT,
      FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_deliveries_endpoint ON deliveries(endpoint_id)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_attempts_delivery ON delivery_attempts(delivery_id)
  `);
}

function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Helper: run a query and return all rows as objects
function query(sql, params = []) {
  const db = getDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  saveDB();
  return rows;
}

// Helper: run insert/update/delete
function run(sql, params = []) {
  const db = getDB();
  db.run(sql, params);
  saveDB();
}

// Helper: get single row
function get(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

module.exports = { initDB, getDB, query, run, get, saveDB };
