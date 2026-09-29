const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

class SystemMonitor {
  constructor(agent) {
    this.agent = agent;
    this.processInterval = null;
    this.networkInterval = null;
    this.softwareInterval = null;
  }

  async start() {
    console.log('[SystemMonitor] Starting...');
    
    this.trackStartupShutdown();
    this.trackProcesses();
    this.trackNetworkConnections();
    this.trackInstalledSoftware();
    
    // Log initial startup
    this.agent.logEvent('system_events', {
      event_type: 'system_start',
      event_data: JSON.stringify({
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime()
      }),
      timestamp: new Date().toISOString()
    });
  }

  async stop() {
    if (this.processInterval) clearInterval(this.processInterval);
    if (this.networkInterval) clearInterval(this.networkInterval);
    if (this.softwareInterval) clearInterval(this.softwareInterval);
    
    // Log shutdown
    this.agent.logEvent('system_events', {
      event_type: 'system_shutdown',
      event_data: JSON.stringify({ hostname: os.hostname() }),
      timestamp: new Date().toISOString()
    });
    
    console.log('[SystemMonitor] Stopped');
  }

  async trackStartupShutdown() {
    try {
      // Only report an unexpected shutdown if it happened recently, otherwise
      // every agent start would re-report a historic power-loss event.
      const { stdout } = await execAsync(
        'wevtutil qe System /f:text /c:3 /rd:true /q:"Event[System[EventID=1074 or EventID=6006 or EventID=6008]]"',
        { windowsHide: true }
      );

      if (/6008/.test(stdout)) {
        const dates = [...stdout.matchAll(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/g)];
        const recent = dates.some(m => {
          const t = new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00`);
          return Date.now() - t.getTime() < 24 * 3600 * 1000;
        });
        if (recent) {
          this.agent.logEvent('system_events', {
            event_type: 'unexpected_shutdown',
            event_data: JSON.stringify({ details: 'System restarted unexpectedly' }),
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {}
  }

  trackProcesses() {
    const interval = this.agent.config.processPollInterval || 300000;
    this.processInterval = setInterval(async () => {
      try {
        const { stdout } = await execAsync(
          'powershell -Command "Get-Process | Select-Object Name, Id, WorkingSet64, CPU | ConvertTo-Json"',
          { windowsHide: true }
        );

        const processes = JSON.parse(stdout);
        const processList = Array.isArray(processes) ? processes : [processes];

        for (const proc of processList.slice(0, 40)) {
          if (proc.Name && proc.Id > 0) {
            this.agent.logEvent('processes', {
              process_name: proc.Name,
              pid: proc.Id,
              memory_usage: proc.WorkingSet64 || 0,
              cpu_usage: proc.CPU || 0,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (e) {}
    }, interval);
  }

  trackNetworkConnections() {
    const interval = this.agent.config.networkPollInterval || 300000;
    this.networkInterval = setInterval(async () => {
      try {
        const { stdout } = await execAsync('netstat -ano', { windowsHide: true });

        const lines = stdout.split('\n');
        const connections = [];

        for (const line of lines) {
          const match = line.match(/(TCP|UDP)\s+([\d.]+:\d+)\s+([\d.:*]+)\s+(\w+)/);
          if (match) {
            connections.push({
              protocol: match[1],
              local: match[2],
              remote: match[3],
              status: match[4]
            });
          }
        }

        // Deduplicate by remote endpoint to keep the table small
        const seen = new Set();
        const uniqueConnections = [];
        for (const conn of connections) {
          const key = `${conn.remote}|${conn.status}`;
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueConnections.push(conn);
          if (uniqueConnections.length >= 50) break;
        }

        for (const conn of uniqueConnections) {
          this.agent.logEvent('network_connections', {
            local_address: conn.local,
            remote_address: conn.remote,
            status: conn.status,
            process_name: '',
            timestamp: new Date().toISOString()
          });
        }
      } catch (e) {}
    }, interval);
  }

  trackInstalledSoftware() {
    const checkSoftware = async () => {
      try {
        const { stdout } = await execAsync(
          'powershell -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate | ConvertTo-Json"',
          { windowsHide: true }
        );

        const software = JSON.parse(stdout);
        const softwareList = Array.isArray(software) ? software : [software];

        for (const sw of softwareList) {
          if (sw.DisplayName) {
            this.agent.logEvent('installed_software', {
              name: sw.DisplayName,
              version: sw.DisplayVersion || '',
              publisher: sw.Publisher || '',
              install_date: sw.InstallDate || '',
              last_checked: new Date().toISOString()
            });
          }
        }
      } catch (e) {}
    };

    checkSoftware();
    this.softwareInterval = setInterval(checkSoftware, 3600000);
  }
}

module.exports = { SystemMonitor };
