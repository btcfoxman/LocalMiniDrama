const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { repairDuplicateTopLevelMappings } = require('../configRecovery');

describe('repairDuplicateTopLevelMappings', () => {
  it('merges duplicated mapping sections while preserving earlier values', () => {
    const raw = [
      'app:',
      '  name: LocalMiniDrama',
      'image_proxy:',
      '  enabled: true',
      '  upload_url: https://example.com/upload',
      '  expire_hours: 23',
      'vendor_lock:',
      '  enabled: false',
      'image_proxy:',
      '  expire_hours: 2',
      '  use_for_video: true',
      '',
    ].join('\n');

    const repaired = repairDuplicateTopLevelMappings(raw);
    const parsed = yaml.load(repaired.text);

    assert.deepEqual(repaired.repairedKeys, ['image_proxy']);
    assert.deepEqual(parsed.image_proxy, {
      enabled: true,
      upload_url: 'https://example.com/upload',
      expire_hours: 2,
      use_for_video: true,
    });
    assert.equal((repaired.text.match(/^image_proxy:/gm) || []).length, 1);
    assert.equal(parsed.vendor_lock.enabled, false);
  });

  it('returns valid YAML unchanged', () => {
    const raw = 'app:\n  name: LocalMiniDrama\nimage_proxy:\n  enabled: true\n';
    assert.deepEqual(repairDuplicateTopLevelMappings(raw), {
      text: raw,
      repairedKeys: [],
    });
  });
});
