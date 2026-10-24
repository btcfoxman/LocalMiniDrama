const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareSemver,
  planReleaseRetention,
  releaseNotesFromChangelog,
} = require('../scripts/publish-app-market-release');

it('publishes only this release notes and excludes older versions', () => {
  assert.equal(releaseNotesFromChangelog('1.2.32', '## [1.2.32] - date\n\n### 新增\n\n- 检查更新\n\n---\n\n## [1.2.31]\nold'), '### 新增\n\n- 检查更新');
  assert.equal(releaseNotesFromChangelog('9.0.0', '## [1.2.32]\nnotes'), '');
});

describe('app market S3 release retention', () => {
  it('keeps the current release and only the newest historical version', () => {
    const prefix = 'ai-drama/overseas-drama-desktop/stable';
    const keys = [
      `${prefix}/1.2.20/win32/x64/app.exe`,
      `${prefix}/1.2.20/darwin/arm64/app.dmg`,
      `${prefix}/1.2.19/win32/x64/app.exe`,
      `${prefix}/1.2.19/darwin/x64/app.dmg`,
      `${prefix}/1.2.18/win32/x64/app.exe`,
      `${prefix}/1.1.9/win32/x64/app.exe`,
      'ai-drama/overseas-drama-desktop/icons/favicon.png',
      'ai-drama/overseas-drama-desktop/beta/9.9.9/win32/x64/app.exe',
    ];

    const plan = planReleaseRetention(keys, prefix, '1.2.20', 1);

    assert.deepEqual(new Set(plan.keepVersions), new Set(['1.2.20', '1.2.19']));
    assert.deepEqual(plan.deleteVersions, ['1.2.18', '1.1.9']);
    assert.deepEqual(plan.deleteKeys, [
      `${prefix}/1.2.18/win32/x64/app.exe`,
      `${prefix}/1.1.9/win32/x64/app.exe`,
    ]);
  });

  it('sorts stable releases after prereleases and ignores non-version folders', () => {
    const prefix = 'releases/app/stable';
    const keys = [
      `${prefix}/1.3.0/app.exe`,
      `${prefix}/1.2.1-beta.2/app.exe`,
      `${prefix}/1.2.1/app.exe`,
      `${prefix}/latest/manifest.json`,
    ];

    assert.ok(compareSemver('1.2.1', '1.2.1-beta.2') > 0);
    const plan = planReleaseRetention(keys, prefix, '1.3.0', 1);
    assert.deepEqual(new Set(plan.keepVersions), new Set(['1.3.0', '1.2.1']));
    assert.deepEqual(plan.deleteVersions, ['1.2.1-beta.2']);
  });
});
