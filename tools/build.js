'use strict';
/*
 * Builds the monitoring agent into ONE self-contained Windows executable.
 *
 *   node tools/build.js        ->  agent/dist/<EXE_NAME>
 *
 * Why: an employee-facing machine should not show a `node.exe` process or need
 * a Node.js runtime + node_modules folder. Node's Single Executable Application
 * support bakes the runtime and our bundle into a single file.
 *
 * Steps:
 *   1. esbuild bundles agent/entry.js (and every require() beneath it) into one
 *      CommonJS file, with __BUNDLED__ defined so lib.js switches to bundled
 *      code paths (selfCommand / monitorTarget).
 *   2. node --experimental-sea-config turns that into a blob.
 *   3. node.exe is copied to agent/dist/<EXE_NAME> and the blob is injected
 *      with postject.
 *
 * The scripts\ folder and sql-wasm.wasm are NOT bundled - deploy.ps1 copies
 * them next to the exe at install time.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AGENT = path.join(ROOT, 'agent');
const BUILD = path.join(AGENT, '.build');
const DIST = path.join(AGENT, 'dist');

// Shown in Task Manager. Keep it bland and NOT the name of a real Windows
// system binary (impersonating one trips antivirus and is a bad idea).
// Must stay in sync with nothing - deploy.ps1 discovers it by globbing dist\.
const EXE_NAME = process.env.EASYSKILL_EXE_NAME || 'TelemetryHost.exe';

// The fuse constant Node looks for is baked into node.exe and it is NOT the
// same across releases (docs show NODE_SEA_FUSE_fce680ab2cc219b1; Node 24 uses
// a longer one), so read it out of the runtime we are about to copy instead of
// hard-coding a value that silently breaks on a Node upgrade.
function detectFuse(nodePath) {
  const buf = fs.readFileSync(nodePath);
  const m = buf.toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]+/);
  if (!m) throw new Error(`no NODE_SEA_FUSE sentinel found in ${nodePath}`);
  return m[0];
}

function log(msg) { console.log(`[build] ${msg}`); }

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function main() {
  if (process.argv.includes('--clean')) {
    fs.rmSync(BUILD, { recursive: true, force: true });
    fs.rmSync(DIST, { recursive: true, force: true });
    log('cleaned');
    return;
  }

  const esbuild = require(path.join(__dirname, 'node_modules', 'esbuild'));
  const postject = path.join(__dirname, 'node_modules', 'postject', 'dist', 'cli.js');

  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // --- 1. bundle -----------------------------------------------------------
  const bundle = path.join(BUILD, 'bundle.cjs');
  log('bundling agent/entry.js ...');
  esbuild.buildSync({
    entryPoints: [path.join(AGENT, 'entry.js')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // fsevents is macOS-only, required inside a try/catch by chokidar.
    external: ['fsevents'],
    define: { __BUNDLED__: 'true' },
    // Keep names in stack traces readable when something goes wrong on-site.
    minify: false,
    logLevel: 'warning'
  });
  const kb = Math.round(fs.statSync(bundle).size / 1024);
  log(`bundle.cjs ${kb} KB`);

  // --- 2. SEA blob ---------------------------------------------------------
  const seaConfig = path.join(BUILD, 'sea-config.json');
  const blob = path.join(BUILD, 'sea-prep.blob');
  fs.writeFileSync(seaConfig, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false
  }, null, 2));
  log('generating SEA blob ...');
  sh(process.execPath, ['--experimental-sea-config', seaConfig]);

  // --- 3. copy runtime + inject -------------------------------------------
  const exe = path.join(DIST, EXE_NAME);
  fs.copyFileSync(process.execPath, exe);
  const fuse = detectFuse(process.execPath);
  log(`fuse: ${fuse}`);
  log(`injecting blob into dist${path.sep}${EXE_NAME} ...`);
  sh(process.execPath, [
    postject, exe, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', fuse,
    '--macho-segment-name', 'NODE_SEA'
  ]);

  const mb = (fs.statSync(exe).size / (1024 * 1024)).toFixed(1);
  log(`done: agent${path.sep}dist${path.sep}${EXE_NAME} (${mb} MB)`);
  log('next: powershell -File agent\\deploy.ps1   (picks up dist\\ automatically)');
}

main();
