process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');
const isWin = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

console.log('\n========== Build standard package ==========\n');
const result = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'dist'], {
  stdio: 'inherit',
  shell: isWin,
  cwd,
});

if (result.status !== 0) {
  console.error('Standard package build failed.');
  process.exit(result.status || 1);
}

console.log('\n========== Build completed ==========');
console.log('Output directory: release/');
console.log('  Installer: OverseasDrama-Setup-x.x.x.exe');
console.log('  Portable: OverseasDrama-x.x.x.exe\n');
process.exit(0);
