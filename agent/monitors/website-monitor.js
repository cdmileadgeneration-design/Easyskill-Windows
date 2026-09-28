const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');

class WebsiteMonitor {
  constructor(agent) {
    this.agent = agent;
    this.browsers = {
      chrome: this.getChromeHistoryPath(),
      edge: this.getEdgeHistoryPath(),
      firefox: this.getFirefoxHistoryPath()
    };
    this.lastChecked = {};
    this.checkInterval = null;
  }

  getChromeHistoryPath() {
    const userData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(userData, 'Google', 'Chrome', 'User Data', 'Default', 'History');
  }

  getEdgeHistoryPath() {
    const userData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(userData, 'Microsoft', 'Edge', 'User Data', 'Default', 'History');
  }

  getFirefoxHistoryPath() {
    const userData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const profiles = path.join(userData, 'Mozilla', 'Firefox', 'Profiles');

    if (fs.existsSync(profiles)) {
      const dirs = fs.readdirSync(profiles);
      for (const dir of dirs) {
        if (dir.endsWith('.default-release') || dir.endsWith('.default')) {
          return path.join(profiles, dir, 'places.sqlite');
        }
      }
    }
    return null;
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
    for (const [browser, dbPath] of Object.entries(this.browsers)) {
      if (dbPath && fs.existsSync(dbPath)) {
        try {
          await this.parseBrowserHistory(browser, dbPath);
        } catch (e) {
          // Browser might be locked - retried on the next tick
        }
      }
    }
  }

  async parseBrowserHistory(browser, dbPath) {
    const tempPath = path.join(os.tmpdir(), `${browser}_history_temp.db`);

    try {
      fs.copyFileSync(dbPath, tempPath);

      const SQL = await initSqlJs();
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
      // Browser might be locked or the profile corrupted - never crash the agent
    } finally {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

module.exports = { WebsiteMonitor };
