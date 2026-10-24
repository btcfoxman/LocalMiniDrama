const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');
const config = require('../src/config');
const objectStorage = require('../src/services/objectStorageService');
const cache = require('../src/services/mediaProxyCache');
const { createReferenceResolver, prepareImageReferences, prepareVideoReferences } = require('../src/services/mediaReferenceService');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };
const expiredUrl = 'https://provider.example.test/download/result?signature=expired';
const newUrl = 'https://files.example.test/fresh';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-references-'));
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  db.exec(`CREATE TABLE image_proxy_cache (cache_key TEXT PRIMARY KEY, proxy_url TEXT, created_at TEXT);
    ALTER TABLE ai_service_configs ADD COLUMN api_protocol TEXT;
    ALTER TABLE characters ADD COLUMN seedance2_voice_asset TEXT;`);
  const cfg = {
    storage: { type: 'local', local_path: root },
    image_proxy: { enabled: true, upload_url: 'https://relay.example.test/upload', token: 'test-token', expire_hours: 2, upload_max_attempts: 1 },
  };
  t.mock.method(config, 'loadConfig', () => cfg);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (relative, bytes = Buffer.from('saved-media')) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
    return bytes;
  };
  return { root, db, cfg, write };
}

function addModel(db, type, protocol, baseUrl) {
  // 此处的 OpenAI 图片用例验证原有同步接口；Responses 异步流程有独立回归测试。
  db.prepare(`INSERT INTO ai_service_configs (service_type, provider, base_url, api_key, model, is_default, is_active, api_protocol, settings)
    VALUES (?, 'custom', ?, 'test-key', '["test-model"]', 1, 1, ?, ?)`).run(type, baseUrl, protocol,
      type === 'image' && protocol === 'openai' ? JSON.stringify({ image_async: false }) : null);
}

async function modelServer(t, onRequest, responseBody) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    onRequest(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(responseBody));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('expired generated image URLs resolve to their exact local copy before image generation', async t => {
  const { root, db, write } = setup(t);
  write('projects/剧集/images/saved.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)')
    .run(expiredUrl, 'projects/剧集/images/saved.png');
  t.mock.method(global, 'fetch', () => { throw new Error('the expired download must not be requested'); });
  const opts = { storage_local_path: root, reference_image_urls: [expiredUrl] };
  const prepared = await prepareImageReferences(db, log, opts);
  assert.deepEqual(prepared.reference_image_urls, ['projects/剧集/images/saved.png']);
  assert.deepEqual(opts.reference_image_urls, [expiredUrl]);
});

test('project names containing a literal percent retain their local media', async t => {
  const { db, write } = setup(t);
  const relative = 'projects/100%完成/images/frame.png';
  write(relative);
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, relative);
  t.mock.method(global, 'fetch', () => { throw new Error('no network lookup expected'); });
  assert.equal(await createReferenceResolver(db, log)(expiredUrl, { preferLocal: true }), relative);
});

test('foreign static URLs do not accidentally match a different local file', async t => {
  const { db, write } = setup(t);
  write('images/frame.png');
  const foreign = 'https://foreign.example.test/static/images/frame.png';
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, foreign);
    assert.equal(opts.method, 'HEAD');
    return new Response('');
  });
  assert.equal(await createReferenceResolver(db, log)(foreign), foreign);
});

test('all existing local copies are checked before a missing S3 object is downloaded', async t => {
  const { db, cfg, write } = setup(t);
  Object.assign(cfg.storage, { type: 's3', endpoint: 'https://s3.example.test', bucket: 'media' });
  write('images/existing.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/existing.png');
  db.prepare('INSERT INTO assets (url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/missing.png');
  t.mock.method(objectStorage, 'downloadToFile', () => { throw new Error('existing local copy must be preferred'); });
  assert.equal(await createReferenceResolver(db, log)(expiredUrl, { preferLocal: true }), 'images/existing.png');
});

test('single image, first/last frames and repeated references use fresh relay URLs', async t => {
  const { root, db, write } = setup(t);
  write('images/reference.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/reference.png');
  let uploads = 0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://relay.example.test/upload');
    assert.equal(opts.method, 'POST');
    uploads += 1;
    return new Response(JSON.stringify({ url: newUrl }));
  });
  const prepared = await prepareVideoReferences(db, log, {
    storage_local_path: root, image_url: expiredUrl, first_frame_url: expiredUrl,
    last_frame_url: expiredUrl, reference_urls: [expiredUrl, 'asset://certified'],
  });
  assert.equal(prepared.image_url, newUrl);
  assert.equal(prepared.first_frame_url, newUrl);
  assert.equal(prepared.last_frame_url, newUrl);
  assert.deepEqual(prepared.reference_urls, [newUrl, 'asset://certified']);
  assert.equal(uploads, 1);
});

test('repeat video submissions from a public app origin renew the saved local reference', async t => {
  const { prepareVideoGenerationRequest } = await import('../../frontweb/src/utils/videoReferences.js');
  const { assetImageUrl } = await import('../../frontweb/src/utils/mediaUrl.js');
  const { root, db, write } = setup(t);
  const relative = 'projects/剧集/images/frame.png';
  write(relative);
  addModel(db, 'video', 'openai', 'https://api.example.test');
  const origin = 'https://drama.example.test';
  const frame = origin + assetImageUrl({ local_path: '/static/' + relative });
  const request = { image_url: frame, first_frame_url: frame, last_frame_url: frame, reference_image_urls: [frame] };
  const uploads = [];
  const submissions = [];
  const probes = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url === 'https://relay.example.test/upload') {
      const renewed = `${newUrl}/${uploads.length + 1}`;
      uploads.push(renewed);
      return new Response(JSON.stringify({ url: renewed }));
    }
    if (opts.method === 'HEAD') {
      probes.push(url);
      assert.equal(url, uploads[0]);
      return new Response('', { status: 404 });
    }
    assert.ok(url.startsWith('https://api.example.test/'));
    submissions.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: `task-${submissions.length}` }));
  });
  for (let i = 0; i < 2; i += 1) {
    const prepared = prepareVideoGenerationRequest(request, origin);
    const result = await videoClient.callVideoApi(db, log, {
      ...prepared, reference_urls: prepared.reference_image_urls,
      model: 'test-model', prompt: 'animate', storage_local_path: root,
    });
    assert.equal(result.task_id, `task-${i + 1}`);
    assert.ok(JSON.stringify(submissions[i]).includes(uploads[i]));
    assert.ok(!JSON.stringify(submissions[i]).includes(origin));
  }
  assert.deepEqual(uploads, [`${newUrl}/1`, `${newUrl}/2`]);
  assert.deepEqual(probes, [uploads[0]]);
  assert.equal(request.image_url, frame);
});

test('dead relay cache is refreshed even before its configured expiry', async t => {
  const { db, cfg, write } = setup(t);
  const bytes = write('images/reference.png');
  const key = cache.buildProxyCacheKey(bytes, 'image/png', cfg.image_proxy);
  cache.setProxyCache(db, key, 'https://files.example.test/deleted');
  const calls = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    calls.push(opts.method);
    return opts.method === 'HEAD' ? new Response('', { status: 404 }) : new Response(JSON.stringify({ url: newUrl }));
  });
  assert.equal(await createReferenceResolver(db, log)('images/reference.png'), newUrl);
  assert.deepEqual(calls, ['HEAD', 'POST']);
  assert.equal(cache.getProxyCache(db, key), newUrl);
});

test('readable relay cache avoids reupload; changed bytes or relay config invalidate it', async t => {
  const { db, cfg, write } = setup(t);
  const bytes = write('images/reference.png');
  cache.setProxyCache(db, cache.buildProxyCacheKey(bytes, 'image/png', cfg.image_proxy), newUrl);
  let uploads = 0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (opts.method === 'HEAD') return new Response('');
    uploads += 1;
    return new Response(JSON.stringify({ url: newUrl }));
  });
  assert.equal(await createReferenceResolver(db, log)('images/reference.png'), newUrl);
  assert.equal(uploads, 0);
  write('images/reference.png', Buffer.from('edited-media'));
  await createReferenceResolver(db, log)('images/reference.png');
  cfg.image_proxy.token = 'different-token';
  await createReferenceResolver(db, log)('images/reference.png');
  assert.equal(uploads, 2);
});

test('video and audio files retain their extension, MIME type and bytes when relayed', async t => {
  const { db, write } = setup(t);
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://relay.example.test/upload');
    bodies.push(opts.body.toString());
    return new Response(JSON.stringify({ url: newUrl }));
  });
  for (const [kind, relative, mime] of [['video', 'videos/result.mp4', 'video/mp4'], ['audio', 'audio/voice.wav', 'audio/wav']]) {
    const bytes = write(relative);
    db.prepare('INSERT INTO assets (type, url, local_path) VALUES (?, ?, ?)').run(kind, expiredUrl + kind, relative);
    assert.equal(await createReferenceResolver(db, log)(expiredUrl + kind, { kind }), newUrl);
    const body = bodies.at(-1);
    assert.ok(body.includes(`.${path.extname(relative).slice(1)}"`));
    assert.ok(body.includes(`Content-Type: ${mime}`));
    assert.ok(body.includes(bytes.toString()));
  }
});

test('Seedance voice references recover the saved audio rather than submitting a relative URL', async t => {
  const { db, write } = setup(t);
  write('audio/voice.mp3');
  db.prepare('INSERT INTO characters (drama_id, seedance2_voice_asset) VALUES (1, ?)')
    .run(JSON.stringify({ status: 'active', url: expiredUrl, local_path: 'audio/voice.mp3' }));
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.ok(opts.body.toString().includes('audio/mpeg'));
    return new Response(JSON.stringify({ url: newUrl }));
  });
  const prepared = await prepareVideoReferences(db, log, { voice_reference_url: expiredUrl });
  assert.equal(prepared.voice_reference_url, newUrl);
});

test('S3 receives the local media even when the original provider URL is expired', async t => {
  const { db, cfg, write } = setup(t);
  Object.assign(cfg.storage, { type: 's3', endpoint: 'https://s3.example.test', bucket: 'media', public_base_url: 'https://cdn.example.test/media' });
  write('videos/result.mp4');
  db.prepare('INSERT INTO video_generations (video_url, local_path) VALUES (?, ?)').run(expiredUrl, 'videos/result.mp4');
  t.mock.method(global, 'fetch', () => { throw new Error('neither expired source nor relay should be requested'); });
  const uploaded = t.mock.method(objectStorage, 'uploadFile', async (storage, key, absolute, mime) => {
    assert.equal(key, 'videos/result.mp4');
    assert.equal(mime, 'video/mp4');
    assert.equal(fs.readFileSync(absolute, 'utf8'), 'saved-media');
    return objectStorage.publicUrlForKey(storage, key);
  });
  assert.equal(await createReferenceResolver(db, log)(expiredUrl, { kind: 'video' }), 'https://cdn.example.test/media/videos/result.mp4');
  assert.equal(uploaded.mock.callCount(), 1);
});

test('a missing local S3 cache is downloaded before reuse', async t => {
  const { cfg, db, write } = setup(t);
  Object.assign(cfg.storage, { type: 's3', endpoint: 'https://s3.example.test', bucket: 'media', public_base_url: 'https://cdn.example.test/media' });
  t.mock.method(objectStorage, 'downloadToFile', async (storage, key) => { write(key); return true; });
  t.mock.method(objectStorage, 'uploadFile', async (storage, key) => objectStorage.publicUrlForKey(storage, key));
  assert.equal(await createReferenceResolver(db, log)('https://cdn.example.test/media/images/%E5%9B%BE.png?old=signature'),
    'https://cdn.example.test/media/images/图.png');
});

test('unsupported relay files and missing expired media fail clearly before submission', async t => {
  const { db, cfg, write } = setup(t);
  write('audio/voice.mp3');
  t.mock.method(global, 'fetch', async (url, opts) => new Response('', { status: opts.method === 'POST' ? 415 : 404 }));
  await assert.rejects(createReferenceResolver(db, log)('audio/voice.mp3', { kind: 'audio' }), /S3.*中转/);
  await assert.rejects(createReferenceResolver(db, log)(expiredUrl), /链接已失效.*重新上传/);
  cfg.image_proxy.enabled = false;
  write('images/saved.png');
  assert.match(await createReferenceResolver(db, log)('images/saved.png'), /^data:image\/png;base64,/);
  await assert.rejects(createReferenceResolver(db, log)('/static/../outside.mp3', { kind: 'audio' }), /本地文件不存在/);
});

test('HEAD rejection on signed links falls back to GET and closes the response body', async t => {
  const calls = [];
  let cancelled = 0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    calls.push(opts);
    return { ok: opts.method === 'GET', status: opts.method === 'GET' ? 206 : 403, body: { async cancel() { cancelled += 1; } } };
  });
  assert.equal(await cache.isProxyUrlAlive(newUrl), true);
  assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET']);
  assert.equal(calls[1].headers.Range, 'bytes=0-0');
  assert.equal(cancelled, 2);
});

test('video submission uses renewed first/last frames for the generic API branch', async t => {
  const { root, db, write } = setup(t);
  write('images/frame.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/frame.png');
  addModel(db, 'video', 'openai', 'https://api.example.test');
  let submitted;
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url === 'https://relay.example.test/upload') return new Response(JSON.stringify({ url: newUrl }));
    assert.equal(opts.method, 'POST');
    assert.ok(url.startsWith('https://api.example.test/'));
    submitted = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: 'task-1' }));
  });
  const result = await videoClient.callVideoApi(db, log, {
    model: 'test-model', prompt: 'animate', storage_local_path: root,
    first_frame_url: expiredUrl, last_frame_url: expiredUrl,
  });
  assert.equal(result.task_id, 'task-1');
  assert.ok(JSON.stringify(submitted).includes(newUrl));
  assert.ok(!JSON.stringify(submitted).includes(expiredUrl));
});

test('image submission renews a dead relay cache using the saved reference image', async t => {
  const { root, db, cfg, write } = setup(t);
  const bytes = write('images/frame.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/frame.png');
  const cacheKey = cache.buildProxyCacheKey(bytes, 'image/png', cfg.image_proxy);
  cache.setProxyCache(db, cacheKey, 'https://files.example.test/deleted');
  let submitted;
  const base = await modelServer(t, body => { submitted = body; }, { data: [{ url: 'https://output.example.test/image.png' }] });
  addModel(db, 'image', 'openai', base);
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (opts.method === 'HEAD') return new Response('', { status: 404 });
    assert.equal(url, 'https://relay.example.test/upload');
    return new Response(JSON.stringify({ url: newUrl }));
  });
  const result = await imageClient.callImageApi(db, log, {
    model: 'test-model', prompt: 'redraw', storage_local_path: root, reference_image_urls: [expiredUrl],
  });
  assert.equal(result.image_url, 'https://output.example.test/image.png');
  assert.deepEqual(submitted.image, [newUrl]);
});

test('Responses image generation renews expired local references before constructing input_image content', async t => {
  const { root, db, cfg, write } = setup(t);
  const bytes = write('images/frame.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/frame.png');
  cache.setProxyCache(db, cache.buildProxyCacheKey(bytes, 'image/png', cfg.image_proxy), 'https://files.example.test/deleted');
  let submitted;
  const base = await modelServer(t, body => { submitted = body; }, {
    status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', url: 'https://output.example.test/image.png' }],
  });
  addModel(db, 'image', 'openai', base);
  db.prepare("UPDATE ai_service_configs SET settings = NULL WHERE service_type = 'image'").run();
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (opts.method === 'HEAD') return new Response('', { status: 404 });
    assert.equal(url, 'https://relay.example.test/upload');
    return new Response(JSON.stringify({ url: newUrl }));
  });
  const result = await imageClient.callImageApi(db, log, {
    model: 'test-model', prompt: 'redraw', size: '1440x2560', storage_local_path: root, reference_image_urls: [expiredUrl],
  });
  assert.equal(result.image_url, 'https://output.example.test/image.png');
  assert.deepEqual(submitted.input[0].content[1], { type: 'input_image', image_url: newUrl, detail: 'auto' });
  assert.equal(submitted.background, true);
  assert.deepEqual(submitted.tools, [{ type: 'image_generation', ratio: '9:16', quality: 'high' }]);
});

test('Sora multipart reads the saved image without an unnecessary relay upload', async t => {
  const { root, db, write } = setup(t);
  write('images/frame.png');
  db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/frame.png');
  addModel(db, 'video', 'sora', 'https://api.example.test');
  let submitted;
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://api.example.test/v1/videos');
    submitted = opts.body.toString();
    return new Response(JSON.stringify({ id: 'sora-task' }));
  });
  const result = await videoClient.callVideoApi(db, log, {
    model: 'test-model', image_url: expiredUrl, storage_local_path: root,
  });
  assert.equal(result.task_id, 'sora-task');
  assert.ok(submitted.includes('saved-media'));
  assert.ok(!submitted.includes(expiredUrl));
});

test('official Seedance storage references retain their provider access semantics', async t => {
  const { root, db } = setup(t);
  addModel(db, 'video', 'volcengine', 'https://ark.cn-beijing.volces.com/api/v3');
  const first = 'https://storage.volces.com/private/reference.png?signature=provider-only';
  let submitted;
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.ok(url.startsWith('https://ark.cn-beijing.volces.com/'));
    submitted = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: 'official-task' }));
  });
  const result = await videoClient.callVideoApi(db, log, {
    model: 'test-model', first_frame_url: first, last_frame_url: 'tos://bucket/reference.png', storage_local_path: root,
  });
  assert.equal(result.task_id, 'official-task');
  assert.ok(JSON.stringify(submitted).includes(first));
  assert.ok(JSON.stringify(submitted).includes('tos://bucket/reference.png'));
});

test('Seedance automatically injected local voice audio is relayed before API submission', async t => {
  const { root, db, write } = setup(t);
  write('audio/voice.mp3');
  db.prepare('INSERT INTO characters (drama_id, seedance2_voice_asset) VALUES (1, ?)')
    .run(JSON.stringify({ status: 'active', url: '/static/audio/voice.mp3', local_path: 'audio/voice.mp3' }));
  addModel(db, 'video', 'volcengine_omni', 'https://api.example.test');
  let submitted;
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url === 'https://relay.example.test/upload') return new Response(JSON.stringify({ url: newUrl }));
    assert.ok(url.startsWith('https://api.example.test/'));
    submitted = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: 'seedance-task' }));
  });
  const result = await videoClient.callVideoApi(db, log, { model: 'test-model', drama_id: 1, storage_local_path: root });
  assert.equal(result.task_id, 'seedance-task');
  assert.deepEqual(submitted.content.find(part => part.type === 'audio_url'), {
    type: 'audio_url', audio_url: { url: newUrl }, role: 'reference_audio',
  });
});

test('Gemini uses local bytes for expired references while respecting inline and S3 modes', async t => {
  for (const mode of ['inline', 's3']) {
    await t.test(mode, async t => {
      const { root, db, cfg, write } = setup(t);
      write('images/frame.png');
      db.prepare('INSERT INTO image_generations (image_url, local_path) VALUES (?, ?)').run(expiredUrl, 'images/frame.png');
      cfg.image_proxy.use_for_gemini = mode !== 'inline';
      if (mode === 's3') {
        Object.assign(cfg.storage, { type: 's3', bucket: 'media', endpoint: 'https://s3.example.test', public_base_url: 'https://cdn.example.test' });
        t.mock.method(objectStorage, 'uploadBuffer', async (storage, key, buffer, mime) => {
          assert.equal(buffer.toString(), 'saved-media');
          assert.equal(mime, 'image/png');
          return newUrl;
        });
      }
      let submitted;
      const responseBody = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'b3V0cHV0' } }] } }] };
      const base = await modelServer(t, body => { submitted = body; }, responseBody);
      addModel(db, 'image', 'gemini', base);
      t.mock.method(global, 'fetch', () => { throw new Error('no expired source or relay requests expected'); });
      const result = await imageClient.callImageApi(db, log, {
        model: 'test-model', prompt: 'redraw', storage_local_path: root, reference_image_urls: [expiredUrl],
      });
      assert.equal(result.image_url, 'data:image/png;base64,b3V0cHV0');
      const parts = submitted.contents[0].parts;
      if (mode === 's3') assert.deepEqual(parts.find(part => part.fileData), { fileData: { fileUri: newUrl, mimeType: 'image/png' } });
      else assert.equal(Buffer.from(parts.find(part => part.inlineData).inlineData.data, 'base64').toString(), 'saved-media');
    });
  }
});
