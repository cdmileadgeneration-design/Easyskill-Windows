const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const { resolveScript } = require('../lib');

const execAsync = promisify(exec);

// Embedded copies of scripts\get-foreground-window.ps1 and get-idle-time.ps1.
// The single-file build resolves paths from the install folder, so a machine
// that was installed without the scripts\ folder used to lose application
// tracking completely and silently. Keeping the code here means the timeline
// keeps receiving data even when the .ps1 files are missing.
const FOREGROUND_PS = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$hwnd = [Win32]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 256
[Win32]::GetWindowText($hwnd, $title, 256) | Out-Null
$procId = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if ($proc) {
    @{ Title = $title.ToString(); ProcessName = $proc.Name; Path = $proc.Path; PID = $procId } | ConvertTo-Json -Compress
}`;

const IDLE_PS = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleTime {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
}
"@

$info = New-Object IdleTime+LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
[IdleTime]::GetLastInputInfo([ref]$info) | Out-Null
$tickCount = [Environment]::TickCount
$idleMs = $tickCount - $info.dwTime
if ($idleMs -lt 0) { $idleMs += [Int32]::MaxValue }
$idleMs`;

class ActivityMonitor {
  constructor(agent) {
    this.agent = agent;
    this.currentWindow = null;
    this.windowStartTime = null;
    this.isIdle = false;
    this.pollInterval = null;
    this.idleInterval = null;
    this.heartbeatWindowInterval = null;
    this.warnedScripts = new Set();
    this.pollFailures = 0;
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

  // Runs one of the PowerShell helpers. Prefers the .ps1 next to the agent and
  // falls back to the embedded copy, so a broken/missing scripts folder can
  // never silently stop the timeline from being populated.
  async runPowerShell(scriptName, embedded) {
    const scriptPath = resolveScript(scriptName);
    if (scriptPath) {
      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
          { timeout: 5000, windowsHide: true }
        );
        return stdout;
      } catch (e) { /* fall through to the embedded copy */ }
    } else if (!this.warnedScripts.has(scriptName)) {
      this.warnedScripts.add(scriptName);
      this.agent.log(`ActivityMonitor: ${scriptName} not found - using the embedded copy`);
    }
    const encoded = Buffer.from(embedded, 'utf16le').toString('base64');
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: 5000, windowsHide: true }
    );
    return stdout;
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
      } catch (e) {
        // Surface persistent failures instead of swallowing them - this is how
        // a dead activity monitor used to go unnoticed for days.
        this.noteFailure(e.message);
      }
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
      const stdout = await this.runPowerShell('get-foreground-window.ps1', FOREGROUND_PS);
      if (stdout && stdout.trim()) {
        const info = JSON.parse(stdout.trim());
        this.pollFailures = 0;
        return {
          title: info.Title || '',
          processName: info.ProcessName || 'unknown',
          exePath: info.Path || '',
          pid: info.PID
        };
      }
      this.noteFailure('no window info returned');
    } catch (e) {
      this.noteFailure(e.message);
    }
    return null;
  }

  // Reports a failed foreground-window poll (first failure + every ~100s) so a
  // broken install shows up in the agent log instead of silently producing an
  // empty timeline.
  noteFailure(message) {
    this.pollFailures = (this.pollFailures || 0) + 1;
    if (this.pollFailures === 1 || this.pollFailures % 50 === 0) {
      this.agent.log(`ActivityMonitor: window poll failed (${this.pollFailures}x): ${message}`);
    }
  }

  async getIdleTimeMs() {
    try {
      const stdout = await this.runPowerShell('get-idle-time.ps1', IDLE_PS);
      return parseInt((stdout || '').trim()) || 0;
    } catch (e) {
      return 0;
    }
  }
}

module.exports = { ActivityMonitor };
