'use strict';
/*
 * Machine-level supervisor for the Windows monitoring agent.
 *
 * Started at boot by a SYSTEM scheduled task. It:
 *   1. Detects logged-on interactive sessions (scripts/session-agent.ps1).
 *   2. Launches monitor.js inside each of them, in that user's own desktop
 *      session, so foreground-window / idle / screenshot / Chrome-history
 *      collection all see the real user (a service in Session 0 cannot).
 *   3. Restarts any agent that died or was killed (watchdog loop).
 *   4. Sends a heartbeat to the dashboard so the machine shows as online even
 *      before anyone logs on.
 *
 * It is deliberately dependency-free (no nssm / node-windows): Task Scheduler
 * is the only requirement, so the install works on a clean Windows image.
 *
 * Run modes:
 *   node supervisor.js / <exe> --supervisor    long-running watchdog loop
 *   node supervisor.js --once / <exe> --supervisor --once
 *                                 keeper task: relaunches the watchdog if it
 *                                 is gone, then exits (never reconciles itself)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

const { loadConfig, userTag, appendLog, parseArgs, monitorTarget, selfCommand } = require('./lib');

const AGENT_VERSION = require('./package.json').version;
const SUPERVISOR_VERSION = '1.0.0';

const PS_PATH = path.join(__dirname, 'scripts', 'session-agent.ps1');
const LOG_FILE = path.join(__dirname, 'supervisor.log');
const STATUS_FILE = path.join(__dirname, 'supervisor-status.json');
const LOCK_FILE = path.join(__dirname, 'supervisor.lock');

const POLL_MS = 10000;          // how often we reconcile sessions vs processes
const HEARTBEAT_MS = 60000;     // dashboard heartbeat
const RESTART_COOLDOWN_MS = 15000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const once = Boolean(args.once);
const tag = 'supervisor';
// Must come after `tag`: loadConfig() may log during a config parse failure.
const config = loadConfig((m) => log(m));

// track of agents we launched, keyed by "session:pid"
const workers = new Map();
const lastLaunchAt = new Map();
const agentStartTime = Date.now();
let status = { sessions: 0, agents: 0, lastError: '', lastReconcile: null };
let launchedCount = 0;

function log(message) {
  appendLog(LOG_FILE, `[${tag}] ${message}`, LOG_MAX_BYTES);
  if (once) console.log(`[Supervisor] ${message}`);
}

// ---------------------------------------------------------------------------
// lock file - prevents a second supervisor being spawned by the keeper task
// ---------------------------------------------------------------------------
function alreadyRunning() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);        // throws ESRCH when the process is gone
    return pid !== process.pid;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;  // exists, owned by another user
    try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
    return false;
  }
}

function writeLock() {
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) {}
}
function removeLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function powershell(script, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...params],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}

async function enumerate() {
  const raw = await powershell(PS_PATH, ['-Action', 'Enumerate', '-NodeExe', process.execPath]);
  return JSON.parse(raw);
}

async function launchAgent(session) {
  const key = `${session.sessionId}`;
  const last = lastLaunchAt.get(key) || 0;
  if (Date.now() - last < RESTART_COOLDOWN_MS) return false;
  lastLaunchAt.set(key, Date.now());

  const profile = session.profile || '';
  const a = [];
  a.push('"', monitorTarget(), '"');
  if (profile) a.push(' --profile "', profile, '"');
  a.push(' --user "', session.user, '"');
  a.push(' --session "', String(session.sessionId), '"');

  const out = await powershell(PS_PATH, [
    '-Action', 'Launch',
    '-SessionId', String(session.sessionId),
    '-NodeExe', process.execPath,
    '-Arguments', a.join(''),
    '-WorkingDirectory', __dirname
  ], 30000);

  const res = JSON.parse(out);
  if (res.error) {
    status.lastError = `${session.user}@${session.sessionId}: ${res.error}`;
    log(`launch failed for ${session.user} (session ${session.sessionId}): ${res.error}`);
    return false;
  }

  const workerKey = `${session.sessionId}:${res.pid}`;
  workers.set(workerKey, { pid: res.pid, session: session.sessionId, user: session.user, since: Date.now() });
  launchedCount++;
  log(`started agent pid=${res.pid} user=${session.user} session=${session.sessionId}`);
  return true;
}

function killAgent(pid) {
  try {
    process.kill(pid);
    return true;
  } catch (e) {
    return false;
  }
}

// Drop our records for processes that no longer exist.
function pruneWorkers() {
  for (const [key, w] of workers) {
    if (!isAlive(w.pid)) {
      workers.delete(key);
      log(`agent pid=${w.pid} (user=${w.user}) exited`);
    }
  }
}

// ---------------------------------------------------------------------------
// core reconcile: every logged-on session must have a live agent
// ---------------------------------------------------------------------------
async function reconcile() {
  let snap;
  try {
    snap = await enumerate();
  } catch (e) {
    status.lastError = `enumerate: ${e.message}`;
    log(`enumerate failed: ${e.message}`);
    return;
  }

  const selfSession = snap.selfSessionId || 0;
  const sessions = (snap.sessions || []).filter((s) => s.interactive);

  // adopt agents we didn't launch (e.g. supervisor restarted)
  for (const a of snap.agents || []) {
    if (!a.commandLine || !/monitor\.js|--monitor\b/.test(a.commandLine)) continue;
    const key = `${a.sessionId}:${a.pid}`;
    if (!workers.has(key)) {
      workers.set(key, {
        pid: a.pid,
        session: a.sessionId,
        user: sessionUser(a, snap) || 'unknown',
        since: Date.now(),
        adopted: true
      });
    }
  }

  pruneWorkers();

  for (const s of sessions) {
    // Skip sessions we could not resolve a profile for (still reported so the
    // dashboard shows the machine + user count).
    if (!s.profile) s.profile = resolveProfile(s.user, s.domain);

    const alive = [...workers.values()].some((w) => w.session === s.sessionId);
    if (!alive) {
      await launchAgent(s);
    }
  }

  // agents attached to a session that is gone -> stop them
  for (const [key, w] of [...workers.entries()]) {
    const stillLoggedIn = sessions.some((s) => s.sessionId === w.session);
    if (!stillLoggedIn && !w.adopted) {
      if (killAgent(w.pid)) log(`session gone, stopped agent pid=${w.pid} (user=${w.user})`);
      workers.delete(key);
    } else if (!stillLoggedIn && w.adopted && !isAlive(w.pid)) {
      workers.delete(key);
    }
  }

  status.sessions = sessions.length;
  status.agents = [...workers.values()].filter((w) => isAlive(w.pid)).length;
  status.lastReconcile = new Date().toISOString();
  status.selfSessionId = selfSession;
  status.agentVersion = AGENT_VERSION;
  status.supervisorVersion = SUPERVISOR_VERSION;
  status.uptimeMs = Date.now() - agentStartTime;
  status.launched = launchedCount;
  status.config = {
    serverUrl: config.serverUrl,
    machineName: config.machineName
  };

  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {}

  if (once) {
    log(`reconcile: ${status.sessions} session(s), ${status.agents} agent(s) running`);
  }
}

function sessionUser(entry, snap) {
  const s = (snap.sessions || []).find((x) => x.sessionId === entry.sessionId);
  return s ? s.user : null;
}

const PROFILE_CACHE = new Map();
function resolveProfile(user, domain) {
  if (!user) return null;
  const cacheKey = user;
  if (PROFILE_CACHE.has(cacheKey)) return PROFILE_CACHE.get(cacheKey);

  const candidates = [];
  // Prefer the standard local-profile path, then the domain path.
  if (user.match(/^[A-Za-z]:\\/)) candidates.push(user);
  candidates.push(path.join('C:\\Users', user));
  const home = os.homedir();
  if (home && home.indexOf('systemprofile') < 0) candidates.push(home);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        PROFILE_CACHE.set(cacheKey, c);
        return c;
      }
    } catch (e) {}
  }
  PROFILE_CACHE.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// heartbeat so the dashboard lists this machine even with nobody logged on
// ---------------------------------------------------------------------------
function localIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(config.serverUrl.replace(/\/+$/, '') + endpoint);
    } catch (e) {
      return reject(new Error('invalid serverUrl: ' + config.serverUrl));
    }
    const data = JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': config.agentKey,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        resolve(raw);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

let heartbeatFailed = 0;
async function sendHeartbeat() {
  try {
    await post('/api/agent/heartbeat', {
      machine_name: config.machineName,
      hostname: os.hostname(),
      ip: localIP(),
      agent_version: `${SUPERVISOR_VERSION} (agent ${AGENT_VERSION})`
    });
    if (heartbeatFailed) {
      heartbeatFailed = 0;
      log('heartbeat restored');
    }
  } catch (e) {
    heartbeatFailed++;
    if (heartbeatFailed === 1 || heartbeatFailed % 10 === 0) {
      log(`heartbeat failed: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// Relaunch a detached long-running supervisor. Used by the keeper task so the
// machine is never left without a watchdog after the supervisor is killed or
// crashes (the AgentSupervisor task alone does not restart an externally
// killed process).
function spawnSupervisor() {
  try {
    const cmd = selfCommand(['--supervisor']);
    const child = spawn(cmd.exe, cmd.args, {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    log(`keeper: supervisor was not running - relaunched pid=${child.pid}`);
    return true;
  } catch (e) {
    log(`keeper: failed to relaunch supervisor: ${e.message}`);
    return false;
  }
}

async function main() {
  if (once) {
    // Keeper safety net (runs every minute): nothing running -> bring the
    // watchdog back and let it own the lock and reconcile sessions. Take no
    // lock ourselves, otherwise a supervisor restarting in that window would
    // see it and give up. Exit silently when the supervisor is healthy.
    if (!alreadyRunning()) spawnSupervisor();
    process.exit(0);
  }

  if (alreadyRunning()) {
    log('another supervisor instance is already running, exiting');
    process.exit(0);
  }

  writeLock();

  log(`supervisor v${SUPERVISOR_VERSION} starting (node ${process.version})`);
  log(`machine: ${config.machineName}  server: ${config.serverUrl}`);

  await sendHeartbeat();
  await reconcile();

  const pollTimer = setInterval(() => {
    reconcile().catch((e) => log(`reconcile error: ${e.message}`));
  }, POLL_MS);
  const hbTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  const shutdown = () => {
    log('supervisor stopping');
    clearInterval(pollTimer);
    clearInterval(hbTimer);
    removeLock();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err.message}`);
    removeLock();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason}`));
}

main().catch((e) => {
  log(`failed to start: ${e.message}`);
  removeLock();
  process.exit(1);
});
