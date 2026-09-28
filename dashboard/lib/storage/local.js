// Local disk storage (default provider, no credentials required).
const fs = require('fs');
const path = require('path');

function create(cfg) {
  const dir = cfg.storage.localDir;
  return {
    ready: true,
    async write(buffer, { filename } = {}) {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, filename);
      fs.writeFileSync(target, buffer);
      return { provider: 'local', key: target };
    },
    async read(ref) {
      if (!ref?.key) throw notFound('missing storage key');
      if (!fs.existsSync(ref.key)) throw notFound(ref.key);
      return fs.readFileSync(ref.key);
    },
    async remove(ref) {
      try {
        if (ref?.key && fs.existsSync(ref.key)) fs.unlinkSync(ref.key);
      } catch (e) { /* best effort */ }
    }
  };
}

function notFound(message) {
  const err = new Error(message);
  err.notFound = true;
  return err;
}

module.exports = { create };
