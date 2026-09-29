const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execAsync = promisify(exec);

const CAPTURE_PS = (target) => `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${target.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;

class ScreenshotMonitor {
  constructor(agent) {
    this.agent = agent;
    this.screenshotDir = agent.config.screenshotDir
      ? path.resolve(agent.config.screenshotDir)
      : path.join(os.tmpdir(), 'monitor-agent-screenshots');
    this.captureInterval = null;
    this.keyId = os.hostname() + os.userInfo().username;
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async start() {
    if (this.agent.config.enableScreenshots === false) {
      console.log('[ScreenshotMonitor] Disabled by config');
      return;
    }
    console.log('[ScreenshotMonitor] Starting...');
    const interval = this.agent.config.screenshotInterval || 300000;
    // Capture once shortly after boot so the gallery is never empty, then on interval
    this.initialTimer = setTimeout(() => this.captureAndUpload('startup'), 15000);
    this.captureInterval = setInterval(() => this.captureAndUpload('scheduled'), interval);
  }

  async stop() {
    if (this.captureInterval) clearInterval(this.captureInterval);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    console.log('[ScreenshotMonitor] Stopped');
  }

  async capture() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(this.screenshotDir, `shot_${timestamp}.jpg`);
    await execAsync(`powershell -NoProfile -Command "${CAPTURE_PS(filepath)}"`, { timeout: 20000, windowsHide: true });
    if (!fs.existsSync(filepath)) throw new Error('capture file not created');
    return filepath;
  }

  encryptBuffer(buf) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', crypto.scryptSync(this.keyId, 'monitoring-salt', 32), iv);
    return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
  }

  async captureAndUpload(reason = 'scheduled') {
    let filepath = null;
    try {
      filepath = await this.capture();
      const encrypted = this.encryptBuffer(fs.readFileSync(filepath));
      await this.agent.post('/api/agent/screenshot', {
        machine_name: this.agent.config.machineName,
        image_data: encrypted.toString('base64'),
        key_id: this.keyId,
        timestamp: new Date().toISOString(),
        reason
      });
      console.log(`[ScreenshotMonitor] Uploaded screenshot (${reason})`);
    } catch (e) {
      console.error(`[ScreenshotMonitor] ${reason} capture failed: ${e.message}`);
    } finally {
      if (filepath) { try { fs.unlinkSync(filepath); } catch (e) {} }
    }
  }

  async takeScreenshot(reason = 'manual') {
    await this.captureAndUpload(reason);
  }
}

module.exports = { ScreenshotMonitor };
