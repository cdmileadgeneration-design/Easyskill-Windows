const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const path = require('path');

const execAsync = promisify(exec);
const scriptsDir = path.join(__dirname, '..', 'scripts');

class ActivityMonitor {
  constructor(agent) {
    this.agent = agent;
    this.currentWindow = null;
    this.windowStartTime = null;
    this.isIdle = false;
    this.pollInterval = null;
    this.idleInterval = null;
    this.heartbeatWindowInterval = null;
  }

  async start() {
    console.log('[ActivityMonitor] Starting...');
    this.trackWindowChanges();
    this.trackIdleTime();
    // Emit a segment for long-lived windows so the timeline never has gaps
    this.heartbeatWindowInterval = setInterval(() => this.flushSegment(Date.now(), true), 30000);
  }

  async stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.idleInterval) clearInterval(this.idleInterval);
    if (this.heartbeatWindowInterval) clearInterval(this.heartbeatWindowInterval);
    this.flushSegment(Date.now());
    console.log('[ActivityMonitor] Stopped');
  }

  flushSegment(endTime, continueSegment = false) {
    if (!this.currentWindow || !this.windowStartTime) return;
    // Clamp so a segment can never be inverted or run into the future
    const end = Math.max(this.windowStartTime + 1000, Math.min(endTime, Date.now()));
    const duration = end - this.windowStartTime;
    if (duration < 1000) {
      if (continueSegment) this.windowStartTime = end;
      return;
    }
    const [processName, title] = this.currentWindow.split('|');
    this.agent.logEvent('application_usage', {
      process_name: processName,
      window_title: title,
      exe_path: this.currentExePath || '',
      start_time: new Date(this.windowStartTime).toISOString(),
      end_time: new Date(end).toISOString(),
      duration: Math.floor(duration / 1000),
      user_name: os.userInfo().username
    });
    this.windowStartTime = continueSegment ? end : null;
  }

  trackWindowChanges() {
    this.pollInterval = setInterval(async () => {
      try {
        if (this.isIdle) return;
        const windowInfo = await this.getActiveWindow();
        if (!windowInfo) return;

        const newWindow = `${windowInfo.processName}|${windowInfo.title}`;

        if (newWindow !== this.currentWindow) {
          this.flushSegment(Date.now());
          this.currentWindow = newWindow;
          this.currentExePath = windowInfo.exePath || '';
          this.windowStartTime = Date.now();
        } else if (!this.windowStartTime) {
          this.windowStartTime = Date.now();
          this.currentExePath = windowInfo.exePath || '';
        }
      } catch (e) {}
    }, 2000);
  }

  trackIdleTime() {
    this.idleInterval = setInterval(async () => {
      try {
        const idleMs = await this.getIdleTimeMs();

        if (idleMs > this.agent.config.idleThreshold && !this.isIdle) {
          // Close the active segment at the moment idle actually began
          this.flushSegment(Date.now() - idleMs);
          this.isIdle = true;
          this.windowStartTime = null;
          this.agent.logEvent('system_events', {
            event_type: 'idle_start',
            event_data: JSON.stringify({ idleMs }),
            timestamp: new Date().toISOString(),
            user_name: os.userInfo().username
          });
          console.log(`[ActivityMonitor] User idle for ${Math.round(idleMs / 1000)}s`);
        } else if (idleMs < this.agent.config.idleThreshold && this.isIdle) {
          this.isIdle = false;
          this.currentWindow = null; // re-open a fresh segment when activity resumes
          this.windowStartTime = null;
          this.agent.logEvent('system_events', {
            event_type: 'idle_end',
            event_data: JSON.stringify({ idleMs }),
            timestamp: new Date().toISOString(),
            user_name: os.userInfo().username
          });
          console.log('[ActivityMonitor] User active again');
        }
      } catch (e) {}
    }, 5000);
  }

  async getActiveWindow() {
    try {
      const scriptPath = path.join(scriptsDir, 'get-foreground-window.ps1');
      const { stdout } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 5000 }
      );

      if (stdout.trim()) {
        const info = JSON.parse(stdout.trim());
        return {
          title: info.Title || '',
          processName: info.ProcessName || 'unknown',
          exePath: info.Path || '',
          pid: info.PID
        };
      }
    } catch (e) {}
    return null;
  }

  async getIdleTimeMs() {
    try {
      const scriptPath = path.join(scriptsDir, 'get-idle-time.ps1');
      const { stdout } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 5000 }
      );
      return parseInt(stdout.trim()) || 0;
    } catch (e) {
      return 0;
    }
  }
}

module.exports = { ActivityMonitor };
