const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

// Screenshots that could not be uploaded are kept here (bounded) and retried on
// the following cycles instead of being thrown away, so one slow/failed request
// never punches a permanent hole in the gallery.
const MAX_PENDING = 15;
const MAX_PENDING_BYTES = 24 * 1024 * 1024;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const CAPTURE_RETRIES = 2;

// Defaults for the encoded image. A raw full-resolution screen bitmap saved as
// PNG (what `Bitmap.Save(path)` does when no encoder is given) is several MB on
// 1080p and 10-20MB on 2K/4K displays. Those uploads were rejected by the
// dashboard (20mb JSON limit / 15mb image limit) or timed out, which is why
// only the PCs with small or low-resolution screens kept their gallery filled.
// Encoding a downscaled JPEG keeps every capture around 150-400kb.
const DEFAULT_MAX_WIDTH = 1920;
const DEFAULT_JPEG_QUALITY = 70;

function intInRange(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Captures the primary screen (falls back to the virtual screen when Windows
// reports no primary display). The script is passed to powershell with
// -EncodedCommand, so it never travels through cmd.exe quoting and
// powershell.exe is the direct child - Node's timeout kills that process
// instead of leaking an orphaned shell on every failed capture.
const CAPTURE_PS = ({ target, maxWidth, quality }) => `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = $null
try { if ([System.Windows.Forms.Screen]::PrimaryScreen) { $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds } } catch {}
if (-not $bounds) { $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen }
if (-not $bounds -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'no screen bounds available (display disconnected or no interactive session)' }
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
} finally {
  $g.Dispose()
}
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
if (-not $codec) { $bmp.Dispose(); throw 'no JPEG encoder available in System.Drawing' }
function Save-Jpeg([System.Drawing.Bitmap]$image, [string]$file) {
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
  try { $image.Save($file, $codec, $params) } finally { $params.Dispose() }
}
try {
  $outW = $bmp.Width
  $outH = $bmp.Height
  if ($outW -gt ${maxWidth}) {
    $scale = ${maxWidth} / $outW
    $outW = [int][Math]::Round($bmp.Width * $scale)
    $outH = [int][Math]::Round($bmp.Height * $scale)
  }
  if ($outW -ge 1 -and $outH -ge 1 -and $outW -ne $bmp.Width) {
    $scaled = New-Object System.Drawing.Bitmap($outW, $outH)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $sg.DrawImage($bmp, 0, 0, $outW, $outH)
    } finally { $sg.Dispose() }
    try { Save-Jpeg $scaled '${target.replace(/'/g, "''")}' } finally { $scaled.Dispose() }
  } else {
    Save-Jpeg $bmp '${target.replace(/'/g, "''")}'
  }
} finally {
  $bmp.Dispose()
}`;

function errorMessage(e) {
  const stderr = e && typeof e.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr.split('\n').slice(-3).join(' ').slice(0, 300);
  return (e && e.message) || String(e);
}

class ScreenshotMonitor {
  constructor(agent) {
    this.agent = agent;
    this.screenshotDir = agent.config.screenshotDir
      ? path.resolve(agent.config.screenshotDir)
      : path.join(os.tmpdir(), 'monitor-agent-screenshots');
    this.captureInterval = null;
    this.initialTimer = null;
    this.keyId = os.hostname() + os.userInfo().username;
    this.busy = false;
    this.pending = [];
    this.consecutiveFailures = 0;
    this.ensureDir();
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
      fs.accessSync(this.screenshotDir, fs.constants.W_OK);
    } catch (e) {
      // A read-only / redirected profile must not abort the whole agent: fall
      // back to the system temp folder and keep capturing.
      const fallback = path.join(os.tmpdir(), 'monitor-agent-screenshots');
      if (fallback !== this.screenshotDir) {
        try {
          fs.mkdirSync(fallback, { recursive: true });
          this.agent.log(`ScreenshotMonitor: ${this.screenshotDir} is not writable (${e.message}) - using ${fallback}`);
          this.screenshotDir = fallback;
        } catch (e2) {
          this.agent.log(`ScreenshotMonitor: cannot create screenshot folder: ${e2.message}`);
        }
      }
    }
  }

  async start() {
    if (this.agent.config.enableScreenshots === false) {
      this.agent.log('ScreenshotMonitor: disabled by config');
      return;
    }
    const interval = this.agent.config.screenshotInterval || 60000;
    this.agent.log(`ScreenshotMonitor: starting (every ${Math.round(interval / 1000)}s, dir ${this.screenshotDir})`);
    // Capture once shortly after boot so the gallery is never empty, then on interval
    this.initialTimer = setTimeout(() => this.captureAndUpload('startup'), 15000);
    this.captureInterval = setInterval(() => this.captureAndUpload('scheduled'), interval);
  }

  async stop() {
    if (this.captureInterval) clearInterval(this.captureInterval);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.captureInterval = null;
    this.initialTimer = null;
    this.agent.log(`ScreenshotMonitor: stopped (${this.pending.length} screenshot(s) never delivered)`);
  }

  async capture() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(this.screenshotDir, `shot_${timestamp}.jpg`);
    const maxWidth = intInRange(this.agent.config.screenshotMaxWidth, DEFAULT_MAX_WIDTH, 640, 3840);
    const quality = intInRange(this.agent.config.screenshotQuality, DEFAULT_JPEG_QUALITY, 30, 90);
    const script = CAPTURE_PS({ target: filepath, maxWidth, quality });
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
      );
    } catch (e) {
      const msg = errorMessage(e);
      // The most common (and previously silent) cause: the agent is not inside
      // the employee's interactive desktop, or the display/session is gone.
      if (/handle is invalid|access is denied|not supported/i.test(msg)) {
        throw new Error(`screen capture blocked - ${msg} (agent is not running in the logged-in user session)`);
      }
      throw new Error(msg);
    }
    if (!fs.existsSync(filepath)) throw new Error('capture file not created');
    const size = fs.statSync(filepath).size;
    if (!size) throw new Error('capture file is empty');
    return { filepath, size };
  }

  async captureWithRetry() {
    let lastError = null;
    for (let attempt = 1; attempt <= CAPTURE_RETRIES; attempt++) {
      try {
        return await this.capture();
      } catch (e) {
        lastError = e;
        if (attempt < CAPTURE_RETRIES) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastError;
  }

  encryptBuffer(buf) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', crypto.scryptSync(this.keyId, 'monitoring-salt', 32), iv);
    return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
  }

  // Large images on a slow link need far more than the generic 15s the event
  // queue uses - scale the timeout with the payload so a 4MB screenshot is not
  // dropped while the (small) activity batches sail through.
  uploadTimeoutMs(body) {
    const bytes = (body.image_data && body.image_data.length) || 0;
    return Math.min(120000, 30000 + Math.ceil(bytes / 40000) * 1000);
  }

  async upload(body) {
    const res = await this.agent.post('/api/agent/screenshot', body, { timeoutMs: this.uploadTimeoutMs(body) });
    if (!res || res.success !== true) {
      throw new Error((res && res.error) || 'server did not accept the screenshot');
    }
    return res;
  }

  async captureAndUpload(reason = 'scheduled') {
    if (this.busy) return; // never overlap captures or uploads
    this.busy = true;
    try {
      await this.flushPending();

      const { filepath, size } = await this.captureWithRetry();
      let buf;
      try {
        buf = fs.readFileSync(filepath);
      } finally {
        try { fs.unlinkSync(filepath); } catch (e) { /* best effort */ }
      }
      if (!buf.length) throw new Error('screenshot buffer is empty');

      const body = {
        machine_name: this.agent.config.machineName,
        image_data: this.encryptBuffer(buf).toString('base64'),
        key_id: this.keyId,
        timestamp: new Date().toISOString(),
        reason
      };

      try {
        await this.upload(body);
        this.noteSuccess(size, reason);
      } catch (e) {
        this.enqueue(body, e, reason);
      }
    } catch (e) {
      this.noteFailure(`${reason} capture failed: ${errorMessage(e)}`);
    } finally {
      this.busy = false;
    }
  }

  async flushPending() {
    while (this.pending.length) {
      const item = this.pending[0];
      if (Date.now() - item.at > PENDING_MAX_AGE_MS) {
        this.pending.shift();
        this.agent.log(`ScreenshotMonitor: dropped ${Math.round((Date.now() - item.at) / 60000)}min old undelivered screenshot`);
        continue;
      }
      try {
        await this.upload(item.body);
        this.pending.shift();
        this.consecutiveFailures = 0;
        this.agent.log(`ScreenshotMonitor: uploaded queued screenshot (${this.pending.length} still queued)`);
      } catch (e) {
        item.attempts += 1;
        this.noteFailure(`queued upload failed (${item.attempts}x): ${errorMessage(e)}`);
        return; // server/network still unhappy - try again on the next cycle
      }
    }
  }

  enqueue(body, error, reason) {
    this.pending.push({ body, at: Date.now(), attempts: 1, reason });
    let bytes = this.pending.reduce((n, item) => n + item.body.image_data.length, 0);
    while (this.pending.length > MAX_PENDING || (bytes > MAX_PENDING_BYTES && this.pending.length > 1)) {
      const dropped = this.pending.shift();
      bytes -= dropped.body.image_data.length;
      this.agent.log('ScreenshotMonitor: retry queue full - dropped oldest undelivered screenshot');
    }
    this.noteFailure(`${reason} upload failed, queued for retry: ${errorMessage(error)} (${this.pending.length} queued)`);
  }

  noteSuccess(size, reason) {
    this.consecutiveFailures = 0;
    this.agent.log(`ScreenshotMonitor: uploaded ${reason} screenshot (${Math.round(size / 1024)}kb)`);
  }

  // Log the first failure and then every 10th, so a broken install is visible in
  // agent.log without the file being flooded while the problem persists.
  noteFailure(message) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
      this.agent.log(`ScreenshotMonitor: ${message} (${this.consecutiveFailures} consecutive failures)`);
    }
  }

  async takeScreenshot(reason = 'manual') {
    await this.captureAndUpload(reason);
  }
}

module.exports = { ScreenshotMonitor };
