#!/usr/bin/env node
// Change the dashboard admin password (stores a bcrypt hash in config.json).
// Usage: node dashboard/set-password.js <username> <newPassword>

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.log('Usage: node dashboard/set-password.js <username> <newPassword>');
  console.log('Example: node dashboard/set-password.js admin "S3cure!Passw0rd"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Error: password must be at least 8 characters.');
  process.exit(1);
}

const configPath = path.join(__dirname, '..', 'config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.security = cfg.security || {};
cfg.security.adminUser = username;
cfg.security.adminPasswordHash = bcrypt.hashSync(password, 12);
cfg.security.adminPassword = ''; // never keep the plaintext once hashed
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

console.log(`Admin credentials updated.`);
console.log(`  Username: ${username}`);
console.log(`  Password: <hashed in config.json>`);
console.log('Restart the dashboard server to apply the change.');
