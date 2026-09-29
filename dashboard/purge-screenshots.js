'use strict';
// Delete screenshots - both the database rows and the blobs in the storage
// adapter (Cloudinary / S3 / local disk).
//
//   node dashboard/purge-screenshots.js --dry-run    report only, change nothing
//   node dashboard/purge-screenshots.js              delete everything
//   node dashboard/purge-screenshots.js --machine X  only that machine
//   node dashboard/purge-screenshots.js --before ISO delete only older than
//
// Uses the same config + adapters as server.js, so it works against whichever
// DB_PROVIDER / STORAGE_PROVIDER .env selects. Blobs are removed first: if a
// delete fails the row is kept, so nothing is ever lost without a trace.
const CFG = require('./config');
const { createDatastore } = require('./lib/db');
const { createStorage } = require('./lib/storage');

function parseArgs(argv) {
  const out = { dryRun: false, machine: '', before: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--machine') out.machine = argv[++i] || '';
    else if (argv[i] === '--before') out.before = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log('Usage: node dashboard/purge-screenshots.js [--dry-run] [--machine NAME] [--before ISO_DATE]');
    process.exit(0);
  }

  const db = await createDatastore(CFG).init();
  const storage = createStorage(CFG);
  console.log(`[DB] ${db.name}   [Storage] ${storage.name}${storage.ready === false ? ' (NOT READY)' : ''}`);

  const rows = await db.listScreenshots({
    machineName: args.machine || undefined,
    endDate: args.before || undefined,
    limit: 1000000
  });

  console.log(`Found ${rows.length} screenshot record(s)` +
    `${args.machine ? ` for machine "${args.machine}"` : ''}` +
    `${args.before ? ` older than ${args.before}` : ''}`);

  if (!rows.length) {
    await db.close();
    return;
  }

  const byMachine = new Map();
  for (const r of rows) byMachine.set(r.machine_name || 'unknown', (byMachine.get(r.machine_name || 'unknown') || 0) + 1);
  console.log('  ' + [...byMachine].map(([k, v]) => `${k}: ${v}`).join(', '));

  if (args.dryRun) {
    console.log('\nDry run - nothing was deleted.');
    await db.close();
    return;
  }

  let blobsRemoved = 0;
  let rowsDeleted = 0;
  const failed = [];

  for (const row of rows) {
    try {
      if (row.storage && row.storage.key) {
        await storage.remove(row.storage);
        blobsRemoved++;
      } else if (!row.storage && !row.file_path) {
        // no blob on record - still drop the row
      } else {
        await storage.remove({ provider: 'local', key: row.file_path });
        blobsRemoved++;
      }
      await db.deleteScreenshot(row.id);
      rowsDeleted++;
    } catch (e) {
      failed.push(`${row.id}: ${e.message}`);
    }
    if ((rowsDeleted + failed.length) % 100 === 0) {
      process.stdout.write(`  ... ${rowsDeleted + failed.length}/${rows.length}\r`);
    }
  }

  const left = await db.listScreenshots({ limit: 5 });
  console.log('');
  console.log(`Blobs removed : ${blobsRemoved}`);
  console.log(`Rows deleted  : ${rowsDeleted}`);
  if (failed.length) {
    console.log(`FAILED        : ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`   ${f}`);
  }
  console.log(`Remaining     : ${left.length ? `${left.length}+ still present` : '0'}`);

  await db.close();
}

main().catch((e) => {
  console.error('purge-screenshots failed:', e.message);
  process.exit(1);
});
