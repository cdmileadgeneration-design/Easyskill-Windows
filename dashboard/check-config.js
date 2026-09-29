// Configuration sanity check - run with:  node dashboard/check-config.js
// Used by setup.bat and handy after editing .env / config.json.
const fs = require('fs');
const path = require('path');

const CFG = require('./config');

function readJson(p, key) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return key ? v[key] : v;
  } catch (e) {
    return null;
  }
}

const root = CFG.ROOT;
const agentCfg = readJson(path.join(root, 'agent', 'config.json')) || {};
const serverKey = CFG.security.agentKey;

const lines = [];
const warn = [];

lines.push(`Config file     : ${CFG.configExists ? CFG.CONFIG_PATH : '(missing - using .env / defaults)'}`);
lines.push(`Environment     : ${CFG.ENV_PATH}${fs.existsSync(CFG.ENV_PATH) ? '' : '  (missing)'}`);

// Database
let dbLine = `Database        : ${CFG.database.provider}`;
if (CFG.database.provider === 'mongodb') {
  if (!CFG.database.mongodbUri) {
    dbLine += '   (MONGODB_URI MISSING)';
    warn.push('DB_PROVIDER=mongodb but MONGODB_URI is empty - set it in .env');
  } else {
    dbLine += `   (uri: yes, db: ${CFG.database.mongodbDb})`;
  }
} else {
  dbLine += `   (${CFG.database.sqlitePath})`;
}
lines.push(dbLine);

// Storage
let stLine = `Storage         : ${CFG.storage.provider}`;
if (CFG.storage.provider === 'cloudinary') {
  const c = CFG.storage.cloudinary;
  if (c.cloudName && c.apiKey && c.apiSecret) {
    stLine += `   (cloud: ${c.cloudName}, folder: ${CFG.storage.folder})`;
  } else {
    stLine += '   (CLOUDINARY KEYS MISSING)';
    warn.push('Cloudinary credentials incomplete - server will fall back to local disk');
  }
} else if (CFG.storage.provider === 's3') {
  if (CFG.storage.s3.bucket) stLine += `   (bucket: ${CFG.storage.s3.bucket}, region: ${CFG.storage.s3.region})`;
  else {
    stLine += '   (S3_BUCKET MISSING)';
    warn.push('STORAGE_PROVIDER=s3 but S3_BUCKET is empty');
  }
} else {
  stLine += `   (${CFG.storage.localDir})`;
}
lines.push(stLine);

// Secrets
lines.push(`JWT secret      : ${CFG.security.jwtSecret ? (CFG.security.jwtSecret === 'change-this-to-secure-random-string' ? 'DEFAULT - CHANGE IT' : 'set') : 'MISSING - set security.jwtSecret or JWT_SECRET'}`);
if (!CFG.security.jwtSecret || CFG.security.jwtSecret === 'change-this-to-secure-random-string') {
  warn.push('jwtSecret is missing/weak - login tokens are not secure');
}

if (serverKey) {
  const agentKey = agentCfg.agentKey;
  lines.push(`Agent key       : ${agentKey ? (agentKey === serverKey ? 'match (agent/config.json)' : 'MISMATCH with agent/config.json - agents will get 401') : 'agent/config.json not found'}`);
  if (agentKey && agentKey !== serverKey) warn.push('AGENT_KEY on the server != agent/config.json agentKey');
} else {
  lines.push('Agent key       : MISSING - remote agents will be rejected');
  warn.push('no agent key configured (security.agentKey / AGENT_KEY)');
}

// Agent target
lines.push(`Agent serverUrl : ${agentCfg.serverUrl || '(not set)'}`);

// Admin
const plain = CFG.security.adminPassword;
const admin = `${CFG.security.adminUser} / ${CFG.security.adminPasswordHash ? '<bcrypt hash>' : plain === 'admin' ? 'admin  (DEFAULT - CHANGE IT)' : '<custom>'}`;
lines.push(`Dashboard login : ${admin}`);
if (!CFG.security.adminPasswordHash && plain === 'admin') {
  warn.push('dashboard is running with admin/admin - run: node dashboard/set-password.js admin "YourPass"');
}

console.log('--- Configuration check -------------------------------------');
for (const l of lines) console.log('  ' + l);
if (warn.length) {
  console.log('--- Warnings -------------------------------------------------');
  for (const w of warn) console.log('  ! ' + w);
} else {
  console.log('--- No problems found ---------------------------------------');
}
process.exit(0);
