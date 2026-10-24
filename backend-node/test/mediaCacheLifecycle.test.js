const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const config = require('../src/config');
const upload = require('../src/services/uploadService');
const transport = require('../src/services/mediaDownloadService');
const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const tasks = require('../src/services/taskService');
const { retryImageCache } = require('../src/services/imageCacheRetryService');
const { recoverMediaCaches } = require('../src/services/mediaCacheRecovery');
const { createReferenceResolver } = require('../src/services/mediaReferenceService');
const { withReferenceUploads } = require('../src/services/referenceUploadService');
const tts = require('../src/services/ttsService');
const propImages = require('../src/services/propImageGenerationService');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const audio = Buffer.from('ID3-test-audio-content');
const video = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom-test-video-content')]);
const log = { info() {}, warn() {}, error() {} };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-lifecycle-'));
  const db = new Database(path.join(root, 'state.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  const cfg = { storage: { type: 'local', local_path: path.join(root, 'data/storage-cache') }, image_proxy: { enabled: false } };
  t.mock.method(config, 'loadConfig', () => cfg);
  t.after(() => { transport.setMediaDownloadFetch(null); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, cfg };
}

async function server(t, handler) {
  const requests = [];
  const service = http.createServer((req, res) => { requests.push([req.method, req.url]); handler(req, res); });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { service.close(resolve); service.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${service.address().port}`, requests };
}

async function finished(db, taskId) {
  for (let i = 0; i < 1000; i++) {
    const task = tasks.getTask(db, taskId);
    if (['completed', 'failed'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not finish');
}

test('ECONNRESET during result download retries the GET and does not generate another image', async t => {
  const { db, cfg } = setup(t);
  let resets = 0;
  const { base, requests } = await server(t, (req, res) => {
    if (req.method === 'POST') {
      req.resume();
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', url: base + '/image' }] }));
    } else if (resets++ === 0) req.socket.destroy();
    else { res.setHeader('Content-Type', 'image/png'); res.end(png); }
  });
  t.mock.method(aiConfig, 'listConfigs', () => [{ provider: 'custom', api_protocol: 'openai', base_url: base, api_key: 'test', model: ['gpt-image-2'], is_active: true }]);
  const image = imageClient.createAndGenerateImage(db, log, { prompt: 'draw', model: 'gpt-image-2' });
  assert.equal((await finished(db, image.task_id)).status, 'completed');
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(image.id);
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, row.local_path)), png);
  assert.equal(requests.filter(r => r[0] === 'POST').length, 1);
  assert.equal(requests.filter(r => r[0] === 'GET').length, 2);
});

test('retrying a saved image result reports the actual download error and never calls generation', async t => {
  const { db, cfg } = setup(t);
  let expired = true;
  const { base, requests } = await server(t, (req, res) => { res.writeHead(expired ? 403 : 200, { 'Content-Type': 'image/png' }); res.end(png); });
  const task = tasks.createTask(db, log, 'image_generation', '1');
  const error = '图片已生成，但本地缓存失败，请重试保存';
  tasks.updateTaskError(db, task.id, error);
  const row = db.prepare("INSERT INTO image_generations (image_url, status, error_msg, task_id) VALUES (?, 'failed', ?, ?)").run(base + '/image', error, task.id);
  await assert.rejects(retryImageCache(db, log, row.lastInsertRowid), /下载图片失败.*HTTP 403/);
  expired = false;
  const saved = await retryImageCache(db, log, row.lastInsertRowid);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, saved.local_path)), png);
  assert.equal(tasks.getTask(db, task.id).error, null);
  assert.ok(requests.every(r => r[0] === 'GET'));
  expired = true;
  const count = requests.length;
  assert.equal((await retryImageCache(db, log, saved.id)).local_path, saved.local_path);
  assert.equal(requests.length, count);
});

test('TTS returns a persistent local audio copy even if optional remote storage fails', async t => {
  const { db, cfg } = setup(t);
  const { base } = await server(t, (req, res) => { req.resume(); res.end(audio); });
  const save = upload.saveBufferToStorage;
  t.mock.method(upload, 'saveBufferToStorage', async (...args) => { await save(...args); throw new Error('S3 unavailable'); });
  const result = await tts.synthesize(db, log, { text: 'test', storage_base: cfg.storage.local_path, config: { provider: 'openai', base_url: base, model: 'tts-1' } });
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, result.local_path)), audio);
  assert.match(result.audio_url, /^\/static\/audio\//);
  assert.equal(fs.readdirSync(path.join(cfg.storage.local_path, 'audio')).length, 1);
});

test('prop image download failure retains the generated result and cache retry never regenerates', async t => {
  const { db, cfg } = setup(t);
  let expired = true, generations = 0;
  const { base } = await server(t, (req, res) => { res.writeHead(expired ? 403 : 200, { 'Content-Type': 'image/png' }); res.end(png); });
  const prop = db.prepare("INSERT INTO props (drama_id, name, prompt) VALUES (1, 'test', 'draw')").run().lastInsertRowid;
  const task = tasks.createTask(db, log, 'prop_image_generation', String(prop));
  t.mock.method(imageClient, 'callImageApi', async () => { generations++; return { image_url: base + '/prop' }; });
  await propImages.processPropImageGeneration(db, log, task.id, prop, {});
  const row = db.prepare('SELECT * FROM image_generations WHERE task_id = ?').get(task.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.image_url, base + '/prop');
  expired = false;
  const result = await retryImageCache(db, log, row.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, result.local_path)), png);
  assert.equal(generations, 1);
});

test('disk write failures name the storage cause and never masquerade as network failures', async t => {
  const { root } = setup(t);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'occupied');
  await assert.rejects(upload.downloadImageToLocal(blocker, 'data:image/png;base64,' + png.toString('base64'), 'images', log, 'ig', null, { throwOnError: true }), error => {
    assert.equal(error.cachePhase, 'write');
    assert.match(upload.imageCacheFailureMessage(error), /保存图片失败/);
    return true;
  });
});

test('cache retry does not revive a task cancelled during download', async t => {
  const { db } = setup(t);
  const task = tasks.createTask(db, log, 'image_generation', '1');
  const error = '图片已生成，但本地缓存失败，请重试保存';
  tasks.updateTaskError(db, task.id, error);
  const row = db.prepare("INSERT INTO image_generations (image_url, status, error_msg, task_id) VALUES (?, 'failed', ?, ?)").run('https://provider.example.test/image', error, task.id);
  t.mock.method(upload, 'downloadImageToLocal', async () => { tasks.updateTaskError(db, task.id, '用户取消'); return 'images/cached.png'; });
  await assert.rejects(retryImageCache(db, log, row.lastInsertRowid), /状态已变化/);
  assert.equal(tasks.getTask(db, task.id).error, '用户取消');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = ?').get(row.lastInsertRowid).status, 'failed');
});

test('desktop downloads use the configured browser transport and Node fallback decodes compressed images', async t => {
  setup(t);
  let desktopCalls = 0;
  transport.setMediaDownloadFetch(async () => { desktopCalls++; return new Response(png, { headers: { 'Content-Type': 'image/png' } }); });
  assert.deepEqual((await transport.downloadImageBuffer('https://unreachable.invalid/image')).buffer, png);
  assert.equal(desktopCalls, 1);
  transport.setMediaDownloadFetch(async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); });
  const { base } = await server(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(png)); });
  assert.deepEqual((await transport.downloadImageBuffer(base + '/image')).buffer, png);
});

test('all media retain a local copy after source expiry and obtain a new relay URL for every submission', async t => {
  const { db, cfg } = setup(t);
  let expired = false;
  let uploads = 0;
  const { base, requests } = await server(t, (req, res) => {
    const [bytes, mime] = req.url === '/image' ? [png, 'image/png'] : req.url === '/audio' ? [audio, 'audio/mpeg'] : [video, 'video/mp4'];
    res.writeHead(expired ? 403 : 200, { 'Content-Type': mime }); res.end(bytes);
  });
  cfg.image_proxy = { enabled: true, upload_url: 'https://relay.example.test/upload', token: 'test', upload_max_attempts: 1 };
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url === cfg.image_proxy.upload_url) {
      bodies.push(options.body.toString());
      return new Response(JSON.stringify({ url: `https://files.example.test/fresh/${++uploads}` }));
    }
    throw new Error('Unexpected request: ' + url);
  });
  transport.setMediaDownloadFetch(async url => {
    const response = await new Promise((resolve, reject) => http.get(base + new URL(url).pathname, res => { const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { 'Content-Type': res.headers['content-type'] } }))); }).on('error', reject));
    return response;
  });
  for (const [kind, bytes] of [['image', png], ['audio', audio], ['video', video]]) {
    expired = false;
    const first = await withReferenceUploads(async () => {
      const resolve = createReferenceResolver(db, log);
      const values = await Promise.all([resolve('https://provider.example.test/' + kind, { kind }), resolve('https://provider.example.test/' + kind, { kind })]);
      assert.equal(values[0], values[1]);
      return values[0];
    });
    expired = true;
    const second = await withReferenceUploads(() => createReferenceResolver(db, log)('https://provider.example.test/' + kind, { kind }));
    assert.notEqual(second, first);
    assert.ok(bodies.at(-1).includes(bytes.toString()));
  }
  assert.equal(uploads, 6);
  assert.equal(requests.length, 3);
});

test('video cache failure retains the provider result and cache retry performs only downloads', async t => {
  const { db, cfg } = setup(t);
  let expired = true;
  const { base, requests } = await server(t, (req, res) => { res.writeHead(expired ? 403 : 200, { 'Content-Type': 'video/mp4' }); res.end(video); });
  const task = tasks.createTask(db, log, 'video_generation', '1');
  const row = db.prepare("INSERT INTO video_generations (status, task_id, model, drama_id) VALUES ('processing', ?, 'test', 0)").run(task.id);
  let generations = 0;
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => ({ model: 'test' }));
  t.mock.method(videoClient, 'callVideoApi', async () => { generations++; return { video_url: base + '/video' }; });
  await videoService.processVideoGeneration(db, log, row.lastInsertRowid);
  let saved = videoService.getById(db, row.lastInsertRowid);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error_msg, /视频已生成，但本地缓存失败/);
  assert.equal(saved.video_url, base + '/video');
  expired = false;
  saved = await videoService.retryVideoCache(db, log, saved.id);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, saved.local_path)), video);
  assert.equal(generations, 1);
  assert.ok(requests.every(r => r[0] === 'GET'));
});

test('startup recovers audio and video asset paths from legacy cache directories', async t => {
  const { db, cfg, root } = setup(t);
  for (const [kind, filename, bytes] of [['audio', 'audio/voice.mp3', audio], ['video', 'videos/result.mp4', video]]) {
    const absolute = path.join(root, 'data/storage', filename);
    fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, bytes);
    db.prepare('INSERT INTO assets (type, url, local_path) VALUES (?, ?, ?)').run(kind, 'https://expired.invalid/' + kind, absolute);
  }
  assert.equal(await recoverMediaCaches(db, cfg, log, { cwd: root }), 2);
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, 'audio/voice.mp3')), audio);
  assert.deepEqual(fs.readFileSync(path.join(cfg.storage.local_path, 'videos/result.mp4')), video);
});
