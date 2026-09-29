'use strict';
// Single entry point for the bundled executable (see tools/build.js).
//   <exe>                      -> supervisor (watchdog)
//   <exe> --supervisor [--once] -> supervisor / keeper
//   <exe> --monitor ...        -> per-session monitor
// Running the files directly (node monitor.js) bypasses this dispatcher.
const argv = process.argv.slice(2);

if (argv.includes('--monitor')) {
  require('./monitor');
} else {
  require('./supervisor');
}
