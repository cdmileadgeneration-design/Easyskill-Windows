const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execAsync = promisify(exec);

async function test() {
  const scriptPath = path.join(__dirname, 'scripts', 'get-foreground-window.ps1');
  console.log('Script path:', scriptPath);
  console.log('Exists:', fs.existsSync(scriptPath));

  try {
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 5000 }
    );
    console.log('stdout:', stdout);
    if (stderr) console.log('stderr:', stderr);

    if (stdout.trim()) {
      const info = JSON.parse(stdout.trim());
      console.log('Parsed window info:', info);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}
test();
