// 图片、视频和音频中转共用同一张缓存表，使用前确认远端仍可读取。
const crypto = require('crypto');

function buildProxyCacheKey(buffer, mimeType, proxy = require('./uploadService').loadImageProxyConfig()) {
  return 'media:' + crypto.createHash('sha256')
    .update(JSON.stringify([proxy.upload_url, proxy.token, mimeType])).update(buffer).digest('hex');
}

function getProxyCache(db, cacheKey) {
  try {
    const row = db.prepare('SELECT proxy_url, created_at FROM image_proxy_cache WHERE cache_key = ?').get(cacheKey);
    if (!row?.proxy_url) return null;
    const { loadConfig } = require('../config');
    const hours = Number(loadConfig()?.image_proxy?.expire_hours ?? 23);
    const expireMs = (Number.isFinite(hours) && hours > 0 ? hours : 23) * 3600000;
    const createdAt = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt >= expireMs) {
      deleteProxyCache(db, cacheKey);
      return null;
    }
    return row.proxy_url;
  } catch (_) {
    return null;
  }
}

function deleteProxyCache(db, cacheKey) {
  try { db.prepare('DELETE FROM image_proxy_cache WHERE cache_key = ?').run(cacheKey); } catch (_) {}
}

async function isProxyUrlAlive(url, timeoutMs = 8000) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  let res;
  try {
    res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (res.ok) return true;
    // 签名下载地址可能仅允许 GET，不能把拒绝 HEAD 误判为文件已过期。
    if ([403, 405, 501].includes(res.status)) {
      await res.body?.cancel();
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    }
    return res.ok || res.status === 206;
  } catch (_) {
    return false;
  } finally {
    // 服务端可能忽略 Range；立即关闭响应体，避免把整个视频下载到内存。
    try { await res?.body?.cancel(); } catch (_) {}
  }
}

async function getProxyCacheValidated(db, cacheKey, log, tag) {
  const url = getProxyCache(db, cacheKey);
  if (!url) return null;
  if (await isProxyUrlAlive(url)) return url;
  deleteProxyCache(db, cacheKey);
  log?.warn?.('[素材中转] 缓存链接已失效，将重新上传', { tag, cache_key: cacheKey });
  return null;
}

function setProxyCache(db, cacheKey, proxyUrl) {
  try {
    db.prepare('INSERT OR REPLACE INTO image_proxy_cache (cache_key, proxy_url, created_at) VALUES (?, ?, ?)')
      .run(cacheKey, proxyUrl, new Date().toISOString());
  } catch (_) {}
}

module.exports = { buildProxyCacheKey, getProxyCache, deleteProxyCache, isProxyUrlAlive, getProxyCacheValidated, setProxyCache };
