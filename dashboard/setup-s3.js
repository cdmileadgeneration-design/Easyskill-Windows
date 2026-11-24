#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time AWS setup for screenshot storage.
//
//   node dashboard/setup-s3.js --region ap-south-1
//   node dashboard/setup-s3.js --bucket my-shots --region ap-south-1 --days 15
//
// Creates the bucket (if missing), blocks public access, enables default
// encryption, applies a lifecycle rule that deletes screenshots after N days
// (default: DATA_RETENTION_DAYS, i.e. 15) and writes the resulting settings to
// .env so the dashboard starts writing screenshots to S3 on the next restart.
//
// Credentials come from the standard AWS chain: an IAM role attached to the
// EC2 instance (recommended), or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
// Safe to re-run: an existing bucket is reused and its lifecycle rule updated.
// ---------------------------------------------------------------------------
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');

let sdk;
try {
  sdk = require('@aws-sdk/client-s3');
} catch (e) {
  console.error('Missing @aws-sdk/client-s3 - run: cd dashboard && npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name, fallback) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}

// --- work out what to create ----------------------------------------------
async function detectRegion() {
  if (!global.fetch) return null;
  // EC2 instance metadata (IMDSv2). Fails fast anywhere else.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '30' },
      signal: controller.signal
    });
    const token = await tokenRes.text();
    const regionRes = await fetch('http://169.254.169.254/latest/meta-data/placement/region', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: controller.signal
    });
    return (await regionRes.text()).trim() || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function upsertEnv(file, pairs) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { /* first run */ }
  const lines = text ? text.split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const idx = lines.findIndex((line) => re.test(line));
    if (idx === -1) lines.push(`${key}=${value}`);
    else lines[idx] = `${key}=${value}`;
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

(async () => {
  const days = parseInt(flag('days', process.env.DATA_RETENTION_DAYS || cfg.monitoring.dataRetentionDays || 15), 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    console.error('--days must be between 1 and 3650');
    process.exit(1);
  }

  const region =
    flag('region', process.env.S3_REGION || process.env.AWS_REGION) ||
    (await detectRegion()) ||
    'us-east-1';

  const bucket =
    flag('bucket', process.env.S3_BUCKET || cfg.storage.s3.bucket) ||
    `employee-screenshots-${crypto.randomBytes(4).toString('hex')}`;

  const prefix = flag('prefix', process.env.S3_PREFIX || cfg.storage.s3.prefix || 'screenshots/');
  const client = new sdk.S3Client({ region });

  console.log(`Bucket  : s3://${bucket}`);
  console.log(`Region  : ${region}`);
  console.log(`Prefix  : ${prefix || '(bucket root)'}`);
  console.log(`Retention: delete after ${days} days`);

  // 1. bucket
  try {
    await client.send(new sdk.CreateBucketCommand({
      Bucket: bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } })
    }));
    console.log(`\n✓ bucket created`);
  } catch (e) {
    if (e.name === 'BucketAlreadyOwnedByYou') {
      console.log(`\n✓ bucket already exists and is yours - reusing it`);
    } else if (e.name === 'BucketAlreadyExists') {
      console.error(`\n✗ the name "${bucket}" is taken by another AWS account - rerun with --bucket <other-name>`);
      process.exit(1);
    } else if (e.name === 'CredentialsProviderError' || /credential/i.test(e.message)) {
      console.error('\n✗ no AWS credentials found.');
      console.error('  On EC2: attach an IAM role with S3 access to the instance.');
      console.error('  Elsewhere: set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env or the environment.');
      process.exit(1);
    } else {
      throw e;
    }
  }

  // 2. keep it private
  await client.send(new sdk.PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true
    }
  }));
  console.log('✓ public access blocked');

  // 3. encrypted at rest (SSE-S3, no extra cost / no KMS setup)
  await client.send(new sdk.PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
    }
  }));
  console.log('✓ default encryption enabled (AES256)');

  // 4. auto-delete old screenshots
  const rule = {
    ID: `expire-screenshots-${days}d`,
    Status: 'Enabled',
    Filter: prefix ? { Prefix: prefix } : {},
    Expiration: { Days: days },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }
  };
  await client.send(new sdk.PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: { Rules: [rule] }
  }));
  console.log(`✓ lifecycle rule applied: objects under "${prefix || '/'}" are deleted ${days} days after upload`);

  // 5. read it back so the output is proof, not optimism
  const applied = await client.send(new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  const savedRule = (applied.Rules || []).find((r) => r.ID === rule.ID);
  if (!savedRule || savedRule.Expiration?.Days !== days) {
    throw new Error('lifecycle rule could not be verified on the bucket');
  }
  console.log('✓ verified on the bucket');

  // 6. persist the settings the dashboard reads
  upsertEnv(cfg.ENV_PATH, {
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_PREFIX: prefix,
    DATA_RETENTION_DAYS: days
  });
  console.log(`✓ wrote STORAGE_PROVIDER=s3, S3_BUCKET, S3_REGION, S3_PREFIX, DATA_RETENTION_DAYS=${days} to ${cfg.ENV_PATH}`);

  console.log('\nNext:');
  console.log('  1. restart the dashboard (pm2 restart all / systemctl restart monitoring / npm start)');
  console.log('  2. cd dashboard && npm run check-config   -> Storage line must say s3');
  console.log('  3. wait for the next 2-minute capture; new rows show storage.provider = "s3"');
  console.log('\nIAM permissions the dashboard needs (attach to the EC2 role):');
  console.log(JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        Resource: `arn:aws:s3:::${bucket}/${prefix}*`
      },
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: `arn:aws:s3:::${bucket}` }
    ]
  }, null, 2));
})().catch((e) => {
  console.error(`\n✗ setup failed: ${e.name || 'Error'}: ${e.message}`);
  if (e.name === 'AccessDenied' || e.name === 'AccessDeniedException') {
    console.error('  The AWS identity in use lacks s3:CreateBucket / s3:PutBucketLifecycleConfiguration on this bucket.');
  }
  process.exit(1);
});
