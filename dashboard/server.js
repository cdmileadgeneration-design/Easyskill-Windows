const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CFG = require('./config');
const { createDatastore } = require('./lib/db');
const { createStorage } = require('./lib/storage');

const app = express();

// ---------------------------------------------------------------------------
// Configuration (.env + config.json, see config.js for precedence)
// ---------------------------------------------------------------------------
const PORT = CFG.dashboard.port;
const HOST = CFG.dashboard.host;
const { jwtSecret: JWT_SECRET, agentKey: AGENT_KEY } = CFG.security;
const ADMIN_USER = CFG.security.adminUser;
const ADMIN_PASSWORD = CFG.security.adminPassword;
const ADMIN_PASSWORD_HASH = CFG.security.adminPasswordHash;
const SESSION_TIMEOUT = CFG.security.sessionTimeout;
const RETENTION_DAYS = CFG.monitoring.dataRetentionDays;
const LOGIN_LIMIT = CFG.security.loginRateLimit;
const API_LIMIT = CFG.security.apiRateLimit;

if (!CFG.configExists) {
  console.warn(`[Config] ${CFG.CONFIG_PATH} not found - using .env / defaults. Run setup.bat to generate it.`);
}
if (!JWT_SECRET || JWT_SECRET === 'change-this-to-secure-random-string') {
  console.warn('[Security] WARNING: weak/missing jwtSecret - set security.jwtSecret in config.json or JWT_SECRET in .env');
}
if (!AGENT_KEY) {
  console.warn('[Security] WARNING: no agent key configured - remote agents will be rejected');
}

let db = null;        // datastore (mongodb | sqlite) - assigned in start()
let storage = null;   // storage adapter (cloudinary | s3 | local) - assigned in start()

// ---------------------------------------------------------------------------
// Audit log (append-only trail of privileged actions)
// ---------------------------------------------------------------------------
async function audit(action, detail = {}, req = null) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    user: detail.user || (req?.user?.username ?? null),
    ip: detail.ip || req?.ip || null,
    ...detail
  };
  if (db) return db.appendAudit(entry);
  try {
    const fs = require('fs');
    fs.appendFileSync(CFG.database.auditPath, JSON.stringify(entry) + '\n');
  } catch (e) { /* never break a request because of auditing */ }
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

// async route wrapper - thrown errors are forwarded to the error middleware
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

app.get('/api/audit', authenticate, h(async (req, res) => {
  res.json(await db.listAudit(200));
}));

// ---------------------------------------------------------------------------
// Read APIs (dashboard)
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: db?.ready ? db.name : false,
    storage: storage?.name || false
  });
});

app.get('/api/stats/applications', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  res.json(await db.listApplications({ startDate, endDate, user, machineName: machine_name }));
}));

app.get('/api/stats/applications/raw', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  res.json(await db.listApplications({ startDate, endDate, user, machineName: machine_name, raw: true }));
}));

app.get('/api/stats/websites', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  res.json(await db.listWebsites({ startDate, endDate, user, machineName: machine_name }));
}));

app.get('/api/stats/websites/raw', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, user, machine_name } = req.query;
  res.json(await db.listWebsites({ startDate, endDate, user, machineName: machine_name, raw: true }));
}));

app.get('/api/stats/files', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, user, activityType, machine_name } = req.query;
  res.json(await db.listFiles({ startDate, endDate, user, activityType, machineName: machine_name }));
}));

app.get('/api/stats/events', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, eventType, machine_name } = req.query;
  res.json(await db.listEvents({ startDate, endDate, eventType, machineName: machine_name }));
}));

app.get('/api/stats/events/raw', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  res.json(await db.listEvents({ startDate, endDate, machineName: machine_name, raw: true }));
}));

app.get('/api/stats/usb', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  res.json(await db.listUsb({ startDate, endDate, machineName: machine_name }));
}));

app.get('/api/stats/usb/raw', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  res.json(await db.listUsb({ startDate, endDate, machineName: machine_name, raw: true }));
}));

app.get('/api/stats/processes', apiLimiter, authenticate, h(async (req, res) => {
  const { timestamp, machine_name } = req.query;
  res.json(await db.listProcesses({ timestamp, machineName: machine_name }));
}));

app.get('/api/stats/network', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, machine_name } = req.query;
  res.json(await db.listNetwork({ startDate, endDate, machineName: machine_name }));
}));

app.get('/api/dashboard/summary', apiLimiter, authenticate, h(async (req, res) => {
  const { date, machine_name } = req.query;
  res.json(await db.summary({ date, machineName: machine_name }));
}));

// ---------------------------------------------------------------------------
// Screenshots (encrypted at rest, stored through the storage adapter)
// ---------------------------------------------------------------------------
function deriveKey(keyId) {
  return crypto.scryptSync(String(keyId), 'monitoring-salt', 32);
}

function encryptBuffer(buf, keyId) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(keyId), iv);
  return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
}

function decryptBuffer(payload, row) {
  const iv = payload.slice(0, 16);
  const body = payload.slice(16);
  // Try the recorded key first, then legacy fallbacks for old records
  const candidates = [row.key_id, row.machine_name, row.machine_name && `${row.machine_name}${os.userInfo().username}`].filter(Boolean);
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(candidate), iv);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Unable to decrypt screenshot');
}

async function readScreenshotBuffer(row) {
  if (!row?.storage) {
    const err = new Error('storage reference missing');
    err.notFound = true;
    throw err;
  }
  return storage.read(row.storage);
}

async function saveScreenshotRecord({ buffer, timestamp, reason, machineName, keyId, encrypted = false }) {
  const safeMachine = String(machineName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = String(timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const filename = `${safeMachine}_screenshot_${ts}.enc`;
  const payload = encrypted ? buffer : encryptBuffer(buffer, keyId);
  const stored = await storage.write(payload, { filename });
  return db.insertScreenshot({
    storage: stored,
    timestamp: timestamp || new Date().toISOString(),
    reason: reason || 'scheduled',
    machineName,
    keyId
  });
}

function screenshotTokenGuard(req, res) {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  try { jwt.verify(token, JWT_SECRET); return true; }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); return false; }
}

async function screenshotResponse(req, res, asImage) {
  if (!screenshotTokenGuard(req, res)) return;
  const row = await db.getScreenshot(req.params.id);
  if (!row) return res.status(404).json({ error: 'Screenshot not found' });
  let buffer;
  try {
    buffer = await readScreenshotBuffer(row);
  } catch (e) {
    if (e.notFound) return res.status(404).json({ error: 'File not found' });
    throw e;
  }
  let image;
  try {
    image = decryptBuffer(buffer, row);
  } catch (e) {
    return res.status(500).json({ error: 'Decryption failed' });
  }
  if (asImage) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length });
    res.end(image);
  } else {
    res.json({ image: image.toString('base64') });
  }
}

app.get('/api/screenshots', apiLimiter, authenticate, h(async (req, res) => {
  const { startDate, endDate, reason, machine_name } = req.query;
  res.json(await db.listScreenshots({ startDate, endDate, reason, machineName: machine_name }));
}));

app.get('/api/screenshots/base64/:id', h((req, res) => screenshotResponse(req, res, false)));
app.get('/api/screenshots/image/:id', h((req, res) => screenshotResponse(req, res, true)));

app.post('/api/screenshots/capture', apiLimiter, authenticate, h(async (req, res) => {
  const { exec } = require('child_process');
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'On-server capture is only available on Windows hosts' });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpFile = path.join(os.tmpdir(), `capture_${timestamp}.jpg`);
  const keyId = os.hostname() + os.userInfo().username;

  const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${tmpFile.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;

  await new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000 }, () => resolve());
  });

  const fs = require('fs');
  if (!fs.existsSync(tmpFile)) return res.status(500).json({ error: 'Screenshot failed' });
  try {
    const buf = fs.readFileSync(tmpFile);
    await saveScreenshotRecord({ buffer: buf, timestamp, reason: 'manual', machineName: os.hostname(), keyId });
    await audit('screenshot_capture', { by: req.user.username, ip: ipOf(req) }, req);
    res.json({ success: true, timestamp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}));

// ---------------------------------------------------------------------------
// Remote agent ingest API
// ---------------------------------------------------------------------------
app.post('/api/agent/events', authenticateAgent, rateLimit('agent', 60000, 1200, ipOf), h(async (req, res) => {
  const { events, machine_name, batch_id } = req.body || {};
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  if (events.length > 500) return res.status(400).json({ error: 'batch too large (max 500)' });

  // Exactly-once: a retried batch (lost response, agent restart) is acknowledged
  // again but never inserted twice.
  const result = await db.ingestBatch({ batchId: batch_id, events, machineName: machine_name });
  if (result.errors?.length) {
    console.warn(`[Agent] ingest issues: ${result.errors.slice(0, 3).join('; ')}`);
  }
  res.json({
    success: true,
    inserted: result.inserted,
    duplicate: Boolean(result.duplicate),
    errors: (result.errors || []).slice(0, 10)
  });
}));

// Legacy single-event endpoint (kept for backwards compatibility)
app.post('/api/agent/event', authenticateAgent, h(async (req, res) => {
  const { table, data, machine_name } = req.body || {};
  const result = await db.ingestSingle({ table, data, machineName: machine_name });
  res.json(result);
}));

app.post('/api/agent/screenshot', authenticateAgent, rateLimit('agent-ss', 60000, 120, ipOf), h(async (req, res) => {
  const { machine_name, image_data, timestamp, reason, key_id } = req.body || {};
  if (!image_data || !machine_name) return res.status(400).json({ error: 'image_data and machine_name required' });

  const buffer = Buffer.from(image_data, 'base64');
  if (!buffer.length) return res.status(400).json({ error: 'empty image payload' });
  if (buffer.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'image too large' });
  // Agent already encrypted it; key_id tells us how to decrypt it later
  await saveScreenshotRecord({ buffer, timestamp, reason, machineName: machine_name, keyId: key_id || machine_name, encrypted: true });
  res.json({ success: true });
}));

app.post('/api/agent/heartbeat', authenticateAgent, h(async (req, res) => {
  const { machine_name, hostname, ip, agent_version } = req.body || {};
  if (!machine_name) return res.status(400).json({ error: 'machine_name required' });
  res.json(await db.upsertHeartbeat({ machineName: machine_name, hostname, ip, agentVersion: agent_version }));
}));

// ---------------------------------------------------------------------------
// Fleet / machine listing
// ---------------------------------------------------------------------------
app.get('/api/agents', apiLimiter, authenticate, h(async (req, res) => {
  res.json(await db.listHeartbeats());
}));

app.get('/api/machines', apiLimiter, authenticate, h(async (req, res) => {
  const localMachine = os.hostname();
  const agents = await db.listHeartbeats();
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
      agent_version: CFG.app.version,
      last_seen: await db.maxApplicationStartTime(),
      is_local: true
    });
  }
  res.json(machines);
}));

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
app.post('/api/admin/cleanup-file-activities', apiLimiter, authenticate, h(async (req, res) => {
  const remaining = await db.cleanupFileActivities();
  await audit('cleanup_file_activities', { by: req.user.username }, req);
  res.json({ success: true, remaining });
}));

app.post('/api/admin/purge-retention', apiLimiter, authenticate, h(async (req, res) => {
  await purgeOldData();
  await audit('purge_retention', { by: req.user.username }, req);
  res.json({ success: true });
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler - must be registered after every route
app.use((err, req, res, next) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error(`[Server] ${err.stack || err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Retention - keeps storage and database from growing without bound
// ---------------------------------------------------------------------------
async function purgeOldData() {
  const { staleScreenshots = [] } = await db.purgeExpired(RETENTION_DAYS);
  for (const ref of staleScreenshots) {
    try { await storage.remove(ref); } catch (e) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  db = createDatastore(CFG);
  await db.init();

  storage = createStorage(CFG);

  console.log(`[Dashboard] Datastore: ${db.name} | Storage: ${storage.name}`);

  await purgeOldData();
  setInterval(() => purgeOldData().catch(e => console.error(`[Retention] ${e.message}`)), 3600000).unref();

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
  if (db) Promise.resolve(db.close()).finally(() => process.exit(0));
  else process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { if (db && db.name === 'sqlite') db.close(); } catch (e) {} });

if (require.main === module) {
  start().catch((err) => {
    console.error('[Dashboard] Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
