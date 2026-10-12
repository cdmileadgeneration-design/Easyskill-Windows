'use strict';
// Shared helpers for the monitoring agent + supervisor.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------------------------------------------------------------------------
// Build mode
// ---------------------------------------------------------------------------
// `__BUNDLED__` is replaced with `true` by esbuild when tools/build.js makes
// the single-file executable; it stays an undeclared identifier when the agent
// runs from source, so `typeof` keeps dev mode working without a global.
const RUNNING_BUNDLED = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__ === true;

// Command line token that selects the monitor entry point. In the bundled build
// entry.js dispatches on `--monitor`; from source the script path is used.
function monitorTarget() {
  return RUNNING_BUNDLED ? '--monitor' : path.join(__dirname, 'monitor.js');
}

// Command that re-runs this same program with extra arguments, so the keeper
// task and the session launcher behave identically in both build modes.
function selfCommand(extraArgs = []) {
  const args = RUNNING_BUNDLED ? [...extraArgs] : [process.argv[1], ...extraArgs];
  return { exe: process.execPath, args };
}


const DEFAULTS = {
  serverUrl: 'https://easyskill-windows-fy9f.onrender.com',
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

// Folder holding the PowerShell helpers (get-foreground-window.ps1, ...).
// lib.js always sits next to them in source mode (agent\scripts) and shares the
// executable's directory in the bundled build (esbuild flattens every module
// into one file, so __dirname is the install folder where deploy.ps1 copies
// scripts\). Resolving from here therefore works in BOTH build modes, unlike
// monitors\*.js which would compute <installDir>\..\scripts and find nothing.
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

function resolveScript(name) {
  const candidates = [
    path.join(SCRIPTS_DIR, name),
    path.join(__dirname, 'scripts', name),
    // legacy layout: monitors\*.js resolved relative to their own folder
    path.join(__dirname, '..', 'scripts', name)
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (e) { /* keep looking */ }
  }
  return null;
}

// Runtime folder the agent (running as the employee) is allowed to write.
// Keeping it out of the install folder lets deploy.ps1 make everything else
// read-only for the logged-in user, so they cannot delete or replace the
// agent while still being able to produce logs and queue events.
const STATE_DIR = path.join(__dirname, 'state');

function statePath(name) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
  return path.join(STATE_DIR, name);
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

module.exports = { DEFAULTS, CONFIG_PATH, STATE_DIR, SCRIPTS_DIR, resolveScript, statePath, parseArgs, applyProfile, loadConfig, userTag, appendLog, RUNNING_BUNDLED, monitorTarget, selfCommand };
