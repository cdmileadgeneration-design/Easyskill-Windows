// Central configuration.
// Precedence: process environment / .env  >  config.json  >  built-in defaults.
// Every setting can therefore be supplied either way (config.json for local
// installs, environment variables for Docker / AWS / CI).
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ENV_PATH = path.join(ROOT, '.env');

dotenv.config({ path: ENV_PATH });

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

const file = readJson(CONFIG_PATH) || {};

function str(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}
function int(key, fallback) {
  const v = parseInt(str(key, ''), 10);
  return Number.isFinite(v) ? v : fallback;
}
function num(key, fallback) {
  const v = parseFloat(str(key, ''));
  return Number.isFinite(v) ? v : fallback;
}

// Relative paths in config.json / .env are resolved against the project root,
// never against the process working directory.
function fromRoot(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

// Cloudinary accepts a single CLOUDINARY_URL=cloudinary://key:secret@cloud
function parseCloudinaryUrl(raw) {
  if (!raw) return {};
  try {
    const u = new URL(raw);
    const parts = (u.pathname || '').replace(/^\/+/, '').split('@');
    return {
      cloudName: u.hostname || undefined,
      apiKey: decodeURIComponent(u.username || '') || undefined,
      apiSecret: decodeURIComponent(u.password || '') || undefined
    };
  } catch (e) {
    return {};
  }
}

const cloudUrl = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
const legacyKey = str('Claudinary_Api_Key', file.storage?.cloudinaryApiKey);
const legacySecret = str('Claudinary_Api_Secret', file.storage?.cloudinaryApiSecret);

const cloudinary = {
  cloudName: str('CLOUDINARY_CLOUD_NAME', file.storage?.cloudinaryCloudName || cloudUrl.cloudName),
  apiKey: str('CLOUDINARY_API_KEY', file.storage?.cloudinaryApiKey || cloudUrl.apiKey || legacyKey),
  apiSecret: str('CLOUDINARY_API_SECRET', file.storage?.cloudinaryApiSecret || cloudUrl.apiSecret || legacySecret),
  folder: str('CLOUDINARY_FOLDER', file.storage?.cloudinaryFolder || 'windows-monitoring/screenshots')
};
const hasCloudinary = Boolean(cloudinary.cloudName && cloudinary.apiKey && cloudinary.apiSecret);

const mongodbUri = str('MONGODB_URI', file.database?.mongodbUri || '');
const defaultDbProvider = mongodbUri ? 'mongodb' : 'sqlite';
const storageDefault = file.storage?.provider || (hasCloudinary ? 'cloudinary' : 'local');

const storage = {
  provider: str('STORAGE_PROVIDER', storageDefault).toLowerCase(),
  folder: str('STORAGE_FOLDER', file.storage?.folder || 'windows-monitoring/screenshots'),
  localDir: fromRoot(str('STORAGE_LOCAL_DIR', file.storage?.localDir || 'screenshots')),
  cloudinary,
  s3: {
    bucket: str('S3_BUCKET', file.storage?.s3Bucket || ''),
    region: str('S3_REGION', file.storage?.s3Region || process.env.AWS_REGION || 'us-east-1'),
    prefix: str('S3_PREFIX', file.storage?.s3Prefix || 'screenshots/'),
    endpoint: str('S3_ENDPOINT', file.storage?.s3Endpoint || ''), // LocalStack / MinIO
    forcePathStyle: str('S3_FORCE_PATH_STYLE', file.storage?.s3ForcePathStyle || '') === 'true'
  }
};

module.exports = {
  ROOT,
  CONFIG_PATH,
  ENV_PATH,
  raw: file,
  configExists: fs.existsSync(CONFIG_PATH),

  app: {
    name: file.app?.name || 'Windows Monitoring',
    version: file.app?.version || '2.1.0'
  },

  dashboard: {
    port: int('PORT', file.dashboard?.port || 3000),
    host: str('HOST', file.dashboard?.host || '0.0.0.0')
  },

  security: {
    jwtSecret: str('JWT_SECRET', file.security?.jwtSecret || ''),
    agentKey: str('AGENT_KEY', file.security?.agentKey || ''),
    adminUser: str('ADMIN_USER', file.security?.adminUser || 'admin'),
    adminPassword: str('ADMIN_PASSWORD', file.security?.adminPassword || 'admin'),
    adminPasswordHash: str('ADMIN_PASSWORD_HASH', file.security?.adminPasswordHash || ''),
    sessionTimeout: int('SESSION_TIMEOUT', file.security?.sessionTimeout || 86400000),
    loginRateLimit: file.security?.loginRateLimit || { windowMs: 60000, max: 10 },
    apiRateLimit: file.security?.apiRateLimit || { windowMs: 60000, max: 600 }
  },

  monitoring: {
    dataRetentionDays: int('DATA_RETENTION_DAYS', file.monitoring?.dataRetentionDays || 15)
  },

  database: {
    provider: str('DB_PROVIDER', file.database?.provider || defaultDbProvider).toLowerCase(),
    mongodbUri,
    mongodbDb: str('MONGODB_DB', file.database?.dbName || 'windows_monitoring'),
    sqlitePath: fromRoot(str('SQLITE_PATH', file.database?.sqlitePath || 'database/monitor.db')),
    auditPath: fromRoot(str('AUDIT_PATH', file.database?.auditPath || 'database/audit.log'))
  },

  storage
};
