'use strict';
// Shared helpers for the monitoring agent + supervisor.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  serverUrl: 'https://easyskill-windows.onrender.com',
  agentKey: 'monitoring-agent-secret-key',
  machineName: '',
  sendInterval: 10000,
  batchSize: 50,
  maxQueue: 50000,
  screenshotInterval: 300000,
  idleThreshold: 300000,
  enableScreenshots: true,
  enableKeystrokeTracking: false,
  processPollInterval: 300000,
  networkPollInterval: 300000,
  outboxFile: ''
};

// ---------------------------------------------------------------------------
// CLI: monitor.js / supervisor.js both accept session context flags so the
// agent can be started inside any interactive user session by the supervisor.
//   --profile "C:\Users\jane"   user profile root (drives HOME/APPDATA)
//   --user jane                 user name (shown on the dashboard)
//   --session 3                 Windows session id
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

// Point every Windows-sensitive env var at a specific user profile. This must
// run before os.homedir() / process.env.LOCALAPPDATA are read by any monitor,
// so the agent behaves as the logged-in user even when launched by SYSTEM.
function applyProfile(profile, user, sessionId) {
  if (profile) {
    const root = path.resolve(profile);
    process.env.USERPROFILE = root;
    process.env.HOMEDRIVE = root.slice(0, 2);
    process.env.HOMEPATH = root.slice(2) || '\\';
    process.env.LOCALAPPDATA = path.join(root, 'AppData', 'Local');
    process.env.APPDATA = path.join(root, 'AppData', 'Roaming');
    const tmp = path.join(root, 'AppData', 'Local', 'Temp');
    try {
      if (!fs.existsSync(root)) return;
      fs.mkdirSync(tmp, { recursive: true });
      process.env.TEMP = tmp;
      process.env.TMP = tmp;
    } catch (e) {
      process.env.TEMP = process.env.TEMP || os.tmpdir();
      process.env.TMP = process.env.TMP || os.tmpdir();
    }
  }
  if (user) process.env.EASYSKILL_USER = user;
  if (sessionId !== undefined) process.env.EASYSKILL_SESSION = String(sessionId);
}

function loadConfig(logger) {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      // Strip a UTF-8 BOM: PowerShell's `Set-Content -Encoding UTF8` adds one
      // and JSON.parse rejects it, which would silently drop the agentKey.
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '');
      const cfg = JSON.parse(raw);
      const merged = { ...DEFAULTS, ...cfg };
      if (!merged.machineName) merged.machineName = os.hostname();
      if (!merged.agentKey) merged.agentKey = DEFAULTS.agentKey;
      if (!merged.serverUrl) merged.serverUrl = DEFAULTS.serverUrl;
      return merged;
    }
  } catch (e) {
    if (logger) logger('Config load error: ' + e.message);
  }
  const cfg = { ...DEFAULTS };
  if (!cfg.machineName) cfg.machineName = os.hostname();
  return cfg;
}

// Tag used to namespace log/outbox files so several concurrent sessions on one
// machine never fight over the same file.
function userTag(user) {
  if (!user) return 'default';
  return String(user).replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 40) || 'default';
}

// Append to a log file, rotating it once it passes `maxBytes` so a long-lived
// install never fills the disk.
function appendLog(file, message, maxBytes = 2 * 1024 * 1024) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      try { fs.renameSync(file, `${file}.1`); } catch (e) {}
    }
    fs.appendFileSync(file, line);
  } catch (e) { /* never let logging kill the agent */ }
}

module.exports = { DEFAULTS, CONFIG_PATH, parseArgs, applyProfile, loadConfig, userTag, appendLog };
