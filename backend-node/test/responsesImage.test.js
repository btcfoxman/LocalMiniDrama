const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');
const aiConfigService = require('../src/services/aiConfigService');
const taskService = require('../src/services/taskService');
const { callImageApi } = require('../src/services/imageClient');
const { callResponsesImageApi, responsesImageUrls, imageRatio } = require('../src/services/responsesImageClient');

const log = { info() {}, warn() {}, error() {} };
const model = 'gpt-image-2-2k';
const imageUrl = 'https://download.example.test/images/local-algorithm/result';
const done = { id: 'resp_image-1', status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: null, url: imageUrl }] };
const runtime = { pollIntervalMs: 1, timeoutMs: 1000, retryBaseDelayMs: 1 };

async function serverFor(t, replies) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply.closeSocket) { req.socket.destroy(); return; }
    res.statusCode = reply.httpStatus || 200;
    res.setHeader('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(reply.headers || {})) res.setHeader(name, value);
    res.end(typeof reply.raw === 'string' ? reply.raw : JSON.stringify(reply.data ?? reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  const cfg = { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'test-key', model: [model], is_active: true, is_default: true, provider: 'custom', api_protocol: 'openai' };
  return { cfg, requests };
}

test('Responses endpoints support versioned bases, old sync defaults and custom query placeholders', () => {
  for (const base_url of ['https://api.example.test', 'https://api.example.test/v1', 'https://api.example.test/v1/']) {
    for (const endpoint of ['', '/images/generations', '/v1/images/generations', '/v1/responses']) {
      assert.deepEqual(responsesImageUrls({ base_url, endpoint }, 'resp_1'), {
        submit: 'https://api.example.test/v1/responses', query: 'https://api.example.test/v1/responses/resp_1',
      });
    }
  }
  assert.deepEqual(responsesImageUrls({ base_url: 'https://api.example.test/v1', endpoint: '/custom/responses', query_endpoint: '/custom/jobs/{taskId}' }, 'resp/a?b'), {
    submit: 'https://api.example.test/v1/custom/responses', query: 'https://api.example.test/v1/custom/jobs/resp%2Fa%3Fb',
  });
  assert.equal(imageRatio('1440x2560'), '9:16');
  assert.equal(imageRatio('2240*1680'), '4:3');
  assert.equal(imageRatio('1024x1024', '9：16'), '9:16');
});

test('async image request matches the supplied schema and polls the response id, not metadata.task_id', async t => {
  const { cfg, requests } = await serverFor(t, [
    { id: 'resp_image-1', status: 'queued', metadata: { task_id: 'imgtask_wrong-id' } },
    { id: 'resp_image-1', status: 'in_progress', output: [{ type: 'image_generation_call', status: 'generating', result: null }] },
    done,
  ]);
  const ref = 'https://imageproxy.example.test/reference.png';
  let heartbeats = 0;
  const result = await callResponsesImageApi(cfg, log, {
    model, prompt: '生成高清直播截图，4K', size: '1440x2560', reference_image_urls: [ref], onProgress: () => { heartbeats += 1; },
  }, runtime);
  assert.deepEqual(result, { image_url: imageUrl });
  assert.deepEqual(requests.map(r => [r.method, r.url]), [
    ['POST', '/v1/responses'], ['GET', '/v1/responses/resp_image-1'], ['GET', '/v1/responses/resp_image-1'],
  ]);
  assert.deepEqual(requests[0].body, {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: '生成高清直播截图，4K' }, { type: 'input_image', image_url: ref, detail: 'auto' }] }],
    stream: false, tools: [{ type: 'image_generation', ratio: '9:16', quality: 'high' }], background: true,
  });
  assert.ok(requests.every(r => r.headers.authorization === 'Bearer test-key'));
  assert.ok(heartbeats >= 2);
});

test('completed URL and base64 responses need no polling', async t => {
  for (const output of [
    done.output,
    [{ type: 'image_generation_call', status: 'completed', result: 'c2F2ZWQ=' }],
    [{ type: 'image_generation_call', status: 'completed', output_format: 'webp', result: 'c2F2ZWQ=' }],
  ]) {
    await t.test(output[0].url ? 'URL' : output[0].output_format || 'PNG', async t => {
      const { cfg, requests } = await serverFor(t, [{ status: 'completed', output }]);
      const result = await callResponsesImageApi(cfg, log, { model, prompt: 'draw' }, runtime);
      assert.equal(result.image_url, output[0].url || `data:image/${output[0].output_format || 'png'};base64,c2F2ZWQ=`);
      assert.equal(requests.length, 1);
    });
  }
});

test('provider failures, incomplete results, missing response ids and malformed JSON fail clearly', async t => {
  const cases = [
    [{ status: 'failed', error: { message: '内容审核失败' } }, /内容审核失败/],
    [{ status: 'cancelled' }, /已取消/],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, /max_output_tokens/],
    [{ status: 'completed', output: [] }, /未返回图片/],
    [{ status: 'in_progress', output: [{ type: 'image_generation_call', status: 'failed', error: { message: 'image tool failed' } }] }, /image tool failed/],
    [{ status: 'queued' }, /response_id/],
    [{ raw: '<html>bad gateway</html>' }, /返回格式异常/],
    [{ httpStatus: 404, data: { error: { message: 'unsupported endpoint' } } }, /unsupported endpoint.*关闭/],
  ];
  for (const [reply, expected] of cases) {
    await t.test(String(expected), async t => {
      const { cfg, requests } = await serverFor(t, [reply]);
      const result = await callResponsesImageApi(cfg, log, { model }, runtime);
      assert.match(result.error, expected);
      assert.equal(requests.length, 1);
    });
  }
});

test('poll retries transient failures without creating another paid generation', async t => {
  const { cfg, requests } = await serverFor(t, [
    { id: 'resp_image-1', status: 'queued' },
    { httpStatus: 429, data: { error: { message: 'rate limited' } } },
    { httpStatus: 503, data: { error: { message: 'try later' } } },
    done,
  ]);
  assert.deepEqual(await callResponsesImageApi(cfg, log, { model }, runtime), { image_url: imageUrl });
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(requests.filter(r => r.method === 'GET').length, 3);
});

test('submission retries gateway failures with a stable key and unchanged request, then only polls the accepted task', async t => {
  const { cfg, requests } = await serverFor(t, [
    { httpStatus: 502, data: { error: { message: '生成失败，请稍后重试~~' } } },
    { httpStatus: 503, headers: { 'retry-after-ms': '1' }, data: { error: { message: 'busy' } } },
    { id: 'resp_image-1', status: 'queued' }, done,
  ]);
  const progress = [];
  assert.deepEqual(await callResponsesImageApi(cfg, log, { model: 'gpt-image-2', onProgress: p => { progress.push(p.status); } }, runtime), { image_url: imageUrl });
  assert.deepEqual(requests.map(r => r.method), ['POST', 'POST', 'POST', 'GET']);
  assert.ok(progress.includes('retry_wait'));
  assert.ok(requests[0].headers['idempotency-key']);
  for (const req of requests.slice(1, 3)) {
    assert.equal(req.headers['idempotency-key'], requests[0].headers['idempotency-key']);
    assert.equal(req.headers['x-client-request-id'], requests[0].headers['x-client-request-id']);
    assert.deepEqual(req.body, requests[0].body);
  }
});

test('gateway failure with an accepted response id resumes that response without resubmission', async t => {
  const { cfg, requests } = await serverFor(t, [
    { httpStatus: 502, data: { id: 'resp_image-1', status: 'queued', error: null } }, done,
  ]);
  assert.deepEqual(await callResponsesImageApi(cfg, log, { model }, runtime), { image_url: imageUrl });
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['POST', '/v1/responses'], ['GET', '/v1/responses/resp_image-1']]);
});

test('gateway retries stop at three attempts and retain the provider request id', async t => {
  const { cfg, requests } = await serverFor(t, [
    { httpStatus: 502, headers: { 'x-request-id': 'provider-request-123' }, data: { error: { message: '生成失败，请稍后重试~~' } } },
  ]);
  const result = await callResponsesImageApi(cfg, log, { model }, runtime);
  assert.match(result.error, /502.*生成失败.*已尝试 3 次.*provider-request-123/);
  assert.equal(requests.length, 3);
});

test('permanent errors, terminal tasks and uncertain timeouts never create another generation', async t => {
  for (const reply of [
    { httpStatus: 502, data: { id: 'resp_image-1', status: 'failed', error: { message: 'failed' } } },
    { httpStatus: 502, data: { error: { code: 'insufficient_quota', message: 'no credits' } } },
    { httpStatus: 502, data: { error: { message: '模型不支持此接口' } } },
    { httpStatus: 502, headers: { 'x-should-retry': 'false' }, data: { error: { message: 'failed' } } },
    { httpStatus: 504, raw: '<html>Gateway Timeout</html>' },
    { httpStatus: 502, raw: '<html>Bad Gateway</html>' },
    { httpStatus: 502, data: { metadata: { task_id: 'imgtask_accepted' }, error: { message: 'try again' } } },
    { httpStatus: 401, data: { error: { message: 'invalid key' } } },
  ]) {
    const { cfg, requests } = await serverFor(t, [reply]);
    assert.ok((await callResponsesImageApi(cfg, log, { model }, runtime)).error);
    assert.equal(requests.length, 1);
  }
});

test('retry waits respect provider delays, local cancellation and the total deadline', async t => {
  await t.test('cancellation during retry wait', async t => {
    const { cfg, requests } = await serverFor(t, [{ httpStatus: 502, raw: 'busy' }, done]);
    const result = await callResponsesImageApi(cfg, log, { model, onProgress: p => p.status !== 'retry_wait' }, runtime);
    assert.match(result.error, /已取消/);
    assert.equal(requests.length, 1);
  });
  for (const headers of [{ 'retry-after': '120' }, { 'retry-after-ms': '120000' }, { 'retry-after': new Date(Date.now() + 120000).toUTCString() }]) {
    const { cfg, requests } = await serverFor(t, [{ httpStatus: 503, headers, raw: 'busy' }, done]);
    assert.match((await callResponsesImageApi(cfg, log, { model }, runtime)).error, /503/);
    assert.equal(requests.length, 1);
  }
});

test('a lost submission response is not automatically submitted again', async t => {
  const { cfg, requests } = await serverFor(t, [{ closeSocket: true }, done]);
  const result = await callResponsesImageApi(cfg, log, { model }, runtime);
  assert.match(result.error, /未收到服务商确认.*未自动重新提交/);
  assert.equal(requests.length, 1);
});

test('a submission cannot start after the overall deadline', async t => {
  const { cfg, requests } = await serverFor(t, [done]);
  const result = await callResponsesImageApi(cfg, log, {
    model, onProgress: () => new Promise(resolve => setTimeout(resolve, 20)),
  }, { ...runtime, timeoutMs: 10 });
  assert.match(result.error, /提交超时/);
  assert.equal(requests.length, 0);
});

test('a local cancellation while a completion is in flight prevents returning the image', async t => {
  const { cfg, requests } = await serverFor(t, [{ id: 'resp_image-1', status: 'queued' }]);
  let active = true;
  t.mock.method(global, 'fetch', async () => {
    active = false;
    return new Response(JSON.stringify(done));
  });
  const result = await callResponsesImageApi(cfg, log, { model, onProgress: () => active }, runtime);
  assert.match(result.error, /已取消或结束/);
  assert.equal(result.image_url, undefined);
  assert.equal(requests.length, 1);
});

test('an image task cancelled before submission creates no provider request', async t => {
  const { cfg, requests } = await serverFor(t, [done]);
  const result = await callResponsesImageApi(cfg, log, { model, onProgress: () => false }, runtime);
  assert.match(result.error, /已取消或结束/);
  assert.equal(requests.length, 0);
});

test('poll stops on permanent HTTP errors, cancellation and the absolute deadline', async t => {
  await t.test('permanent query error', async t => {
    const { cfg, requests } = await serverFor(t, [{ id: 'resp_image-1', status: 'queued' }, { httpStatus: 401, data: { error: { message: 'invalid key' } } }]);
    assert.match((await callResponsesImageApi(cfg, log, { model }, runtime)).error, /401.*invalid key/);
    assert.equal(requests.length, 2);
  });
  await t.test('local cancellation', async t => {
    const { cfg, requests } = await serverFor(t, [{ id: 'resp_image-1', status: 'queued' }]);
    assert.match((await callResponsesImageApi(cfg, log, { model, onProgress: () => false }, runtime)).error, /已取消或结束/);
    assert.equal(requests.length, 0);
  });
  await t.test('deadline', async t => {
    const { cfg, requests } = await serverFor(t, [{ id: 'resp_image-1', status: 'in_progress' }]);
    assert.match((await callResponsesImageApi(cfg, log, { model }, { timeoutMs: 50, pollIntervalMs: 100 })).error, /超时/);
    assert.equal(requests.length, 1);
  });
});

test('image and storyboard configs default to Responses; the saved switch restores synchronous generation', async t => {
  for (const serviceType of ['image', 'storyboard_image']) {
    await t.test(serviceType, async t => {
      const { cfg, requests } = await serverFor(t, [done, { data: { data: [{ url: imageUrl }] } }]);
      const db = new Database(':memory:');
      t.after(() => db.close());
      db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
      db.exec('ALTER TABLE ai_service_configs ADD COLUMN api_protocol TEXT');
      t.mock.method(config, 'loadConfig', () => ({ storage: { type: 'local' }, image_proxy: { enabled: false } }));
      const saved = aiConfigService.createConfig(db, log, { ...cfg, model: [model], service_type: serviceType, endpoint: '/images/generations' });
      const opts = { model, prompt: 'draw', size: '1440x2560', imageServiceType: serviceType };
      assert.deepEqual(await callImageApi(db, log, opts), { image_url: imageUrl });
      aiConfigService.updateConfig(db, log, saved.id, { settings: JSON.stringify({ image_async: false, quality: 'medium' }) });
      assert.equal(JSON.parse(aiConfigService.getConfig(db, saved.id).settings).image_async, false);
      assert.deepEqual(await callImageApi(db, log, opts), { image_url: imageUrl });
      assert.equal(requests[0].url, '/v1/responses');
      assert.equal(requests[0].body.background, true);
      assert.equal(requests[1].url, '/images/generations');
      assert.equal(requests[1].body.prompt, 'draw');
      assert.equal(requests[1].body.quality, 'medium');
      assert.equal(requests[1].body.background, undefined);
    });
  }
});

test('Responses polling keeps the existing image task alive before returning its result', async t => {
  const { cfg } = await serverFor(t, [{ id: 'resp_image-1', status: 'queued' }, done]);
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  db.exec('ALTER TABLE ai_service_configs ADD COLUMN api_protocol TEXT');
  t.mock.method(config, 'loadConfig', () => ({ storage: { type: 'local' }, image_proxy: { enabled: false } }));
  aiConfigService.createConfig(db, log, { ...cfg, service_type: 'image' });
  const task = taskService.createTask(db, log, 'image_generation', '1');
  const row = db.prepare("INSERT INTO image_generations (status, task_id) VALUES ('processing', ?)").run(task.id);
  assert.deepEqual(await callImageApi(db, log, { model, image_gen_id: row.lastInsertRowid }), { image_url: imageUrl });
  assert.equal(taskService.getTask(db, task.id).status, 'processing');
  assert.match(taskService.getTask(db, task.id).message, /后台生成/);
});

test('async image requests retain user negative prompts', async t => {
  const { cfg, requests } = await serverFor(t, [done]);
  t.mock.method(aiConfigService, 'listConfigs', () => [cfg]);
  const result = await callImageApi(null, log, { model, prompt: 'draw a scene', user_negative_prompt: 'no logos, no watermarks' });
  assert.equal(result.image_url, imageUrl);
  assert.match(requests[0].body.input[0].content[0].text, /draw a scene/);
  assert.match(requests[0].body.input[0].content[0].text, /no logos, no watermarks/);
  assert.equal(requests[0].body.negative_prompt, undefined);
});

test('legacy OpenAI-compatible protocol names still use the enabled background mode', async t => {
  const { cfg, requests } = await serverFor(t, [done]);
  cfg.api_protocol = 'openai-compatible';
  t.mock.method(aiConfigService, 'listConfigs', () => [cfg]);
  assert.equal((await callImageApi(null, log, { model })).image_url, imageUrl);
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(requests[0].body.background, true);
});

test('explicit synchronous-capacity rejection falls back once to background generation', async t => {
  const { cfg, requests } = await serverFor(t, [
    { httpStatus: 429, data: { error: { message: 'Synchronous image capacity is busy; use background image generation or retry' } } },
    done,
  ]);
  cfg.settings = JSON.stringify({ image_async: false });
  t.mock.method(aiConfigService, 'listConfigs', () => [cfg]);
  assert.equal((await callImageApi(null, log, { model })).image_url, imageUrl);
  assert.deepEqual(requests.map(r => r.url), ['/images/generations', '/v1/responses']);
  assert.equal(requests[1].body.background, true);
});

test('ordinary rate limits keep their original error and do not submit another task', async t => {
  const { cfg, requests } = await serverFor(t, [{ httpStatus: 429, data: { error: { message: 'Insufficient quota' } } }]);
  cfg.settings = JSON.stringify({ image_async: false });
  t.mock.method(aiConfigService, 'listConfigs', () => [cfg]);
  assert.match((await callImageApi(null, log, { model })).error, /429.*Insufficient quota/);
  assert.equal(requests.length, 1);
});
