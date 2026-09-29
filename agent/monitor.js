const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');

const { parseArgs, applyProfile, loadConfig, userTag, appendLog } = require('./lib');

const AGENT_VERSION = '2.2.0';

// Session context flags (--profile/--user/--session) must be applied before any
// monitor reads os.homedir() / process.env.LOCALAPPDATA, otherwise a supervisor
// launching us from Session 0 would pollute the SYSTEM profile instead of the
// logged-in employee's.
const cliArgs = parseArgs(process.argv.slice(2));
applyProfile(cliArgs.profile, cliArgs.user, cliArgs.session);

class MonitoringAgent extends EventEmitter {
  constructor() {
    super();
    this.monitors = {};
    this.isRunning = false;
    this.eventBuffer = [];
    this.currentBatch = null;
    this.sending = false;
    this.consecutiveFailures = 0;
    this.flushTimer = null;
    this.heartbeatTimer = null;

    // Set up file destinations first: loadConfig() may log during a parse
    // failure, so logFile/outboxPath must already be defined.
    this.userName = cliArgs.user || os.userInfo().username || '';
    const tag = userTag(this.userName);
    this.outboxPath = path.join(
      __dirname,
      `outbox-${tag}.json`
    );
    this.logFile = path.join(__dirname, `agent-${tag}.log`);
    this.sessionId = cliArgs.session || '';

    this.config = loadConfig((m) => this.log(m));
    if (this.config.outboxFile) {
      this.outboxPath = path.join(__dirname, this.config.outboxFile);
    }
  }

  log(message) {
    appendLog(this.logFile, message);
    console.log(`[Agent] ${message}`);
  }

  // -------------------------------------------------------------------------
  // Event queue with disk-backed outbox (nothing is lost while offline)
  // -------------------------------------------------------------------------
  logEvent(table, data) {
    this.eventBuffer.push({ _table: table, ...data });
    if (this.eventBuffer.length >= this.config.maxQueue) {
      const dropped = this.eventBuffer.splice(0, Math.floor(this.config.maxQueue / 2));
      this.log(`Queue full - dropped ${dropped.length} oldest events`);
      this.saveOutbox();
    }
    if (this.eventBuffer.length >= this.config.batchSize && !this.sending) {
      this.flushEvents();
    }
  }

  loadOutbox() {
    try {
      if (fs.existsSync(this.outboxPath)) {
        const saved = JSON.parse(fs.readFileSync(this.outboxPath, 'utf8'));
        if (Array.isArray(saved)) {
          // legacy format: plain event array
          if (saved.length) this.eventBuffer = saved.concat(this.eventBuffer);
        } else if (saved && Array.isArray(saved.events)) {
          this.eventBuffer = saved.events.concat(this.eventBuffer);
          this.currentBatch = saved.batch || null;
        }
        if (this.eventBuffer.length) {
          this.log(`Restored ${this.eventBuffer.length} unsent events from outbox`);
        }
      }
    } catch (e) {
      this.log('Outbox load error: ' + e.message);
    }
  }

  saveOutbox() {
    try {
      if (this.eventBuffer.length === 0) {
        this.currentBatch = null;
        if (fs.existsSync(this.outboxPath)) fs.unlinkSync(this.outboxPath);
        return;
      }
      const tmp = this.outboxPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ batch: this.currentBatch, events: this.eventBuffer }));
      fs.renameSync(tmp, this.outboxPath);
    } catch (e) {
      this.log('Outbox save error: ' + e.message);
    }
  }

  async flushEvents() {
    if (this.sending || this.eventBuffer.length === 0) return;
    if (Date.now() < (this.nextAttemptAt || 0)) return; // backoff window
    this.sending = true;
    try {
      while (this.eventBuffer.length > 0) {
        // Reuse the same batch id until the server confirms it, so a lost
        // response can never insert the same events twice.
        if (!this.currentBatch) {
          const events = this.eventBuffer.slice(0, this.config.batchSize);
          this.currentBatch = {
            id: `${this.config.machineName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            events
          };
        }
        const res = await this.post('/api/agent/events', {
          batch_id: this.currentBatch.id,
          events: this.currentBatch.events,
          machine_name: this.config.machineName
        });
        if (!res || res.success !== true) {
          throw new Error(res?.error || (res?.errors && res.errors[0]) || 'server rejected batch');
        }
        this.deliveredCount = (this.deliveredCount || 0) + this.currentBatch.events.length;
        this.eventBuffer.splice(0, this.currentBatch.events.length);
        this.currentBatch = null;
        this.consecutiveFailures = 0;
        this.nextAttemptAt = 0;
      }
      this.saveOutbox(); // clears the file once empty
      if (this.deliveredCount) {
        this.log(`Delivered ${this.deliveredCount} events`);
        this.deliveredCount = 0;
      }
    } catch (e) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
        this.log(`Send failed (${this.consecutiveFailures}x): ${e.message}. ${this.eventBuffer.length} events queued.`);
      }
      this.saveOutbox();
      // exponential backoff: 5s -> 60s
      this.nextAttemptAt = Date.now() + Math.min(5000 * Math.pow(2, Math.min(this.consecutiveFailures, 4)), 60000);
    } finally {
      this.sending = false;
    }
  }

  async sendHeartbeat() {
    try {
      await this.post('/api/agent/heartbeat', {
        machine_name: this.config.machineName,
        hostname: os.hostname(),
        ip: this.getLocalIP(),
        agent_version: AGENT_VERSION
      });
    } catch (e) { /* offline is fine - heartbeat retries */ }
  }

  getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    return '127.0.0.1';
  }

  post(endpoint, body) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.config.serverUrl.replace(/\/+$/, '') + endpoint);
      } catch (e) {
        return reject(new Error('invalid serverUrl: ' + this.config.serverUrl));
      }
      const data = JSON.stringify(body);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': this.config.agentKey,
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 15000
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = { error: raw.slice(0, 200) }; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = parsed?.error || `HTTP ${res.statusCode}`;
            if (res.statusCode === 401) {
              return reject(new Error(`authentication rejected - check agentKey matches the server (${msg})`));
            }
            return reject(new Error(msg));
          }
          resolve(parsed);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async start() {
    if (this.isRunning) return;
    this.log(`Starting agent v${AGENT_VERSION}`);
    this.log(`Machine: ${this.config.machineName}`);
    this.log(`Server:  ${this.config.serverUrl}`);
    this.log(`User:    ${this.userName} (session ${this.sessionId || 'n/a'})`);

    this.loadOutbox();
    this.isRunning = true;

    this.flushTimer = setInterval(() => this.flushEvents(), this.config.sendInterval);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 60000);
    this.sendHeartbeat();
    this.flushEvents();

    const { ActivityMonitor } = require('./monitors/activity-monitor');
    const { WebsiteMonitor } = require('./monitors/website-monitor');
    const { FileMonitor } = require('./monitors/file-monitor');
    const { SystemMonitor } = require('./monitors/system-monitor');
    const { ScreenshotMonitor } = require('./monitors/screenshot-monitor');
    const { UsbMonitor } = require('./monitors/usb-monitor');

    this.monitors.activity = new ActivityMonitor(this);
    this.monitors.website = new WebsiteMonitor(this);
    this.monitors.file = new FileMonitor(this);
    this.monitors.system = new SystemMonitor(this);
    this.monitors.screenshot = new ScreenshotMonitor(this);
    this.monitors.usb = new UsbMonitor(this);

    for (const [name, monitor] of Object.entries(this.monitors)) {
      try {
        await monitor.start();
        this.log(`Monitor started: ${name}`);
      } catch (e) {
        this.log(`Error starting ${name} monitor: ${e.message}`);
      }
    }

    this.log('All monitors started');
  }

  async stop() {
    if (!this.isRunning) return;
    this.log('Stopping agent...');

    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    for (const monitor of Object.values(this.monitors)) {
      try { await monitor.stop(); } catch (e) {}
    }

    try { await this.flushEvents(); } catch (e) {}
    this.saveOutbox();
    this.isRunning = false;
    this.log(`Agent stopped (${this.eventBuffer.length} events still queued)`);
  }
}

const agent = new MonitoringAgent();

process.on('SIGTERM', () => agent.stop().then(() => process.exit(0)));
process.on('SIGINT', () => agent.stop().then(() => process.exit(0)));

process.on('uncaughtException', (err) => {
  agent.log(`Uncaught exception: ${err.message}`);
  try { agent.saveOutbox(); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => agent.log(`Unhandled rejection: ${reason}`));

agent.start().catch((err) => {
  agent.log(`Failed to start: ${err.message}`);
  process.exit(1);
});

module.exports = agent;
