process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');
const isWin = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

console.log('\n========== [1/2] Build standard package ==========\n');
const result = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'dist'], {
  stdio: 'inherit',
  shell: isWin,
  cwd,
});

if (result.status !== 0) {
  console.error('Standard package build failed.');
  process.exit(result.status || 1);
}

// 第二步：纯净版构建（不含示例资源），前端/后端已准备好，直接调 electron-builder
console.log('\n========== [2/2] Build Lite package ==========\n');
const clean = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'clean:unpacked'], {
  stdio: 'inherit',
  shell: isWin,
  cwd,
});
if (clean.status !== 0) {
  console.error('清理 win-unpacked 失败，请关闭正在运行的 exe 后重试。');
  process.exit(clean.status || 1);
}
const lite = spawnSync(
  isWin ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', '--config', 'electron-builder-lite.json'],
  {
    stdio: 'inherit',
    shell: isWin,
    cwd,
  }
);
if (lite.status !== 0) {
  console.error('纯净版构建失败。');
  process.exit(lite.status || 1);
}

console.log('\n========== Build completed ==========');
console.log('Output directory: release/');
console.log('  Installer: OverseasDrama-Setup-x.x.x.exe');
console.log('  Portable: OverseasDrama-x.x.x.exe');
console.log('  Lite artifacts: see electron-builder-lite.json naming\n');
process.exit(0);
