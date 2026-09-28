const chokidar = require('chokidar');
const path = require('path');
const os = require('os');
const fs = require('fs');

class FileMonitor {
  constructor(agent) {
    this.agent = agent;
    this.watchers = [];
    this.recentCheckInterval = null;
    this.seenRecentLinks = new Set();
    this.projectDir = path.resolve(__dirname, '..', '..');
  }

  getWatchedPaths() {
    const homeDir = os.homedir();
    return [
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Documents'),
      path.join(homeDir, 'Downloads')
    ].filter(p => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch (e) {
        return false;
      }
    });
  }

  async start() {
    console.log('[FileMonitor] Starting...');

    const watchedPaths = this.getWatchedPaths();
    for (const watchPath of watchedPaths) {
      try {
        const watcher = chokidar.watch(watchPath, {
          persistent: true,
          ignoreInitial: true,
          depth: 2,
          ignored: [
            /(^|[\/\\])\../,
            /node_modules/,
            /\.tmp$/,
            /\.temp$/,
            /Thumbs\.db$/i,
            /desktop\.ini$/i,
            /~\$/,
            /windows monitoring software/
          ],
          awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 750
          }
        });

        watcher
          .on('add', (fp) => this.logFileEvent(fp, 'create'))
          .on('unlink', (fp) => this.logFileEvent(fp, 'delete'))
          .on('change', (fp) => this.logFileEvent(fp, 'modify'));

        watcher.on('error', () => {});
        this.watchers.push(watcher);
        console.log(`[FileMonitor] Watching: ${watchPath}`);
      } catch (e) {
        console.error(`[FileMonitor] Cannot watch ${watchPath}:`, e.message);
      }
    }

    this.monitorRecentFiles();
  }

  async stop() {
    for (const watcher of this.watchers) {
      try { await watcher.close(); } catch (e) {}
    }
    this.watchers = [];
    if (this.recentCheckInterval) clearInterval(this.recentCheckInterval);
    console.log('[FileMonitor] Stopped');
  }

  isProjectFile(filePath) {
    return filePath.startsWith(this.projectDir);
  }

  logFileEvent(filePath, activityType) {
    if (this.isProjectFile(filePath)) return;

    if (filePath.includes('\\AppData\\') ||
        filePath.includes('\\System32\\') ||
        filePath.includes('\\Windows\\') ||
        filePath.includes('\\My Music\\') ||
        filePath.includes('\\My Videos\\') ||
        filePath.includes('\\My Pictures\\')) {
      return;
    }

    const fileName = path.basename(filePath);
    if (fileName.startsWith('.') || fileName === 'Thumbs.db' || fileName === 'desktop.ini') return;

    this.agent.logEvent('file_activities', {
      file_path: filePath,
      activity_type: activityType,
      timestamp: new Date().toISOString(),
      user_name: os.userInfo().username
    });
  }

  monitorRecentFiles() {
    const recentDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');

    const checkRecent = async () => {
      try {
        if (!fs.existsSync(recentDir)) return;

        const files = fs.readdirSync(recentDir).filter(f => f.endsWith('.lnk'));

        for (const linkFile of files) {
          if (this.seenRecentLinks.has(linkFile)) continue;
          this.seenRecentLinks.add(linkFile);

          const linkPath = path.join(recentDir, linkFile);
          const stat = fs.statSync(linkPath);
          const fiveMinAgo = Date.now() - 5 * 60 * 1000;

          if (stat.mtimeMs < fiveMinAgo) continue;

          try {
            const target = await this.resolveLnk(linkPath);
            if (target && !this.isProjectFile(target)) {
              const ext = path.extname(target).toLowerCase();
              const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.svg', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.zip', '.rar', '.7z', '.tar', '.gz', '.html', '.htm', '.xml', '.json', '.md', '.log'];

              if (docExts.includes(ext)) {
                this.agent.logEvent('file_activities', {
                  file_path: target,
                  activity_type: 'open',
                  timestamp: new Date().toISOString(),
                  user_name: os.userInfo().username
                });
                console.log(`[FileMonitor] File opened: ${target}`);
              }
            }
          } catch (e) {}
        }

        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const seen of this.seenRecentLinks) {
          const seenPath = path.join(recentDir, seen);
          try {
            if (!fs.existsSync(seenPath)) {
              this.seenRecentLinks.delete(seen);
            }
          } catch (e) {
            this.seenRecentLinks.delete(seen);
          }
        }
      } catch (e) {}
    };

    checkRecent();
    this.recentCheckInterval = setInterval(checkRecent, 5000);
  }

  resolveLnk(lnkPath) {
    return new Promise((resolve) => {
      const ps = `$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $shortcut.TargetPath`;
      const { exec } = require('child_process');
      exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
        } else {
          const target = stdout.trim();
          if (target && fs.existsSync(target)) {
            resolve(target);
          } else {
            resolve(null);
          }
        }
      });
    });
  }
}

module.exports = { FileMonitor };
