const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { promisify } = require('util');

let desktopFetch = null;
const decompress = {
  gzip: promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
};

// The desktop installs Electron's net.fetch after app.ready, so downloads follow
// the same system proxy and certificate settings as the image preview.
function setMediaDownloadFetch(fetcher) {
  if (fetcher !== null && typeof fetcher !== 'function') throw new TypeError('Invalid image download transport');
  desktopFetch = fetcher;
}

function downloadError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw downloadError('图片地址不是 HTTP/HTTPS 链接', 'INVALID_IMAGE_URL');
  return url;
}

function downloadViaNode(url, deadline, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(downloadError('图片下载重定向次数过多', 'TOO_MANY_REDIRECTS'));
    const parsed = httpUrl(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(downloadError('图片下载超时', 'ETIMEDOUT'));
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const req = mod.get(parsed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalMiniDrama/1.0)', Accept: 'image/*,*/*', 'Accept-Encoding': 'gzip, deflate, br' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        try {
          const location = httpUrl(new URL(res.headers.location, parsed).href).href;
          clearTimeout(timer);
          downloadViaNode(location, deadline, redirects + 1).then(result => finish(null, result), finish);
        } catch (error) { finish(error); }
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        finish(downloadError(`HTTP ${res.statusCode}`, 'IMAGE_HTTP_ERROR', res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', finish);
      res.on('aborted', () => finish(downloadError('图片下载连接中断', 'ECONNRESET')));
      res.on('end', async () => {
        try {
          let buffer = Buffer.concat(chunks);
          const encodings = String(res.headers['content-encoding'] || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s && s !== 'identity');
          for (const encoding of encodings.reverse()) {
            if (!decompress[encoding]) throw downloadError('不支持的图片传输编码: ' + encoding, 'INVALID_IMAGE_ENCODING');
            buffer = await decompress[encoding](buffer);
          }
          finish(null, { buffer, contentType: String(res.headers['content-type'] || '') });
        } catch (error) { finish(error); }
      });
    });
    timer = setTimeout(() => {
      finish(downloadError('图片下载超时', 'ETIMEDOUT'));
      req.destroy();
    }, remaining);
    req.on('error', finish);
  });
}

async function downloadImageBuffer(url, { timeoutMs = 90000, log } = {}) {
  httpUrl(url);
  const deadline = Date.now() + timeoutMs;
  if (desktopFetch) {
    try {
      const res = await desktopFetch(url, {
        method: 'GET', headers: { Accept: 'image/*,*/*' },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw downloadError(`HTTP ${res.status}`, 'IMAGE_HTTP_ERROR', res.status);
      }
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
    } catch (error) {
      // An explicit HTTP rejection is final for this attempt. Only retry the
      // transport through Node when Chromium itself could not make the request.
      if (error.statusCode || Date.now() >= deadline) throw error;
      log?.warn?.('[图片下载] 桌面网络通道异常，尝试直接下载', { code: error.code, error: error.message });
    }
  }
  return downloadViaNode(url, deadline);
}

async function fetchMedia(url, options = {}) {
  httpUrl(url);
  return (desktopFetch || global.fetch)(url, options);
}

module.exports = { downloadImageBuffer, setMediaDownloadFetch, fetchMedia };
