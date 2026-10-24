const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');
const config = require('../src/config');
const objectStorage = require('../src/services/objectStorageService');
const uploadService = require('../src/services/uploadService');
const aiConfigService = require('../src/services/aiConfigService');
const taskService = require('../src/services/taskService');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const { recoverImageCaches } = require('../src/services/imageCacheRecovery');

const log = { info() {}, warn() {}, error() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cache-'));
  const databasePath = path.join(root, 'state.db');
  const state = { root, databasePath, db: new Database(databasePath) };
  state.db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  for (const [table, columns] of [['storyboards', ['image_url', 'local_path']], ['characters', ['local_path']]]) {
    const existing = new Set(state.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const column of columns) if (!existing.has(column)) state.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  state.cfg = { storage: { type: 'local', local_path: path.join(root, 'data/storage-cache') }, image_proxy: { enabled: false } };
  fs.mkdirSync(state.cfg.storage.local_path, { recursive: true });
  t.mock.method(config, 'loadConfig', () => state.cfg);
  t.after(() => { if (state.db.open) state.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return state;
}

async function provider(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push([req.method, req.url]); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

test('cached images survive a database reopen and expired provider links without another download', async t => {
  const state = setup(t);
  let expired = false;
  const { base, requests } = await provider(t, (req, res) => {
    res.writeHead(expired ? 403 : 200, { 'Content-Type': 'image/png' }); res.end(png);
  });
  const source = base + '/temporary-image';
  const local = await uploadService.downloadImageToLocal(state.cfg.storage.local_path, source, 'images', log, 'ig', 'library');
  assert.ok(local);
  state.db.prepare("INSERT INTO image_generations (image_url, status) VALUES (?, 'completed')").run(source);
  state.db.close();
  state.db = new Database(state.databasePath);
  expired = true;
  assert.equal(await recoverImageCaches(state.db, state.cfg, log, { cwd: state.root }), 1);
  const row = state.db.prepare('SELECT * FROM image_generations').get();
  assert.equal(row.local_path, local);
  assert.deepEqual(fs.readFileSync(path.join(state.cfg.storage.local_path, local)), png);
  assert.equal(requests.length, 1);
});

test('S3 upload errors retain the readable local file and its returned cache path', async t => {
  const { cfg } = setup(t);
  Object.assign(cfg.storage, { type: 's3', endpoint: 'https://s3.example.test', bucket: 'images' });
  t.mock.method(objectStorage, 'uploadBuffer', async () => { throw new Error('S3 unavailable'); });
  const local = await uploadService.downloadImageToLocal(cfg.storage.local_path, `data:image/png;base64,${png.toString('base64')}`, 'images', log);
  assert.ok(local);
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, local)), png);
});

test('image downloads follow relative redirects and reject HTML success pages', async t => {
  const { cfg } = setup(t);
  const { base, requests } = await provider(t, (req, res) => {
    if (req.url === '/nested/redirect') { res.writeHead(302, { Location: 'frame.png' }); res.end(); }
    else if (req.url === '/nested/frame.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>expired</html>'); }
  });
  assert.ok(await uploadService.downloadImageToLocal(cfg.storage.local_path, base + '/nested/redirect', 'images', log));
  assert.equal(await uploadService.downloadImageToLocal(cfg.storage.local_path, base + '/expired', 'images', log), null);
  assert.ok(requests.some(r => r[1] === '/nested/frame.png'));
});

test('startup restores the old cache directory and repairs storyboard paths overwritten by video generation', async t => {
  const state = setup(t);
  const legacy = path.join(state.root, 'data/storage/images/frame.png');
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, png);
  state.db.prepare("INSERT INTO image_generations (image_url, local_path, status) VALUES ('/static/images/frame.png', 'images/frame.png', 'completed')").run();
  state.db.prepare("INSERT INTO storyboards (episode_id, image_url, local_path) VALUES (1, '/static/images/frame.png', 'videos/result.mp4')").run();
  await recoverImageCaches(state.db, state.cfg, log, { cwd: state.root });
  assert.deepEqual(fs.readFileSync(path.join(state.cfg.storage.local_path, 'images/frame.png')), png);
  assert.equal(state.db.prepare('SELECT local_path FROM storyboards').get().local_path, 'images/frame.png');
});

test('failed local saves are not reported as completed and can recover after restarting without generating again', async t => {
  const state = setup(t);
  const { base, requests } = await provider(t, (req, res) => {
    if (req.method === 'POST') {
      req.resume(); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', url: base + '/result.png' }] }));
    } else { res.setHeader('Content-Type', 'image/png'); res.end(png); }
  });
  t.mock.method(aiConfigService, 'listConfigs', () => [{ provider: 'custom', api_protocol: 'openai', base_url: base, api_key: 'test', model: ['gpt-image-2-2k'], is_active: true }]);
  const download = uploadService.downloadImageToLocal;
  let unavailable = true;
  t.mock.method(uploadService, 'downloadImageToLocal', (...args) => unavailable ? Promise.resolve(null) : download(...args));
  const image = imageClient.createAndGenerateImage(state.db, log, { prompt: 'draw', model: 'gpt-image-2-2k' });
  for (let attempt = 0; attempt < 200 && !['failed', 'completed'].includes(taskService.getTask(state.db, image.task_id).status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  let row = state.db.prepare('SELECT * FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error_msg, /本地缓存失败/);
  assert.equal(row.image_url, base + '/result.png');
  state.db.close(); state.db = new Database(state.databasePath);
  unavailable = false;
  await recoverImageCaches(state.db, state.cfg, log, { cwd: state.root });
  row = state.db.prepare('SELECT * FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(row.status, 'completed');
  assert.ok(fs.existsSync(path.join(state.cfg.storage.local_path, row.local_path)));
  assert.equal(taskService.getTask(state.db, image.task_id).status, 'completed');
  assert.equal(requests.filter(r => r[0] === 'POST').length, 1);
});

test('finishing a video preserves the storyboard image file association', async t => {
  const state = setup(t);
  const sb = state.db.prepare("INSERT INTO storyboards (episode_id, image_url, local_path) VALUES (1, '/static/images/frame.png', 'images/frame.png')").run();
  const video = state.db.prepare("INSERT INTO video_generations (storyboard_id, drama_id, status, model) VALUES (?, 0, 'pending', 'test')").run(sb.lastInsertRowid);
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => ({ model: 'test' }));
  t.mock.method(videoClient, 'callVideoApi', async () => ({ video_url: 'https://video.example.test/result.mp4' }));
  t.mock.method(global, 'fetch', async () => new Response('', { status: 403 }));
  await videoService.processVideoGeneration(state.db, log, video.lastInsertRowid);
  const row = state.db.prepare('SELECT * FROM storyboards WHERE id = ?').get(sb.lastInsertRowid);
  assert.equal(row.local_path, 'images/frame.png');
  assert.equal(row.image_url, '/static/images/frame.png');
  assert.equal(row.video_url, 'https://video.example.test/result.mp4');
});

test('startup completes an image saved before interruption without reviving user cancellation', async t => {
  const state = setup(t);
  const source = `data:image/png;base64,${png.toString('base64')}`;
  const local = await uploadService.downloadImageToLocal(state.cfg.storage.local_path, source, 'images', log, 'ig', 'library');
  const interrupted = taskService.createTask(state.db, log, 'image_generation', '1');
  const cancelled = taskService.createTask(state.db, log, 'image_generation', '2');
  for (const task of [interrupted, cancelled]) {
    state.db.prepare("INSERT INTO image_generations (image_url, status, task_id) VALUES (?, 'processing', ?)").run(source, task.id);
  }
  taskService.updateTaskError(state.db, interrupted.id, taskService.ORPHAN_ASYNC_TASK_MSG);
  taskService.cancelTask(state.db, log, cancelled.id);
  state.db.close(); state.db = new Database(state.databasePath);
  await recoverImageCaches(state.db, state.cfg, log, { cwd: state.root });
  assert.equal(taskService.getTask(state.db, interrupted.id).status, 'completed');
  assert.equal(state.db.prepare('SELECT local_path FROM image_generations WHERE task_id = ?').get(interrupted.id).local_path, local);
  assert.equal(taskService.getTask(state.db, cancelled.id).status, 'failed');
  assert.equal(state.db.prepare('SELECT status FROM image_generations WHERE task_id = ?').get(cancelled.id).status, 'processing');
});
