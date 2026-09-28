const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const execAsync = promisify(exec);

let lastWindow = null;
let count = 0;

async function poll() {
  const scriptPath = path.join(__dirname, 'scripts', 'get-foreground-window.ps1');
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 5000 }
    );
    const info = JSON.parse(stdout.trim());
    const win = info.ProcessName + '|' + info.Title;
    
    if (win !== lastWindow) {
      count++;
      console.log(`[${count}] Window changed: ${info.ProcessName} - ${info.Title}`);
      lastWindow = win;
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

setInterval(poll, 2000);
poll();
setTimeout(() => process.exit(0), 15000);
