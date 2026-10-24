const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const config = require('../src/config');
const { routes } = require('../src/routes/upload');
const { prepareVideoReferences } = require('../src/services/mediaReferenceService');
const { recoverImageCaches } = require('../src/services/imageCacheRecovery');
const { createStaticMediaMiddleware } = require('../src/services/staticMediaService');

const log = { info() {}, warn() {}, error() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-upload-'));
  const cfg = { storage: { type: 'local', local_path: path.join(root, 'current') }, image_proxy: { enabled: false } };
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  t.mock.method(config, 'loadConfig', () => cfg);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { cfg, db, root };
}

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('uploaded images with percent sequences in project names remain readable in previews and video references', async t => {
  const { cfg, db } = setup(t);
  db.prepare("INSERT INTO dramas (title) VALUES ('100%20complete')").run();
  let uploaded;
  await routes(cfg, log, db).uploadImage({ body: { drama_id: 1 }, file: { buffer: png, originalname: 'frame.png', mimetype: 'image/png', size: png.length } }, {
    status() { return this; }, json(body) { uploaded = body.data; },
  });
  assert.ok(uploaded.local_path.includes('100%20complete'));
  const app = express();
  app.use('/static', express.static(cfg.storage.local_path));
  const base = await serve(t, app);
  const preview = await fetch(base + uploaded.url);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const { assetImageUrl } = await import('../../frontweb/src/utils/mediaUrl.js');
  const { prepareVideoGenerationRequest } = await import('../../frontweb/src/utils/videoReferences.js');
  const image = assetImageUrl(uploaded);
  assert.equal((await fetch(base + image)).status, 200);
  const request = prepareVideoGenerationRequest({ image_url: base + image, first_frame_url: base + image, reference_image_urls: [base + image] }, base);
  const prepared = await prepareVideoReferences(db, log, { ...request, reference_urls: request.reference_image_urls });
  assert.equal(prepared.first_frame_url, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(prepared.reference_urls, [prepared.first_frame_url]);
});

test('startup recovers uploaded assets and image records that have only an absolute legacy local path', async t => {
  const { root, cfg, db } = setup(t);
  const relative = 'uploads/frame.png';
  const legacy = path.join(root, 'data/storage', relative);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, png);
  db.prepare("INSERT INTO image_generations (image_url, local_path, status, provider) VALUES ('', ?, 'completed', 'upload')").run(legacy);
  db.prepare("INSERT INTO assets (type, url, local_path) VALUES ('image', '', ?)").run(legacy);
  db.prepare("INSERT INTO assets (type, url, local_path) VALUES ('image', '', 'uploads/another-missing.png')").run();
  db.prepare("INSERT INTO assets (type, url, local_path) VALUES ('image', NULL, ?)").run(legacy);
  await recoverImageCaches(db, cfg, log, { cwd: root });
  assert.equal(db.prepare('SELECT local_path FROM image_generations').get().local_path, relative);
  assert.equal(db.prepare('SELECT local_path FROM assets').get().local_path, relative);
  assert.equal(db.prepare('SELECT local_path FROM assets WHERE id = 2').get().local_path, 'uploads/another-missing.png');
  assert.equal(db.prepare('SELECT local_path FROM assets WHERE id = 3').get().local_path, relative);
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, relative)), png);
});

test('changing the local storage directory keeps newly uploaded thumbnails and references readable without restarting', async t => {
  const { cfg, db, root } = setup(t);
  const app = express();
  app.use('/static', createStaticMediaMiddleware(cfg));
  const base = await serve(t, app);
  assert.equal((await fetch(base + '/static/not-present.png')).status, 404);
  cfg.storage = { ...cfg.storage, local_path: path.join(root, 'new-cache') };
  let uploaded;
  await routes(cfg, log, db).uploadImage({ body: {}, file: { buffer: png, originalname: 'frame.png', mimetype: 'image/png', size: png.length } }, {
    status() { return this; }, json(body) { uploaded = body.data; },
  });
  const preview = await fetch(base + uploaded.url);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  assert.equal((await prepareVideoReferences(db, log, { image_url: uploaded.url })).image_url, `data:image/png;base64,${png.toString('base64')}`);
});
