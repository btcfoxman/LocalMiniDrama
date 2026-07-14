const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const desktopPackage = require('../package.json');

test('Windows build embeds the configured custom icon in the executable', () => {
  const winConfig = desktopPackage.build.win;

  assert.notEqual(
    winConfig.signAndEditExecutable,
    false,
    'signAndEditExecutable=false prevents electron-builder from updating the main EXE icon'
  );
  assert.equal(
    fs.existsSync(path.resolve(__dirname, '..', winConfig.icon)),
    true,
    `Windows icon does not exist: ${winConfig.icon}`
  );
});
