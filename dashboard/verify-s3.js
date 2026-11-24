#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Proof that this machine can actually use the screenshot bucket.
//
//   cd dashboard && npm run verify-s3
//
// Runs the exact code path the dashboard uses: puts a small object through the
// S3 storage adapter, reads it back, compares the bytes, deletes it again and
// checks it is gone. Also prints the bucket's lifecycle rules so you can see
// the 15-day expiry that was applied. Read-only apart from one throwaway
// object under the screenshots prefix.
//
// Run it on the EC2 instance after setup-s3 + restart. Exit code 0 = the
// dashboard will be able to store screenshots.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const cfg = require('./config');

let sdk;
try {
  sdk = require('@aws-sdk/client-s3');
} catch (e) {
  console.error('✗ @aws-sdk/client-s3 is not installed - run: cd dashboard && npm install');
  process.exit(1);
}

const s3cfg = cfg.storage.s3 || {};
const retention = cfg.monitoring.dataRetentionDays;
const client = new sdk.S3Client({
  region: s3cfg.region || 'us-east-1',
  ...(s3cfg.endpoint ? { endpoint: s3cfg.endpoint } : {}),
  forcePathStyle: s3cfg.forcePathStyle ? true : Boolean(s3cfg.endpoint)
});

function explain(e) {
  const name = e.name || 'Error';
  if (name === 'CredentialsProviderError' || /credential/i.test(e.message || '')) {
    return 'no AWS credentials. Attach an IAM role with S3 access to the EC2 instance, or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.';
  }
  if (name === 'NoSuchBucket') return `bucket "${s3cfg.bucket}" does not exist in ${s3cfg.region}. Check the name/region.`;
  if (name === 'PermanentRedirect' || /wrong region|region/i.test(e.message || '')) {
    return `the bucket is in a different region than ${s3cfg.region}. Set S3_REGION to the bucket's region.`;
  }
  if (name === 'AccessDenied' || name === 'Forbidden' || e.$metadata?.httpStatusCode === 403) {
    return 'the AWS identity is not allowed to do this. The EC2 role needs s3:PutObject, s3:GetObject, s3:DeleteObject on the screenshots prefix and s3:ListBucket on the bucket.';
  }
  if (name === 'NetworkingError' || name === 'TimeoutError') {
    return `cannot reach the S3 endpoint (${s3cfg.endpoint || `s3.${s3cfg.region}.amazonaws.com`}). Outbound HTTPS may be blocked.`;
  }
  return name + ': ' + (e.message || 'unknown error');
}

(async () => {
  console.log(`Provider : ${cfg.storage.provider}`);
  console.log(`Bucket   : ${s3cfg.bucket || '(not set)'}`);
  console.log(`Region   : ${s3cfg.region || '(not set)'}`);
  console.log(`Prefix   : ${s3cfg.prefix || '(bucket root)'}`);
  console.log(`Retention: ${retention} days`);
  if (s3cfg.endpoint) console.log(`Endpoint : ${s3cfg.endpoint}`);
  console.log('');

  if (cfg.storage.provider !== 's3') {
    console.error(`✗ STORAGE_PROVIDER is "${cfg.storage.provider}", not "s3" - screenshots are not going to S3.`);
    console.error('  Run: npm run setup-s3 -- --bucket <your-bucket> --region ap-south-1');
    process.exit(1);
  }
  if (!s3cfg.bucket) {
    console.error('✗ S3_BUCKET is not set - run: npm run setup-s3 -- --bucket <your-bucket> --region ap-south-1');
    process.exit(1);
  }

  // 1. bucket reachable + we have credentials
  try {
    await client.send(new sdk.HeadBucketCommand({ Bucket: s3cfg.bucket }));
    console.log('✓ credentials work and the bucket is reachable');
  } catch (e) {
    console.error(`✗ cannot use bucket: ${explain(e)}`);
    process.exit(1);
  }

  // 2. the expiry rule that deletes old screenshots
  try {
    const out = await client.send(new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: s3cfg.bucket }));
    const rules = out.Rules || [];
    if (!rules.length) {
      console.warn('⚠ the bucket has no lifecycle rule - screenshots will never be deleted automatically.');
      console.warn('  Fix: npm run setup-s3 -- --bucket ' + s3cfg.bucket + ' --region ' + s3cfg.region);
    }
    for (const r of rules) {
      const scope = r.Filter?.Prefix ?? r.Prefix ?? '(whole bucket)';
      const exp = r.Expiration?.Days != null ? `${r.Expiration.Days} days` : r.Expiration?.Date || 'no expiry';
      console.log(`✓ lifecycle rule "${r.ID}" [${r.Status}] scope ${scope} -> deletes after ${exp}`);
      if (r.Expiration?.Days != null && r.Expiration.Days !== retention) {
        console.warn(`⚠ rule deletes after ${r.Expiration.Days} days but DATA_RETENTION_DAYS is ${retention}`);
      }
    }
  } catch (e) {
    if (e.name === 'NoSuchLifecycleConfiguration') {
      console.warn('⚠ the bucket has no lifecycle rule - old screenshots will not be deleted by S3.');
    } else {
      console.warn(`⚠ could not read lifecycle rules: ${explain(e)}`);
    }
  }

  // 3. real put / get / delete through the dashboard's own adapter
  const { createStorage } = require('./lib/storage');
  const storage = createStorage(cfg);
  if (storage.name !== 's3') {
    console.error(`✗ the dashboard would fall back to "${storage.name}" - check the S3 settings in .env`);
    process.exit(1);
  }

  const payload = crypto.randomBytes(32);
  const filename = `_verify-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.bin`;
  let ref = null;
  try {
    ref = await storage.write(payload, { filename });
    console.log(`✓ wrote ${ref.key}`);

    const back = await storage.read(ref);
    if (!back.equals(payload)) {
      console.error('✗ the object read back does not match what was written');
      process.exit(1);
    }
    console.log('✓ read back and bytes match');

    await storage.remove(ref);
    let gone = false;
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: s3cfg.bucket, Key: ref.key }));
    } catch (e) {
      gone = e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
      if (!gone) throw e;
    }
    if (!gone) {
      console.error('✗ the test object still exists after delete - the dashboard cannot purge old screenshots');
      process.exit(1);
    }
    console.log('✓ test object deleted');
  } catch (e) {
    console.error(`✗ ${explain(e)}`);
    if (ref?.key) console.error(`  leftover test object: s3://${s3cfg.bucket}/${ref.key} (safe to delete)`);
    process.exit(1);
  }

  console.log('\nRESULT: PASS - this instance will store screenshots in s3://' + s3cfg.bucket + '/' + (s3cfg.prefix || ''));
  console.log('New captures appear in the dashboard within one screenshot interval (2 minutes).');
})().catch((e) => {
  console.error(`✗ verification crashed: ${e.stack || e.message}`);
  process.exit(1);
});
