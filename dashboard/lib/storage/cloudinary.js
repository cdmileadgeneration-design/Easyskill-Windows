// Cloudinary storage - screenshots are uploaded as opaque (encrypted) blobs.
// Credentials come from .env: CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET, or a single CLOUDINARY_URL=cloudinary://key:secret@cloud.
const cloudinary = require('cloudinary').v2;

function create(cfg) {
  const creds = cfg.storage.cloudinary || {};
  const ready = Boolean(creds.cloudName && creds.apiKey && creds.apiSecret);

  if (ready) {
    cloudinary.config({
      cloud_name: creds.cloudName,
      api_key: creds.apiKey,
      api_secret: creds.apiSecret,
      secure: true
    });
  }

  return {
    ready,
    async write(buffer, { filename } = {}) {
      const folder = cfg.storage.folder || creds.folder;
      const output = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            public_id: filename,
            overwrite: false,
            unique_filename: false,
            resource_type: 'raw'
          },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
      });
      return { provider: 'cloudinary', key: output.public_id, url: output.secure_url };
    },
    async read(ref) {
      const url = ref?.url || (ref?.key ? cloudinary.url(ref.key, { resource_type: 'raw', secure: true }) : null);
      if (!url) throw notFound('missing storage key');
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new Error(`cloudinary download failed: ${e.message}`);
      }
      if (res.status === 404) throw notFound('cloudinary object not found');
      if (!res.ok) throw new Error(`cloudinary download failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(ref) {
      if (!ref?.key) return;
      try {
        await cloudinary.uploader.destroy(ref.key, { resource_type: 'raw' });
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
