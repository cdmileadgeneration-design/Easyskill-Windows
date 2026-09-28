// Amazon S3 storage adapter - the AWS migration path.
//
// Credentials use the standard AWS default credential chain, so the same code
// works locally (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env) and on
// EC2 / ECS / Lambda (IAM role) with no code changes.
//
// Required env: S3_BUCKET, S3_REGION (optional S3_PREFIX, S3_ENDPOINT).
function create(cfg) {
  const s3cfg = cfg.storage.s3 || {};
  const ready = Boolean(s3cfg.bucket);
  let client = null;
  let sdk = null;

  function ensure() {
    if (client) return client;
    try {
      sdk = require('@aws-sdk/client-s3');
    } catch (e) {
      throw new Error('S3 storage selected but @aws-sdk/client-s3 is missing - run: npm install @aws-sdk/client-s3');
    }
    client = new sdk.S3Client({
      region: s3cfg.region || 'us-east-1',
      ...(s3cfg.endpoint ? { endpoint: s3cfg.endpoint } : {}),
      forcePathStyle: s3cfg.forcePathStyle ? true : Boolean(s3cfg.endpoint)
    });
    return client;
  }

  const keyOf = (name) => `${s3cfg.prefix || ''}${name}`;

  return {
    ready,
    async write(buffer, { filename } = {}) {
      const s3 = ensure();
      const Key = keyOf(filename);
      await s3.send(new sdk.PutObjectCommand({
        Bucket: s3cfg.bucket,
        Key,
        Body: buffer,
        ContentType: 'application/octet-stream'
      }));
      return { provider: 's3', key: Key };
    },
    async read(ref) {
      if (!ref?.key) throw notFound('missing storage key');
      const s3 = ensure();
      try {
        const out = await s3.send(new sdk.GetObjectCommand({ Bucket: s3cfg.bucket, Key: ref.key }));
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
          throw notFound(ref.key);
        }
        throw e;
      }
    },
    async remove(ref) {
      if (!ref?.key) return;
      try {
        const s3 = ensure();
        await s3.send(new sdk.DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: ref.key }));
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
