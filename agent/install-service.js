const { Service } = require('node-windows');
const path = require('path');
const fs = require('fs');

const svc = new Service({
  name: 'Windows Employee Monitor',
  description: 'Employee Activity Monitoring Service - Tracks application usage, websites, files, and screenshots',
  script: path.join(__dirname, 'monitor.js'),
  nodeOptions: [],
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "NODE_OPTIONS", value: "--max-old-space-size=512" }
  ],
  wait: 5,
  grow: 0.5,
  maxRestarts: 10
});

let installDir = path.join(__dirname);

svc.on('install', () => {
  console.log('[OK] Service installed successfully');
  console.log('[INFO] Starting service...');
  svc.start();
});

svc.on('start', () => {
  console.log('[OK] Service started');
  logServiceStatus('STARTED');
});

svc.on('stop', () => {
  console.log('[OK] Service stopped');
  logServiceStatus('STOPPED');
});

svc.on('pause', () => {
  console.log('[OK] Service paused');
});

svc.on('continue', () => {
  console.log('[OK] Service continued');
});

svc.on('error', (err) => {
  console.error('[ERROR] Service error:', err.message || err);
  logServiceStatus('ERROR: ' + (err.message || 'Unknown error'));
});

svc.on('alreadyinstalled', () => {
  console.log('[INFO] Service is already installed');
});

svc.on('invalidinstallation', () => {
  console.error('[ERROR] Invalid installation detected');
});

function logServiceStatus(status) {
  const logFile = path.join(installDir, 'service.log');
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${status}\n`;
  
  try {
    fs.appendFileSync(logFile, logEntry);
  } catch (e) {
    // Ignore log errors
  }
}

function showHelp() {
  console.log('');
  console.log('Windows Employee Monitor - Service Manager');
  console.log('===========================================');
  console.log('');
  console.log('Usage: node install-service.js [command]');
  console.log('');
  console.log('Commands:');
  console.log('  --install    Install and start the service');
  console.log('  --uninstall  Stop and remove the service');
  console.log('  --start      Start the service');
  console.log('  --stop       Stop the service');
  console.log('  --restart    Restart the service');
  console.log('  --status     Show service status');
  console.log('  --help       Show this help message');
  console.log('');
}

function checkStatus() {
  const logFile = path.join(installDir, 'service.log');
  const configPath = path.join(installDir, 'config.json');
  
  console.log('');
  console.log('Service Status');
  console.log('==============');
  
  // Check config
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('Server URL:  ' + (config.serverUrl || 'Not configured'));
      console.log('Agent Key:   ' + (config.agentKey ? '****' + config.agentKey.slice(-4) : 'Not configured'));
      console.log('Machine:     ' + (config.machineName || 'Auto-detect'));
    } catch (e) {
      console.log('Config:      Error reading config');
    }
  } else {
    console.log('Config:      Not found');
  }
  
  // Check log
  if (fs.existsSync(logFile)) {
    try {
      const logs = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      const lastLog = logs[logs.length - 1];
      console.log('Last Event:  ' + lastLog);
    } catch (e) {
      console.log('Log:         No entries');
    }
  } else {
    console.log('Log:         No log file');
  }
  
  // Check monitor.js
  const monitorPath = path.join(installDir, 'monitor.js');
  console.log('Agent File:  ' + (fs.existsSync(monitorPath) ? 'Present' : 'Missing'));
  
  // Check node_modules
  const nmPath = path.join(installDir, 'node_modules');
  console.log('Dependencies:' + (fs.existsSync(nmPath) ? ' Installed' : ' Missing'));
  
  console.log('');
}

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  showHelp();
} else if (args.includes('--install') || args.includes('-i')) {
  console.log('');
  console.log('Installing Windows Employee Monitor service...');
  console.log('');
  svc.install();
} else if (args.includes('--uninstall') || args.includes('-u')) {
  console.log('');
  console.log('Uninstalling Windows Employee Monitor service...');
  console.log('');
  svc.uninstall();
} else if (args.includes('--start') || args.includes('-s')) {
  console.log('Starting service...');
  svc.start();
} else if (args.includes('--stop') || args.includes('-x')) {
  console.log('Stopping service...');
  svc.stop();
} else if (args.includes('--restart') || args.includes('-r')) {
  console.log('Restarting service...');
  svc.on('stop', () => {
    svc.start();
  });
  svc.stop();
} else if (args.includes('--status')) {
  checkStatus();
} else {
  showHelp();
}
