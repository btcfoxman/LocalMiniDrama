// 与 Go UploadService 对齐：保存到 local_path，返回 url / local_path
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const objectStorage = require('./objectStorageService');

const fsp = fs.promises;
const DEFAULT_IMAGE_PROXY_UPLOAD_URL = 'https://imageproxy.zhongzhuan.chat/api/upload';
const DEFAULT_IMAGE_PROXY_TOKEN = 'test';

function trimValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function boolValue(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return defaultValue;
}

function numberValue(value, defaultValue) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function normalizeImageProxySettings(input = {}, current = {}) {
  const source = input || {};
  const get = (key, fallback = '') => {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    return current[key] !== undefined ? current[key] : fallback;
  };
  return {
    enabled: boolValue(get('enabled', true), true),
    upload_url: trimValue(get('upload_url', DEFAULT_IMAGE_PROXY_UPLOAD_URL)) || DEFAULT_IMAGE_PROXY_UPLOAD_URL,
    token: trimValue(get('token', DEFAULT_IMAGE_PROXY_TOKEN)) || DEFAULT_IMAGE_PROXY_TOKEN,
    expire_hours: numberValue(get('expire_hours', 23), 23),
    use_for_gemini: boolValue(get('use_for_gemini', true), true),
  };
}

function loadStorageConfig() {
  try {
    const { loadConfig } = require('../config');
    return loadConfig().storage || {};
  } catch (_) {
    return {};
  }
}

function loadImageProxyConfig(override = null) {
  if (override) return normalizeImageProxySettings(override);
  try {
    const { loadConfig } = require('../config');
    return normalizeImageProxySettings(loadConfig().image_proxy || {});
  } catch (_) {
    return normalizeImageProxySettings({});
  }
}

function isImageProxyEnabled(override = null) {
  const proxy = loadImageProxyConfig(override);
  return !!(proxy.enabled && proxy.upload_url && proxy.token);
}

function buildPublicUrl(localPath, baseUrl = '') {
  const storage = loadStorageConfig();
  const cleanPath = objectStorage.normalizeKey(localPath);
  if (!cleanPath) return '';
  if (objectStorage.isS3Storage(storage)) {
    return objectStorage.publicUrlForKey(storage, cleanPath);
  }
  return baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/${cleanPath}`
    : `/static/${cleanPath}`;
}

/**
 * 用 Node.js 原生 http/https 模块下载 URL 到 Buffer。
 * 比 native fetch 在 Electron 打包环境中更可靠，支持自动跟随 301/302 重定向（最多 5 次）。
 */
function downloadBufferViaNodeHttp(url, timeoutMs = 30000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalMiniDrama/1.0)',
        'Accept': 'image/*,*/*',
      },
      timeout: timeoutMs,
    };
    const req = mod.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return resolve(downloadBufferViaNodeHttp(location, timeoutMs, redirectCount + 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Download timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** @returns {{ dir: string, relPrefix: string }} */
function resolveCategoryPaths(storagePath, category, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/${category}`;
    return { dir: path.join(storagePath, sub, category), relPrefix };
  }
  return { dir: path.join(storagePath, category), relPrefix: category };
}

async function saveBufferToStorage(storagePath, relativePath, buffer, mimeType, log) {
  const cleanPath = objectStorage.normalizeKey(relativePath);
  const filePath = path.join(storagePath, cleanPath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
  const storage = loadStorageConfig();
  if (objectStorage.isS3Storage(storage)) {
    return objectStorage.uploadBuffer(storage, cleanPath, buffer, mimeType, log);
  }
  return buildPublicUrl(cleanPath, storage.base_url || '');
}

async function uploadLocalPathToStorage(storagePath, relativePath, mimeType, log) {
  const cleanPath = objectStorage.normalizeKey(relativePath);
  const filePath = path.join(storagePath, cleanPath);
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch (_) {
    return null;
  }
  const storage = loadStorageConfig();
  if (objectStorage.isS3Storage(storage)) {
    return objectStorage.uploadFile(storage, cleanPath, filePath, mimeType, log);
  }
  return buildPublicUrl(cleanPath, storage.base_url || '');
}

async function ensureLocalFile(storagePath, relativePath, log) {
  const cleanPath = objectStorage.normalizeKey(relativePath);
  if (!cleanPath) return null;
  const filePath = path.join(storagePath, cleanPath);
  if (fs.existsSync(filePath)) return filePath;
  const storage = loadStorageConfig();
  if (!objectStorage.isS3Storage(storage)) return null;
  try {
    await objectStorage.downloadToFile(storage, cleanPath, filePath, log);
    return fs.existsSync(filePath) ? filePath : null;
  } catch (e) {
    log?.warn?.('[storage] download object to cache failed', { key: cleanPath, error: e.message });
    return null;
  }
}

async function uploadFile(storagePath, baseUrl, log, fileBuffer, originalName, mimeType, category, projectSubdir = null) {
  const { dir: categoryPath, relPrefix } = resolveCategoryPaths(storagePath, category, projectSubdir);
  ensureDir(categoryPath);
  const ext = path.extname(originalName) || '.png';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const name = `${timestamp}_${randomUUID()}${ext}`;
  const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
  const url = await saveBufferToStorage(storagePath, relativePath, fileBuffer, mimeType, log)
    || buildPublicUrl(relativePath, baseUrl);
  log.info('File uploaded', { path: path.join(categoryPath, name), url });
  return { url, local_path: relativePath };
}

/**
 * 将远程/Base64 图片保存到本地 storage，避免 AI 链接过期后无法访问
 * @param {string} storagePath - 存储根目录（如 ./data/storage）
 * @param {string} imageUrl - 图片地址（http(s) URL 或 data:image/xxx;base64,...）
 * @param {string} category - 子目录：characters / scenes / images
 * @param {object} log - logger
 * @param {string} [prefix] - 文件名前缀，如 ig_123
 * @param {string|null} [projectSubdir] - 如 projects/0001_20250324_剧名 或 library，与 uploadFile 一致
 * @returns {Promise<string|null>} 相对路径如 characters/xxx.png，失败返回 null
 */
async function downloadImageToLocal(storagePath, imageUrl, category, log, prefix = '', projectSubdir = null) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const { dir: categoryPath, relPrefix } = resolveCategoryPaths(storagePath, category, projectSubdir);
  try {
    ensureDir(categoryPath);
    let buffer;
    let ext = 'png';
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        log.warn('downloadImageToLocal: invalid data URL');
        return null;
      }
      buffer = Buffer.from(match[2], 'base64');
      ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    } else {
      // 使用 Node.js 原生 http/https 模块下载，比 native fetch 在 Electron 打包环境更可靠
      // 失败自动重试最多 3 次
      let lastErr;
      let contentType = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await downloadBufferViaNodeHttp(imageUrl, 30000);
          buffer = result.buffer;
          contentType = result.contentType;
          break;
        } catch (e) {
          lastErr = e;
          log.warn('downloadImageToLocal: 下载失败，准备重试', { category, attempt, error: e.message, url: imageUrl.slice(0, 100) });
          if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
      if (!buffer) {
        log.warn('downloadImageToLocal: 3次重试均失败', { category, error: lastErr?.message });
        return null;
      }
      ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    }
    const name = `${prefix}${prefix ? '_' : ''}${randomUUID().slice(0, 8)}.${ext}`;
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    await saveBufferToStorage(
      storagePath,
      relativePath,
      buffer,
      `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      log
    );
    log.info('Image saved to local', { category, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    log.warn('downloadImageToLocal error', { category, error: e.message });
    return null;
  }
}

/**
 * 将图片 Buffer 上传到中转图床，返回公开访问 URL。
 * 接口：POST https://imageproxy.zhongzhuan.chat/api/upload  (multipart/form-data, field: file)
 * 响应：{ url: "https://imageproxy.zhongzhuan.chat/api/proxy/image/<hash>", created: ... }
 * 失败自动重试，最多 3 次；成功返回 string URL，全部失败返回 null。
 */
async function uploadToImageProxy(imageBuffer, mimeType, log, tag, proxyOverride = null) {
  const proxy = loadImageProxyConfig(proxyOverride);
  if (!proxy.enabled) {
    log?.info?.('[图床上传] 已关闭', { tag });
    return null;
  }
  if (!proxy.upload_url) {
    log?.warn?.('[图床上传] 未配置 upload_url', { tag });
    return null;
  }
  if (!proxy.token) {
    log?.warn?.('[图床上传] 未配置 token，跳过中转上传', { tag, upload_url: proxy.upload_url });
    return null;
  }
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extMap[mimeType] || 'jpg';
  const filename = `ref_${Date.now()}.${ext}`;
  const MAX_ATTEMPTS = 3;
  log.info('[图床上传] ▶ 开始', { tag, filename, size_kb: Math.round(imageBuffer.length / 1024) });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const boundary = 'imgproxy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const headerLine = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
      const footerLine = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(headerLine, 'utf-8'), imageBuffer, Buffer.from(footerLine, 'utf-8')]);
      const res = await fetch(proxy.upload_url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Authorization: `Bearer ${proxy.token}`,
        },
        body,
      });
      const raw = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        log.warn('[图床上传] 失败', { tag, attempt, status: res.status, ms, body: raw.slice(0, 200) });
        if (attempt < MAX_ATTEMPTS) continue;
        return null;
      }
      const data = JSON.parse(raw);
      const url = data?.url || null;
      if (url) { log.info('[图床上传] ✓ 成功', { tag, attempt, url, ms }); return url; }
      log.warn('[图床上传] 响应无 url 字段', { tag, attempt, ms, raw: raw.slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) continue;
      return null;
    } catch (err) {
      log.warn('[图床上传] 请求异常', { tag, attempt, ms: Date.now() - t0, err: err.message });
      if (attempt < MAX_ATTEMPTS) continue;
      return null;
    }
  }
  return null;
}

/**
 * 将本地文件路径或 localhost URL 的图片上传到图床，返回公网 URL。
 * - localPath: 相对 storagePath 的路径，如 "images/ig_xxx.jpg"
 * - localhostUrl: 类似 "http://localhost:5679/static/images/ig_xxx.jpg" 的 URL
 * 两者传其中一个即可；失败返回 null。
 */
async function uploadLocalImageToProxy(storagePath, localPathOrUrl, log, tag) {
  try {
    let filePath = null;
    let mimeType = 'image/jpeg';
    if (localPathOrUrl && localPathOrUrl.startsWith('http')) {
      // localhost URL → 提取 /static/ 后的相对路径
      const afterStatic = localPathOrUrl.split('/static/')[1];
      if (afterStatic && storagePath) {
        filePath = path.join(storagePath, afterStatic.replace(/^\//, ''));
        if (!fs.existsSync(filePath)) {
          filePath = await ensureLocalFile(storagePath, afterStatic, log);
        }
      } else if (storagePath) {
        const storage = loadStorageConfig();
        const objectKey = objectStorage.keyFromPublicUrl(storage, localPathOrUrl);
        if (objectKey) {
          filePath = await ensureLocalFile(storagePath, objectKey, log);
        }
      }
    } else if (localPathOrUrl && storagePath) {
      filePath = path.isAbsolute(localPathOrUrl)
        ? localPathOrUrl
        : path.join(storagePath, localPathOrUrl.replace(/^\//, ''));
      if (!fs.existsSync(filePath) && !path.isAbsolute(localPathOrUrl)) {
        filePath = await ensureLocalFile(storagePath, localPathOrUrl, log);
      }
    }
    if (!filePath || !fs.existsSync(filePath)) {
      log.warn('[图床上传] 本地文件不存在', { tag, filePath });
      return null;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    mimeType = mimeMap[ext] || 'image/jpeg';
    const buf = fs.readFileSync(filePath);
    return await uploadToImageProxy(buf, mimeType, log, tag);
  } catch (e) {
    log.warn('[图床上传] uploadLocalImageToProxy 异常', { tag, err: e.message });
    return null;
  }
}

module.exports = {
  uploadFile,
  downloadImageToLocal,
  uploadToImageProxy,
  uploadLocalImageToProxy,
  normalizeImageProxySettings,
  loadImageProxyConfig,
  isImageProxyEnabled,
  saveBufferToStorage,
  uploadLocalPathToStorage,
  ensureLocalFile,
  buildPublicUrl,
};
