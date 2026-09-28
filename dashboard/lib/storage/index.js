// Storage adapters - one small interface so screenshots can live on disk today
// and in Cloudinary / Amazon S3 without touching the route handlers.
//
//   write(buffer, { filename }) -> Promise<{ provider, key, url? }>
//   read(ref)                   -> Promise<Buffer>   ref = { provider, key, url? }
//   remove(ref)                 -> Promise<void>
//   ready                       -> boolean (true when credentials are usable)
const local = require('./local');
const cloudinary = require('./cloudinary');
const s3 = require('./s3');

const ADAPTERS = { local, cloudinary, s3 };

function createStorage(cfg) {
  const name = (cfg.storage?.provider || 'local').toLowerCase();
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown STORAGE_PROVIDER "${name}" (expected: ${Object.keys(ADAPTERS).join(', ')})`);
  }
  const instance = adapter.create(cfg);
  instance.name = name;

  if (!instance.ready && name !== 'local') {
    console.warn(
      `[Storage] ${name} is selected but its credentials are incomplete - falling back to local disk. ` +
      `Fill in ${name === 'cloudinary' ? 'CLOUDINARY_*' : 'S3_*'} values in .env`
    );
    const fallback = local.create(cfg);
    fallback.name = 'local (fallback)';
    return fallback;
  }
  return instance;
}

module.exports = { createStorage };
