const fs = require('fs');
const path = require('path');

const appDir = process.argv[2];

if (!appDir) {
  console.error('Usage: node scripts/sync-chat-widget.js <app-dir>');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'packages/chat-widget/index.js');
const targetDir = path.join(repoRoot, appDir, 'public');
const target = path.join(targetDir, 'chat-widget.js');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`Synced chat widget to ${path.relative(repoRoot, target)}`);
