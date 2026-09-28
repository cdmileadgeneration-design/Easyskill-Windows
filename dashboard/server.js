const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const app = express();

// ---------------------------------------------------------------------------
// Configuration (single source of truth: /config.json + environment overrides)
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[Config] Cannot read ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
}

const CFG = loadConfig();
const PORT = parseInt(process.env.PORT || CFG.dashboard?.port || 3000, 10);
const HOST = process.env.HOST || CFG.dashboard?.host || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || CFG.security?.jwtSecret;
const AGENT_KEY = process.env.AGENT_KEY || CFG.security?.agentKey;
const ADMIN_USER = process.env.ADMIN_USER || CFG.security?.adminUser || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || CFG.security?.adminPassword || 'admin';
const ADMIN_PASSWORD_HASH = CFG.security?.adminPasswordHash || '';
const SESSION_TIMEOUT = CFG.security?.sessionTimeout || 86400000;
const RETENTION_DAYS = CFG.monitoring?.dataRetentionDays || 90;
const LOGIN_LIMIT = CFG.security?.loginRateLimit || { windowMs: 60000, max: 10 };
const API_LIMIT = CFG.security?.apiRateLimit || { windowMs: 60000, max: 600 };

if (!JWT_SECRET || JWT_SECRET === 'change-this-to-secure-random-string') {
  console.warn('[Security] WARNING: weak/missing jwtSecret - set security.jwtSecret in config.json');
}
if (!AGENT_KEY) {
  console.warn('[Security] WARNING: no agent key configured - remote agents will be rejected');
}

const dbPath = path.join(ROOT, 'database', 'monitor.db');
const screenshotDir = path.join(ROOT, 'screenshots');
const auditPath = path.join(ROOT, 'database', 'audit.log');

// ---------------------------------------------------------------------------
// Database layer - one persistent in-process handle (no reload-per-query)
// ---------------------------------------------------------------------------
let SQL = null;
let db = null;
let saveTimer = null;
let dirty = false;

function persist(immediate = false) {
  dirty = true;
  if (immediate) return flushDb();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushDb();
  }, 500);
}

function flushDb() {
  if (!db || !dirty) return;
  try {
    const data = Buffer.from(db.export());
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dbPath); // atomic replace - never leaves a half-written DB
    dirty = false;
  } catch (e) {
    console.error(`[DB] Save failed: ${e.message}`);
  }
}

function queryAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  if (!db) throw new Error('database not ready');
  db.run(sql, params);
  persist();
}

// Tables/agents are allowed to insert into only these
const ALLOWED_TABLES = new Set([
  'application_usage', 'website_visits', 'file_activities', 'system_events',
  'screenshots', 'usb_devices', 'processes', 'network_connections', 'installed_software'
]);

const columnCache = new Map();
function tableColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const cols = queryAll(`PRAGMA table_info(${table})`).map(c => c.name);
  columnCache.set(table, cols);
  return cols;
}
function hasColumn(table, col) {
  return tableColumns(table).includes(col);
}
function isValidIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function ensureColumn(table, column, type = 'TEXT') {
  if (!hasColumn(table, column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    columnCache.delete(table);
    console.log(`[DB] Migration: ${table}.${column} added`);
    persist(true);
  }
}

function migrate() {
  // machine_name lets the dashboard filter per device (backwards compatible)
  for (const t of ['application_usage', 'website_visits', 'file_activities', 'system_events', 'usb_devices', 'processes', 'network_connections', 'installed_software']) {
    ensureColumn(t, 'machine_name', 'TEXT');
  }
  // key_id records exactly which key encrypted a screenshot
  ensureColumn('screenshots', 'key_id', 'TEXT');
}

function createSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS application_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT, window_title TEXT,
      exe_path TEXT, start_time DATETIME, end_time DATETIME, duration INTEGER,
      user_name TEXT, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS website_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, title TEXT, browser TEXT,
      visit_time DATETIME, duration INTEGER, user_name TEXT, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS file_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, activity_type TEXT,
      timestamp DATETIME, user_name TEXT, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, event_data TEXT,
      timestamp DATETIME, user_name TEXT, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, timestamp DATETIME,
      reason TEXT, machine_name TEXT, key_id TEXT);
    CREATE TABLE IF NOT EXISTS usb_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_name TEXT, device_id TEXT,
      event_type TEXT, timestamp DATETIME, user_name TEXT, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT, pid INTEGER,
      memory_usage INTEGER, cpu_usage REAL, timestamp DATETIME, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS network_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, local_address TEXT, remote_address TEXT,
      status TEXT, process_name TEXT, timestamp DATETIME, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS installed_software (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, version TEXT, publisher TEXT,
      install_date DATETIME, last_checked DATETIME, machine_name TEXT);
    CREATE TABLE IF NOT EXISTS agent_heartbeat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, machine_name TEXT, hostname TEXT,
      ip TEXT, agent_version TEXT, last_seen DATETIME);
    CREATE TABLE IF NOT EXISTS ingest_batches (
      batch_id TEXT PRIMARY KEY, machine_name TEXT, event_count INTEGER, received_at DATETIME);
  `);
  columnCache.clear();
}

// ---------------------------------------------------------------------------
// Retention - keeps the database from growing without bound
// ---------------------------------------------------------------------------
function purgeOldData() {
  if (!db) return;
  const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const rules = [
    ['application_usage', 'start_time', RETENTION_DAYS],
    ['website_visits', 'visit_time', RETENTION_DAYS],
    ['file_activities', 'timestamp', RETENTION_DAYS],
    ['system_events', 'timestamp', RETENTION_DAYS],
    ['usb_devices', 'timestamp', RETENTION_DAYS],
    ['installed_software', 'last_checked', RETENTION_DAYS],
    ['agent_heartbeat', 'last_seen', 30],
    ['processes', 'timestamp', 7],
    ['network_connections', 'timestamp', 7],
    ['ingest_batches', 'received_at', 7]
  ];
  let removed = 0;
  for (const [table, column, days] of rules) {
    try {
      const before = queryOne(`SELECT COUNT(*) c FROM ${table}`)?.c || 0;
      run(`DELETE FROM ${table} WHERE ${column} < ?`, [iso(days)]);
      const after = queryOne(`SELECT COUNT(*) c FROM ${table}`)?.c || 0;
      removed += before - after;
    } catch (e) { /* table may not exist yet */ }
  }

  // Screenshots: drop the row and the encrypted file together
  try {
    const stale = queryAll(`SELECT id, file_path FROM screenshots WHERE timestamp < ?`, [iso(RETENTION_DAYS)]);
    for (const row of stale) {
      try { if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch (e) {}
      run(`DELETE FROM screenshots WHERE id = ?`, [row.id]);
    }
    removed += stale.length;
  } catch (e) {}

  if (removed > 0) {
    console.log(`[Retention] Purged ${removed} expired rows`);
    persist(true);
  }
}

// ---------------------------------------------------------------------------
// Audit log (append-only trail of privileged actions)
// ---------------------------------------------------------------------------
function audit(action, detail = {}, req = null) {
  try {
    try {
      if (fs.existsSync(auditPath) && fs.statSync(auditPath).size > 5 * 1024 * 1024) {
        fs.renameSync(auditPath, auditPath + '.1');
      }
    } catch (e) {}
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      user: detail.user || (req?.user?.username ?? null),
      ip: detail.ip || req?.ip || null,
      ...detail
    });
    fs.appendFileSync(auditPath, line + '\n');
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 300000) buckets.delete(k);
}, 60000).unref();

function rateLimit(name, windowMs, max, keyFn) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    next();
  };
}
const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
    'Cache-Control': 'no-store'
  });
  next();
});
app.use(cors());
app.use(express.json({ limit: '20mb' })); // base64 screenshots need headroom
app.use(express.static(path.join(__dirname, 'public')));

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const authenticateAgent = (req, res, next) => {
  const key = req.headers['x-agent-key'];
  if (!AGENT_KEY || key !== AGENT_KEY) {
    audit('agent_rejected', { ip: ipOf(req), path: req.path }, req);
    return res.status(401).json({ error: 'Invalid agent key' });
  }
  next();
};

const apiLimiter = rateLimit('api', API_LIMIT.windowMs, API_LIMIT.max, (req) =>
  req.headers.authorization ? 't' + req.headers.authorization.slice(-12) : ipOf(req)
);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', rateLimit('login', LOGIN_LIMIT.windowMs, LOGIN_LIMIT.max, ipOf), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  let ok = false;
  try {
    if (ADMIN_PASSWORD_HASH) {
      ok = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH) && username === ADMIN_USER;
    } else {
      ok = username === ADMIN_USER && password === ADMIN_PASSWORD;
    }
  } catch (e) {
    ok = false;
  }

  if (!ok) {
    audit('login_failed', { user: username, ip: ipOf(req) }, req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: SESSION_TIMEOUT / 1000 });
  audit('login_success', { user: username, ip: ipOf(req) }, req);
  res.json({ token, user: { username, role: 'admin' }, expiresIn: SESSION_TIMEOUT });
});

app.get('/api/audit', authenticate, (req, res) => {
  try {
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    res.json(lines.slice(-200).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean));
  } catch (e) {
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// Shared query helpers - machine filter matches new rows (machine_name)
// and legacy rows (user_name prefixed as "HOSTNAME\user")
// ---------------------------------------------------------------------------
function machineClause(machine_name, column = 'user_name') {
  if (!machine_name) return { sql: '', params: [] };
  return { sql: ` AND (machine_name = ? OR ${column} LIKE ?)`, params: [machine_name, `${machine_name}\\%`] };
}

// ---------------------------------------------------------------------------
// Read APIs (dashboard)
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), db: !!db });
});

app.get('/api/stats/applications', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT process_name, window_title, SUM(duration) as total_duration, COUNT(*) as usage_count FROM application_usage WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND start_time >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND end_time <= ?'; params.push(endDate); }
  if (user) { query += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
  query += mc.sql; params.push(...mc.params);
  query += ' GROUP BY process_name ORDER BY total_duration DESC';
  res.json(queryAll(query, params));
});

app.get('/api/stats/applications/raw', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT id, process_name, window_title, exe_path, start_time, end_time, duration, user_name, machine_name FROM application_usage WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND start_time >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND end_time <= ?'; params.push(endDate); }
  if (user) { query += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY start_time ASC LIMIT 20000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/websites', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT url, title, browser, COUNT(*) as visit_count, SUM(duration) as total_duration FROM website_visits WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND visit_time >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND visit_time <= ?'; params.push(endDate); }
  if (user) { query += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
  query += mc.sql; params.push(...mc.params);
  query += ' GROUP BY url ORDER BY visit_count DESC LIMIT 2000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/websites/raw', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT id, url, title, browser, visit_time, duration, user_name, machine_name FROM website_visits WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND visit_time >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND visit_time <= ?'; params.push(endDate); }
  if (user) { query += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY visit_time ASC LIMIT 20000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/files', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, user, activityType, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT file_path, activity_type, timestamp, user_name, machine_name FROM file_activities WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  if (user) { query += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
  if (activityType) { query += ' AND activity_type = ?'; params.push(activityType); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY timestamp DESC LIMIT 1000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/events', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, eventType, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT event_type, event_data, timestamp, machine_name FROM system_events WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  if (eventType) { query += ' AND event_type = ?'; params.push(eventType); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY timestamp DESC LIMIT 1000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/events/raw', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT id, event_type, event_data, timestamp, machine_name FROM system_events WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY timestamp ASC LIMIT 20000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/usb', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT device_name, device_id, event_type, timestamp, machine_name FROM usb_devices WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY timestamp DESC LIMIT 1000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/usb/raw', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  const mc = machineClause(machine_name);
  let query = `SELECT id, device_name, device_id, event_type, timestamp, user_name, machine_name FROM usb_devices WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  query += mc.sql; params.push(...mc.params);
  query += ' ORDER BY timestamp ASC LIMIT 20000';
  res.json(queryAll(query, params));
});

app.get('/api/stats/processes', apiLimiter, authenticate, (req, res) => {
  const { timestamp, machine_name } = req.query;
  let query = `SELECT process_name, pid, memory_usage, cpu_usage, timestamp, machine_name FROM processes WHERE 1=1`;
  const params = [];
  if (timestamp) { query += ' AND timestamp >= ?'; params.push(timestamp); }
  if (machine_name) { query += ' AND machine_name = ?'; params.push(machine_name); }
  query += ' ORDER BY timestamp DESC LIMIT 500';
  res.json(queryAll(query, params));
});

app.get('/api/stats/network', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  let query = `SELECT local_address, remote_address, status, process_name, timestamp, machine_name FROM network_connections WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  if (machine_name) { query += ' AND machine_name = ?'; params.push(machine_name); }
  query += ' ORDER BY timestamp DESC LIMIT 1000';
  res.json(queryAll(query, params));
});

app.get('/api/dashboard/summary', apiLimiter, authenticate, (req, res) => {
  const { date, machine_name } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const mc = machineClause(machine_name);

  const appUsage = queryOne(`SELECT COUNT(DISTINCT process_name) as unique_apps, COALESCE(SUM(duration),0) as total_active_time FROM application_usage WHERE DATE(start_time) = ?${mc.sql}`, [targetDate, ...mc.params]);
  const websiteVisits = queryOne(`SELECT COUNT(DISTINCT url) as unique_sites, COUNT(*) as total_visits FROM website_visits WHERE DATE(visit_time) = ?${mc.sql}`, [targetDate, ...mc.params]);
  const fileActivities = queryOne(`SELECT SUM(CASE WHEN activity_type='create' THEN 1 ELSE 0 END) as files_created, SUM(CASE WHEN activity_type='delete' THEN 1 ELSE 0 END) as files_deleted, SUM(CASE WHEN activity_type='modify' THEN 1 ELSE 0 END) as files_modified FROM file_activities WHERE DATE(timestamp) = ?${mc.sql}`, [targetDate, ...mc.params]);
  const usbEvents = queryOne(`SELECT COUNT(*) as total_events FROM usb_devices WHERE DATE(timestamp) = ?${mc.sql}`, [targetDate, ...mc.params]);
  const screenshots = queryOne(
    `SELECT COUNT(*) as total_screenshots FROM screenshots WHERE DATE(timestamp) = ?${machine_name ? ' AND machine_name = ?' : ''}`,
    machine_name ? [targetDate, machine_name] : [targetDate]
  );
  const idle = queryOne(`SELECT COUNT(*) as idle_events FROM system_events WHERE DATE(timestamp) = ? AND event_type = 'idle_start'${mc.sql}`, [targetDate, ...mc.params]);

  res.json({
    date: targetDate,
    machine: machine_name || 'all',
    applications: appUsage,
    websites: websiteVisits,
    files: fileActivities,
    usb: usbEvents,
    screenshots: screenshots,
    idle: idle
  });
});

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
function deriveKey(keyId) {
  return crypto.scryptSync(String(keyId), 'monitoring-salt', 32);
}

function decryptScreenshot(row) {
  const data = fs.readFileSync(row.file_path);
  const iv = data.slice(0, 16);
  const payload = data.slice(16);
  // Try the recorded key first, then legacy fallbacks for old records
  const candidates = [row.key_id, row.machine_name, row.machine_name && `${row.machine_name}${os.userInfo().username}`].filter(Boolean);
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(candidate), iv);
      return Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Unable to decrypt screenshot');
}

function loadScreenshotRow(id) {
  const row = queryOne(`SELECT id, file_path, machine_name, key_id FROM screenshots WHERE id = ?`, [parseInt(id, 10)]);
  if (!row) return null;
  if (!row.file_path || !fs.existsSync(row.file_path)) return { missing: true };
  return row;
}

app.get('/api/screenshots', apiLimiter, authenticate, (req, res) => {
  const { startDate, endDate, reason, machine_name } = req.query;
  let query = `SELECT id, file_path, timestamp, reason, machine_name FROM screenshots WHERE 1=1`;
  const params = [];
  if (startDate) { query += ' AND timestamp >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND timestamp <= ?'; params.push(endDate); }
  if (reason) { query += ' AND reason = ?'; params.push(reason); }
  if (machine_name) { query += ' AND machine_name = ?'; params.push(machine_name); }
  query += ' ORDER BY timestamp DESC LIMIT 100';
  res.json(queryAll(query, params));
});

function screenshotTokenGuard(req, res) {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  try { jwt.verify(token, JWT_SECRET); return true; }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); return false; }
}

app.get('/api/screenshots/base64/:id', (req, res) => {
  if (!screenshotTokenGuard(req, res)) return;
  const row = loadScreenshotRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Screenshot not found' });
  if (row.missing) return res.status(404).json({ error: 'File not found' });
  try {
    res.json({ image: decryptScreenshot(row).toString('base64') });
  } catch (e) {
    res.status(500).json({ error: 'Decryption failed' });
  }
});

app.get('/api/screenshots/image/:id', (req, res) => {
  if (!screenshotTokenGuard(req, res)) return;
  const row = loadScreenshotRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Screenshot not found' });
  if (row.missing) return res.status(404).json({ error: 'File not found' });
  try {
    const image = decryptScreenshot(row);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length });
    res.end(image);
  } catch (e) {
    res.status(500).json({ error: 'Decryption failed' });
  }
});

function encryptBuffer(buf, keyId) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(keyId), iv);
  return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
}

function saveScreenshotRecord({ buffer, timestamp, reason, machineName, keyId, encrypted = false }) {
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  const safeMachine = String(machineName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = String(timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const filePath = path.join(screenshotDir, `${safeMachine}_screenshot_${ts}.enc`);
  const payload = encrypted ? buffer : encryptBuffer(buffer, keyId);
  fs.writeFileSync(filePath, payload);
  run(`INSERT INTO screenshots (file_path, timestamp, reason, machine_name, key_id) VALUES (?, ?, ?, ?, ?)`,
    [filePath, timestamp || new Date().toISOString(), reason || 'scheduled', machineName, keyId]);
  return filePath;
}

app.post('/api/screenshots/capture', apiLimiter, authenticate, (req, res) => {
  const { exec } = require('child_process');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpFile = path.join(os.tmpdir(), `capture_${timestamp}.jpg`);
  const keyId = os.hostname() + os.userInfo().username;

  const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${tmpFile.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;

  exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000 }, (err) => {
    if (err || !fs.existsSync(tmpFile)) return res.status(500).json({ error: 'Screenshot failed' });
    try {
      const buf = fs.readFileSync(tmpFile);
      saveScreenshotRecord({ buffer: buf, timestamp, reason: 'manual', machineName: os.hostname(), keyId });
      audit('screenshot_capture', { by: req.user.username, ip: ipOf(req) }, req);
      res.json({ success: true, timestamp });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// Remote agent ingest API
// ---------------------------------------------------------------------------
app.post('/api/agent/events', authenticateAgent, rateLimit('agent', 60000, 1200, ipOf), (req, res) => {
  const { events, machine_name, batch_id } = req.body || {};
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  if (events.length > 500) return res.status(400).json({ error: 'batch too large (max 500)' });

  // Exactly-once: a retried batch (lost response, agent restart) is acknowledged
  // again but never inserted twice.
  if (batch_id) {
    try {
      const seen = queryOne(`SELECT batch_id FROM ingest_batches WHERE batch_id = ?`, [batch_id]);
      if (seen) return res.json({ success: true, inserted: 0, duplicate: true });
    } catch (e) { /* table missing - fall through */ }
  }

  let inserted = 0;
  const errors = [];
  for (const raw of events) {
    const evt = { ...raw };
    const table = evt._table;
    delete evt._table;
    if (!table || !ALLOWED_TABLES.has(table)) { errors.push(`bad table: ${table}`); continue; }

    if (machine_name) {
      if (evt.user_name) evt.user_name = `${machine_name}\\${evt.user_name}`;
      if (hasColumn(table, 'machine_name')) evt.machine_name = machine_name;
    }
    delete evt.id; // let AUTOINCREMENT assign ids

    const columns = Object.keys(evt).filter(c => isValidIdentifier(c) && hasColumn(table, c));
    if (!columns.length) continue;
    const values = columns.map(c => evt[c]);
    try {
      run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
      inserted++;
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (batch_id) {
    try {
      run(`INSERT OR REPLACE INTO ingest_batches (batch_id, machine_name, event_count, received_at) VALUES (?, ?, ?, ?)`,
        [batch_id, machine_name || '', inserted, new Date().toISOString()]);
    } catch (e) { errors.push(e.message); }
  }

  flushDb();
  if (errors.length) console.warn(`[Agent] ingest issues: ${errors.slice(0, 3).join('; ')}`);
  res.json({ success: true, inserted, errors: errors.slice(0, 10) });
});

// Legacy single-event endpoint (kept for backwards compatibility)
app.post('/api/agent/event', authenticateAgent, (req, res) => {
  const { table, data, machine_name } = req.body || {};
  if (!table || !data) return res.status(400).json({ error: 'table and data required' });
  if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'table not allowed' });
  const evt = { ...data };
  delete evt.id;
  if (machine_name) {
    if (evt.user_name) evt.user_name = `${machine_name}\\${evt.user_name}`;
    if (hasColumn(table, 'machine_name')) evt.machine_name = machine_name;
  }
  const columns = Object.keys(evt).filter(c => isValidIdentifier(c) && hasColumn(table, c));
  if (!columns.length) return res.status(400).json({ error: 'no valid columns' });
  try {
    run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(c => evt[c]));
    flushDb();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent/screenshot', authenticateAgent, rateLimit('agent-ss', 60000, 120, ipOf), (req, res) => {
  const { machine_name, image_data, timestamp, reason, key_id } = req.body || {};
  if (!image_data || !machine_name) return res.status(400).json({ error: 'image_data and machine_name required' });

  try {
    const buffer = Buffer.from(image_data, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'empty image payload' });
    if (buffer.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'image too large' });
    // Agent already encrypted it; key_id tells us how to decrypt it later
    saveScreenshotRecord({ buffer, timestamp, reason, machineName: machine_name, keyId: key_id || machine_name, encrypted: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent/heartbeat', authenticateAgent, (req, res) => {
  const { machine_name, hostname, ip, agent_version } = req.body || {};
  if (!machine_name) return res.status(400).json({ error: 'machine_name required' });
  try {
    db.run(`CREATE TABLE IF NOT EXISTS agent_heartbeat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, machine_name TEXT, hostname TEXT,
      ip TEXT, agent_version TEXT, last_seen DATETIME)`);
    const existing = queryOne(`SELECT id FROM agent_heartbeat WHERE machine_name = ?`, [machine_name]);
    if (existing) {
      run(`UPDATE agent_heartbeat SET hostname=?, ip=?, agent_version=?, last_seen=CURRENT_TIMESTAMP WHERE machine_name=?`,
        [hostname || '', ip || '', agent_version || '', machine_name]);
    } else {
      run(`INSERT INTO agent_heartbeat (machine_name, hostname, ip, agent_version, last_seen) VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
        [machine_name, hostname || '', ip || '', agent_version || '']);
    }
    res.json({ success: true, status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fleet / machine listing
// ---------------------------------------------------------------------------
app.get('/api/agents', apiLimiter, authenticate, (req, res) => {
  try {
    res.json(queryAll(`SELECT machine_name, hostname, ip, agent_version, last_seen FROM agent_heartbeat ORDER BY last_seen DESC`));
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/machines', apiLimiter, authenticate, (req, res) => {
  try {
    const localMachine = os.hostname();
    const agents = queryAll(`SELECT machine_name, hostname, ip, agent_version, last_seen FROM agent_heartbeat ORDER BY last_seen DESC`);
    const machines = agents.map(a => ({
      machine_name: a.machine_name,
      hostname: a.hostname,
      ip: a.ip,
      agent_version: a.agent_version,
      last_seen: a.last_seen,
      is_local: a.machine_name === localMachine
    }));
    if (!machines.some(m => m.machine_name === localMachine)) {
      machines.unshift({
        machine_name: localMachine, hostname: localMachine, ip: '127.0.0.1',
        agent_version: CFG.app?.version || '1.0.0',
        last_seen: queryOne(`SELECT MAX(start_time) as last_seen FROM application_usage`)?.last_seen || null,
        is_local: true
      });
    }
    res.json(machines);
  } catch (e) {
    res.json([{ machine_name: os.hostname(), hostname: os.hostname(), ip: '127.0.0.1', agent_version: '1.0.0', last_seen: null, is_local: true }]);
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
app.post('/api/admin/cleanup-file-activities', apiLimiter, authenticate, (req, res) => {
  try {
    run(`DELETE FROM file_activities WHERE file_path LIKE '%monitor.db%' OR file_path LIKE '%windows monitoring software%'`);
    audit('cleanup_file_activities', { by: req.user.username }, req);
    persist(true);
    res.json({ success: true, remaining: queryOne('SELECT COUNT(*) as c FROM file_activities')?.c || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/purge-retention', apiLimiter, authenticate, (req, res) => {
  purgeOldData();
  audit('purge_retention', { by: req.user.username }, req);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  SQL = await initSqlJs();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  createSchema();
  migrate();
  purgeOldData();
  persist(true);

  setInterval(purgeOldData, 3600000).unref();
  setInterval(() => flushDb(), 15000).unref();

  app.listen(PORT, HOST, () => {
    console.log(`[Dashboard] Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`[Dashboard] Login: ${ADMIN_USER} / ${ADMIN_PASSWORD_HASH ? '<hashed>' : ADMIN_PASSWORD}`);
    if (ADMIN_USER === 'admin' && ADMIN_PASSWORD === 'admin') {
      console.log('[Security] WARNING: default admin/admin credentials in use. Change them in config.json (security.adminUser / adminPassword) or run: node dashboard/set-password.js');
    }
    if (ADMIN_PASSWORD === 'admin') {
      console.log('[Security] WARNING: dashboard is exposed on the network with a default password.');
    }
  });
}

const shutdown = () => {
  flushDb();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { flushDb(); } catch (e) {} });

start().catch((err) => {
  console.error('[Dashboard] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
