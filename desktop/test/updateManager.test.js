const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateManager, compareVersions, resolveUpdatePolicy } = require('../updateManager');

function fixture({ version = '1.2.33', policy = {}, answers = [], download } = {}) {
  const updater = new EventEmitter();
  const calls = { checks: 0, policies: 0, downloads: 0, installs: 0, quits: 0, dialogs: [] };
  updater.checkForUpdates = async () => { calls.checks++; return { updateInfo: { version, releaseNotes: '<p>修复素材缓存</p>' } }; };
  updater.downloadUpdate = async () => { calls.downloads++; if (download) await download(calls.downloads); updater.emit('update-downloaded', { version }); };
  updater.quitAndInstall = (...args) => { assert.deepEqual(args, [false, true]); calls.installs++; };
  const manager = createUpdateManager({ updater, currentVersion: '1.2.32',
    loadPolicy: async () => { calls.policies++; return { version, ...policy }; },
    dialog: { showMessageBox: async opts => { calls.dialogs.push(opts); return { response: answers.shift() ?? 0 }; } },
    onQuit: () => calls.quits++,
  });
  return { manager, updater, calls };
}

test('manual check actively checks again and explains when current; background check stays quiet', async () => {
  const { manager, calls } = fixture({ version: '1.2.32' });
  assert.equal((await manager.check()).status, 'current');
  assert.equal(calls.dialogs.length, 0);
  await manager.check(true);
  await manager.check(true);
  assert.equal(calls.checks, 3);
  assert.equal(calls.dialogs[0].message, '当前已是最新版本');
});

test('optional update displays versions and notes before download and can be deferred', async () => {
  const { manager, updater, calls } = fixture({ answers: [1] });
  assert.equal((await manager.check(true)).status, 'deferred');
  assert.equal(calls.downloads, 0);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.match(calls.dialogs[0].detail, /1\.2\.32[\s\S]*1\.2\.33[\s\S]*修复素材缓存/);
  assert.doesNotMatch(calls.dialogs[0].detail, /<p>/);
});

test('downloaded optional update can install on a later manual check without downloading twice', async () => {
  const { manager, calls } = fixture({ answers: [0, 1, 0] });
  assert.equal((await manager.check(true)).status, 'downloaded');
  assert.equal(calls.installs, 0);
  assert.equal((await manager.check(true)).status, 'installing');
  assert.equal(calls.downloads, 1);
  assert.equal(calls.policies, 2);
  assert.equal(calls.installs, 1);
});

test('required update exits when declined and cannot offer Later', async () => {
  const { manager, calls } = fixture({ policy: { forceUpdate: true }, answers: [1] });
  assert.equal((await manager.check(true)).status, 'quitting');
  assert.equal(calls.quits, 1);
  assert.equal(calls.downloads, 0);
  assert.deepEqual(calls.dialogs[0].buttons, ['立即更新', '退出软件']);
});

test('minimum supported version enforces update even without force flag', async () => {
  const { manager, calls } = fixture({ policy: { minSupportedVersion: '1.2.33' } });
  const result = await manager.check(true);
  assert.equal(result.force, true);
  assert.equal(result.status, 'installing');
  assert.deepEqual(calls.dialogs[1].buttons, ['重启并安装']);
});

test('mandatory download failure offers explicit retry or exit and never returns to unsupported client', async () => {
  const { manager, calls } = fixture({ policy: { forceUpdate: true }, answers: [0, 0, 1], download: async () => { throw new Error('ECONNRESET'); } });
  assert.equal((await manager.check(true)).status, 'quitting');
  assert.equal(calls.downloads, 2);
  assert.equal(calls.quits, 1);
  assert.equal(calls.installs, 0);
  assert.deepEqual(calls.dialogs[1].buttons, ['重试', '退出软件']);
});

test('concurrent checks share one request and later requests fetch fresh policy', async () => {
  const { manager, calls } = fixture({ answers: [1, 1] });
  const first = manager.check();
  const second = manager.check(true);
  assert.equal(first, second);
  await first;
  await manager.check(true);
  assert.equal(calls.checks, 2);
  assert.equal(calls.policies, 2);
});

test('policy mismatch and network errors explain failure without downloading an unsafe release', async () => {
  const { manager, updater, calls } = fixture({ policy: { version: '9.0.0' } });
  assert.equal((await manager.check(true)).status, 'error');
  assert.match(calls.dialogs[0].detail, /不一致/);
  updater.checkForUpdates = async () => { throw new Error('网络断开'); };
  assert.equal((await manager.check(true)).status, 'error');
  assert.match(calls.dialogs[1].detail, /网络断开/);
  assert.equal(calls.downloads, 0);
});

test('version order respects prerelease numbers and stable versions', () => {
  assert.equal(compareVersions('1.2.33-beta.10', '1.2.33-beta.2'), 1);
  assert.equal(compareVersions('v1.2.33', '1.2.33-beta.10'), 1);
  assert.equal(compareVersions('1.2.33+build.1', '1.2.33+build.2'), 0);
});

test('public Electron manifest supplies mandatory policy without the restricted JSON endpoint', async () => {
  const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
  const info = parseUpdateInfo('version: 1.2.33\nforceUpdate: true\nminSupportedVersion: 1.2.33\nreleaseNotes: cache fixes\nfiles: []\n', 'latest.yml', new URL('https://example.test/latest.yml'));
  const policy = await resolveUpdatePolicy(info, () => { throw Error('JSON route is not exposed'); });
  assert.deepEqual(policy, { version: '1.2.33', forceUpdate: true, minSupportedVersion: '1.2.33', releaseNotes: 'cache fixes' });
  info.forceUpdate = false;
  assert.equal((await resolveUpdatePolicy(info, () => { throw Error('must use fresh manifest'); })).forceUpdate, false);
});
