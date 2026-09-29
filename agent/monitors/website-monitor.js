const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');

// sql-wasm.wasm ships next to the executable in the bundled build (deploy.ps1
// copies it into the install folder) and stays in node_modules when the agent
// runs from source.
const WASM_CANDIDATES = [
  path.join(__dirname, 'sql-wasm.wasm'),
  path.join(process.cwd(), 'sql-wasm.wasm'),
  path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
];

function locateWasm(file) {
  for (const p of WASM_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* keep looking */ }
  }
  const missing = WASM_CANDIDATES.map(p => `\n  - ${p}`).join('');
  throw new Error(`sql-wasm.wasm not found (reinstall the agent so it is copied next to the executable). Looked for:${missing}`);
}

class WebsiteMonitor {
  constructor(agent) {
    this.agent = agent;
    this.browsers = {
      chrome: this.getChromeHistoryPaths(),
      edge: this.getEdgeHistoryPaths(),
      firefox: this.getFirefoxHistoryPaths()
    };
    this.lastChecked = {};
    this.checkInterval = null;
    this.parseFailures = {};
  }

  // Chrome/Edge ship with a "Default" profile plus any number of "Profile N"
  // profiles - watching only "Default" meant a machine with a named profile
  // reported no websites at all.
  profileHistoryPaths(userDataDir, profileFile) {
    const out = [];
    try {
      if (!fs.existsSync(userDataDir)) return out;
      for (const entry of fs.readdirSync(userDataDir)) {
        if (entry !== 'Default' && !entry.startsWith('Profile ')) continue;
        const dbPath = path.join(userDataDir, entry, profileFile);
        try { if (fs.existsSync(dbPath)) out.push(dbPath); } catch (e) { /* skip */ }
      }
    } catch (e) { /* profile folder unreadable */ }
    return out;
  }

  getChromeHistoryPaths() {
    const userData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return this.profileHistoryPaths(path.join(userData, 'Google', 'Chrome', 'User Data'), 'History');
  }

  getEdgeHistoryPaths() {
    const userData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return this.profileHistoryPaths(path.join(userData, 'Microsoft', 'Edge', 'User Data'), 'History');
  }

  getFirefoxHistoryPaths() {
    const userData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const profiles = path.join(userData, 'Mozilla', 'Firefox', 'Profiles');
    const out = [];

    try {
      if (!fs.existsSync(profiles)) return out;
      for (const dir of fs.readdirSync(profiles)) {
        if (dir.endsWith('.default-release') || dir.endsWith('.default')) {
          const dbPath = path.join(profiles, dir, 'places.sqlite');
          if (fs.existsSync(dbPath)) out.push(dbPath);
        }
      }
    } catch (e) { /* profile folder unreadable */ }
    return out;
  }

  async start() {
    console.log('[WebsiteMonitor] Starting...');
    this.checkBrowsers();
    this.checkInterval = setInterval(() => this.checkBrowsers(), 60000);
  }

  async stop() {
    if (this.checkInterval) clearInterval(this.checkInterval);
    console.log('[WebsiteMonitor] Stopped');
  }

  async checkBrowsers() {
    for (const [browser, dbPaths] of Object.entries(this.browsers)) {
      for (const dbPath of dbPaths) {
        if (!dbPath || !fs.existsSync(dbPath)) continue;
        try {
          await this.parseBrowserHistory(browser, dbPath);
        } catch (e) {
          // Browser might be locked - retried on the next tick. Log the first
          // failure and then every 50th so a permanently broken parse is
          // visible in the agent log instead of silently losing websites.
          const n = (this.parseFailures[browser] = (this.parseFailures[browser] || 0) + 1);
          if (n === 1 || n % 50 === 0) this.agent.log(`WebsiteMonitor: ${browser} history read failed (${n}x): ${e.message}`);
        }
      }
    }
  }

  async parseBrowserHistory(browser, dbPath) {
    const tempPath = path.join(os.tmpdir(), `${browser}_history_temp.db`);

    try {
      fs.copyFileSync(dbPath, tempPath);

      const SQL = await initSqlJs({ locateFile: locateWasm });
      const filebuffer = fs.readFileSync(tempPath);
      const db = new SQL.Database(filebuffer);

      const lastCheck = this.lastChecked[browser] || 0;
      let query;

      if (browser === 'firefox') {
        query = lastCheck === 0
          ? `SELECT url, title, visit_count, last_visit_date / 1000000 as visit_time FROM moz_places ORDER BY last_visit_date DESC LIMIT 1`
          : `SELECT url, title, visit_count, last_visit_date / 1000000 as visit_time FROM moz_places WHERE last_visit_date > ${lastCheck * 1000000} ORDER BY last_visit_date DESC LIMIT 50`;
      } else {
        // Chrome/Edge use Windows FILETIME (microseconds since 1601)
        const windowsEpochOffset = 11644473600000000;
        const minTime = (lastCheck * 1000) + windowsEpochOffset;
        query = lastCheck === 0
          ? `SELECT url, title, last_visit_time, visit_count FROM urls ORDER BY last_visit_time DESC LIMIT 1`
          : `SELECT url, title, last_visit_time, visit_count FROM urls WHERE last_visit_time > ${minTime} ORDER BY last_visit_time DESC LIMIT 50`;
      }

      const results = [];
      const stmt = db.prepare(query);
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();

      // First run = baseline only: remember the newest visit so we start
      // recording from "now" instead of importing months of old history.
      if (lastCheck === 0) {
        this.lastChecked[browser] = Date.now();
        db.close();
        return;
      }

      for (const row of results) {
        let visitTime;
        if (browser === 'firefox') {
          visitTime = new Date(row.visit_time).toISOString();
        } else {
          const windowsEpochOffset = 11644473600000000;
          visitTime = new Date((row.last_visit_time - windowsEpochOffset) / 1000).toISOString();
        }

        this.agent.logEvent('website_visits', {
          url: row.url || '',
          title: row.title || '',
          browser: browser,
          visit_time: visitTime,
          duration: 0,
          user_name: os.userInfo().username
        });
      }

      this.lastChecked[browser] = Date.now();
      db.close();
    } catch (e) {
      // Browser might be locked or the profile corrupted - never crash the
      // agent, but let checkBrowsers() report it instead of staying silent.
      throw e;
    } finally {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

module.exports = { WebsiteMonitor };
