const { postJSONWithTimeout } = require('./aiClient');
const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_SUBMIT_RETRIES = 2;

function retryDelay(headers, fallback) {
  const ms = Number(headers?.['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers?.['retry-after'];
  if (value !== undefined) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return fallback;
}

function canRetrySubmission(res, data) {
  // A response ID belongs to an existing generation, including terminal failures.
  // Never submit another generation in that case, or after an ambiguous socket timeout.
  if (data?.id || data?.status || data?.metadata?.task_id || res.headers?.['x-should-retry'] === 'false') return false;
  if (![500, 502, 503].includes(res.statusCode)) return false;
  const detail = `${data?.error?.code || ''} ${data?.error?.type || ''} ${errorMessage(data?.error || data, res.raw)}`;
  if (/invalid|unsupported|not.supported|authentication|unauthori|permission|quota|billing|insufficient|content.policy|moderation|safety|参数|不支持|密钥|余额|配额|审核|违规|权限/i.test(detail)) return false;
  // A generic proxy error page cannot confirm whether the paid task was accepted.
  return res.headers?.['x-should-retry'] === 'true' || /busy|overload|try.again|try.later|retry|temporar|unavailable|server_error|upstream_error|生成失败|繁忙|稍后重试|暂时不可用/i.test(detail);
}

function joinEndpoint(baseUrl, endpoint) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let ep = '/' + String(endpoint || '').replace(/^\/+/, '');
  if (/\/v1$/i.test(base) && ep.startsWith('/v1/')) ep = ep.slice(3);
  return base + ep;
}

function responsesImageUrls(config, responseId = '{response_id}') {
  const base = String(config.base_url || '').replace(/\/+$/, '');
  const configured = String(config.endpoint || '').trim();
  const standardImageEndpoint = /^\/?(?:v1\/)?images\/generations\/?$/i.test(configured);
  const submit = joinEndpoint(base, configured && !standardImageEndpoint ? configured : '/v1/responses');
  const encodedId = responseId === '{response_id}' ? responseId : encodeURIComponent(responseId);
  const query = config.query_endpoint
    ? joinEndpoint(base, config.query_endpoint).replace(/\{(?:response_id|responseId|taskId|id)\}/g, encodedId)
    : submit.replace(/\/$/, '') + '/' + encodedId;
  return { submit, query };
}

function imageRatio(size, aspectRatio) {
  const ratio = String(aspectRatio || '').replace(/：/g, ':').trim();
  if (/^[1-9]\d*:[1-9]\d*$/.test(ratio)) return ratio;
  const match = String(size || '').match(/^(\d+)\s*[x*×:]\s*(\d+)$/i);
  if (!match) return '1:1';
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return '1:1';
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

function errorMessage(error, fallback) {
  if (typeof error === 'string' && error) return error;
  return error?.message || error?.code || fallback;
}

function parseImageResponse(data) {
  if (data?.error) return { error: errorMessage(data.error, '图片异步生成失败') };
  const status = data?.status;
  if (['failed', 'cancelled', 'canceled', 'incomplete'].includes(status)) {
    const fallback = status === 'incomplete'
      ? '图片异步生成未完成: ' + (data.incomplete_details?.reason || 'incomplete')
      : status === 'failed' ? '图片异步生成失败' : '图片异步生成已取消';
    return { error: fallback };
  }
  const outputs = Array.isArray(data?.output) ? data.output.filter(item => item?.type === 'image_generation_call') : [];
  const failed = outputs.find(item => item.status === 'failed' || item.error);
  if (failed) return { error: errorMessage(failed.error, '图片生成工具执行失败') };
  if (status && status !== 'completed') return null;
  for (const item of outputs) {
    if (item.status && item.status !== 'completed') continue;
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url.trim())) {
      return { image_url: item.url.trim() };
    }
    if (typeof item.result === 'string' && item.result.trim()) {
      const result = item.result.replace(/\s/g, '');
      if (/^data:image\//i.test(result)) return { image_url: result };
      const format = item.output_format === 'jpeg' ? 'jpeg' : item.output_format === 'webp' ? 'webp' : 'png';
      return { image_url: `data:image/${format};base64,${result}` };
    }
  }
  return status === 'completed' ? { error: '图片异步生成已完成，但未返回图片地址或图片数据' } : null;
}

/** 提交临时失败最多重试两次；取得任务 ID 后只查询，不重新生成。 */
async function callResponsesImageApi(config, log, opts, runtime = {}) {
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const { submit } = responsesImageUrls(config);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (config.api_key || '') };
  // Reuse the same key and body on retries. Third-party relays may not implement deduplication.
  const submissionKey = randomUUID();
  const submitHeaders = { ...headers, 'Idempotency-Key': submissionKey, 'X-Client-Request-Id': submissionKey };
  const cancelled = { error: '图片生成任务已取消或结束' };
  if (await opts.onProgress?.({ status: 'submitting' }) === false) return cancelled;
  const prompt = opts.negative_prompt
    ? `${opts.prompt || ''}\n\nAvoid these elements: ${opts.negative_prompt}`
    : opts.prompt || '';
  const content = [
    { type: 'input_text', text: prompt },
    ...(opts.reference_image_urls || []).map(image_url => ({ type: 'input_image', image_url, detail: 'auto' })),
  ];
  const body = {
    model: opts.model,
    input: [{ role: 'user', content }],
    stream: false,
    tools: [{ type: 'image_generation', ratio: imageRatio(opts.size, opts.aspect_ratio), quality: opts.quality || 'high' }],
    background: true,
  };
  log.info('[图生][Responses] 提交异步图片任务', { image_gen_id: opts.image_gen_id, model: opts.model, url: submit, ref_count: content.length - 1 });

  let data;
  let submissionAccepted = false;
  for (let attempt = 0; attempt <= MAX_SUBMIT_RETRIES; attempt += 1) {
    if (await opts.onProgress?.({ status: 'submitting', attempt: attempt + 1 }) === false) return cancelled;
    if (Date.now() >= deadline) return { error: '图片异步生成提交超时' };
    let res;
    try {
      res = await postJSONWithTimeout(submit, submitHeaders, body, Math.max(1, Math.min(60000, deadline - Date.now())));
    } catch (e) {
      log.warn('[图生][Responses] 提交结果未确认', { image_gen_id: opts.image_gen_id, model: opts.model, client_request_id: submissionKey, error: e.message });
      return { error: '图片异步生成提交请求失败: ' + e.message + '；未收到服务商确认，为避免重复任务未自动重新提交，请先检查服务商任务记录' };
    }
    try { data = JSON.parse(res.raw); } catch (_) { data = null; }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const requestId = res.headers?.['x-request-id'] || res.headers?.['request-id'] || '';
      const hasResponseId = typeof data?.id === 'string' && !!data.id.trim();
      // Some relays wrap an accepted Response in a 5xx status. Continue that task.
      if (hasResponseId && ['queued', 'in_progress', 'completed'].includes(data.status) && !data.error) {
        submissionAccepted = true;
        log.warn('[图生][Responses] 提交状态异常但已返回任务，继续读取原任务', { image_gen_id: opts.image_gen_id, status: res.statusCode, response_id: data.id, request_id: requestId });
        break;
      }
      let message = res.raw.slice(0, 300);
      if (data) message = String(errorMessage(data.error || data, message)).slice(0, 300);
      const transient = canRetrySubmission(res, data);
      log.warn('[图生][Responses] 提交失败', { image_gen_id: opts.image_gen_id, model: opts.model, status: res.statusCode, attempt: attempt + 1, request_id: requestId, client_request_id: submissionKey, error: message });
      const delay = retryDelay(res.headers, (runtime.retryBaseDelayMs ?? 2000) * 2 ** attempt);
      if (transient && attempt < MAX_SUBMIT_RETRIES && Date.now() + delay < deadline) {
        const retryAt = Date.now() + delay;
        do {
          if (await opts.onProgress?.({ status: 'retry_wait', attempt: attempt + 1, retry_at: retryAt }) === false) return cancelled;
          const remaining = retryAt - Date.now();
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
        } while (Date.now() < retryAt);
        continue;
      }
      const hint = [404, 405].includes(res.statusCode) ? '；可在 AI 配置中关闭「异步生成」使用同步接口' : '';
      const retryHint = transient ? `；上游图片服务暂时不可用，已尝试 ${attempt + 1} 次，请稍后重试或联系服务商` : '';
      const trace = requestId ? `；请求 ID: ${String(requestId).slice(0, 160)}` : '';
      return { error: `图片异步生成提交失败 (${res.statusCode}): ${message}${hint}${retryHint}${trace}` };
    }
    if (!data) return { error: '图片异步生成返回格式异常' };
    submissionAccepted = true;
    break;
  }
  if (!submissionAccepted) return { error: '图片异步生成提交超时' };
  const responseId = data?.id;
  const result = parseImageResponse(data);
  if (result) {
    if (result.image_url && await opts.onProgress?.(data) === false) return cancelled;
    return result;
  }
  if (!responseId || typeof responseId !== 'string') return { error: '图片异步生成未返回 response_id' };
  const { query } = responsesImageUrls(config, responseId);
  log.info('[图生][Responses] 已创建后台任务', { image_gen_id: opts.image_gen_id, response_id: responseId, status: data.status });
  while (Date.now() < deadline) {
    if (await opts.onProgress?.(data) === false) return cancelled;
    const delay = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (Date.now() >= deadline) break;
    let res;
    try {
      res = await fetch(query, { method: 'GET', headers, signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now()))) });
      const raw = await res.text();
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          log.warn('[图生][Responses] 查询暂时失败，继续轮询', { image_gen_id: opts.image_gen_id, status: res.status });
          continue;
        }
        let message = raw.slice(0, 300);
        try { const parsed = JSON.parse(raw); message = errorMessage(parsed.error || parsed, message); } catch (_) {}
        return { error: `图片异步生成查询失败 (${res.status}): ${message}` };
      }
      try { data = JSON.parse(raw); } catch (_) { return { error: '图片异步生成查询返回格式异常' }; }
    } catch (e) {
      log.warn('[图生][Responses] 查询网络异常，继续轮询', { image_gen_id: opts.image_gen_id, error: e.message });
      continue;
    }
    const polled = parseImageResponse(data);
    if (polled) {
      if (polled.image_url && await opts.onProgress?.(data) === false) return cancelled;
      return polled;
    }
    if (!['queued', 'in_progress'].includes(data?.status)) {
      return { error: '图片异步生成返回未知状态: ' + (data?.status || '(empty)') };
    }
  }
  return { error: `图片异步生成超时（${Math.round(timeoutMs / 60000)} 分钟），请稍后重试` };
}

module.exports = { callResponsesImageApi, responsesImageUrls, imageRatio };
