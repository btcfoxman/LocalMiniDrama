const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

it('ships a valid config.yaml without duplicate mapping keys', () => {
  const configPath = path.join(__dirname, '..', 'configs', 'config.yaml');
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));

  assert.equal(parsed.image_proxy.enabled, true);
  assert.equal(parsed.image_proxy.expire_hours, 2);
  assert.equal(parsed.image_proxy.use_for_gemini, true);
  assert.equal(parsed.image_proxy.use_for_video, true);
});
