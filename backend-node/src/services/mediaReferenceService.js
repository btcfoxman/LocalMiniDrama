const fs = require('fs');
const path = require('path');
const uploadService = require('./uploadService');
const objectStorage = require('./objectStorageService');
const proxyCache = require('./mediaProxyCache');

const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac',
};

// 精确匹配原始 URL（包含签名参数），不根据文件名猜测素材身份。
const LOCAL_REFERENCE_COLUMNS = [
  ['assets', 'url', 'local_path'],
  ['image_generations', 'image_url', 'local_path'],
  ['video_generations', 'video_url', 'local_path'],
  ['characters', 'image_url', 'local_path'],
  ['scenes', 'image_url', 'local_path'],
  ['props', 'image_url', 'local_path'],
  ['character_libraries', 'image_url', 'local_path'],
  ['scene_libraries', 'image_url', 'local_path'],
  ['prop_libraries', 'image_url', 'local_path'],
  ['storyboards', 'image_url', 'local_path'],
  ['storyboards', 'last_frame_image_url', 'last_frame_local_path'],
];

function storedLocalPaths(db, raw) {
  if (!db) return [];
  const paths = [];
  for (const [table, urlColumn, pathColumn] of LOCAL_REFERENCE_COLUMNS) {
    try {
      const rows = db.prepare(`SELECT ${pathColumn} AS local_path FROM ${table}
        WHERE ${urlColumn} = ? AND deleted_at IS NULL AND ${pathColumn} IS NOT NULL ORDER BY id DESC`).all(raw);
      paths.push(...rows.map(row => row.local_path));
    } catch (_) { /* 兼容旧数据库尚未创建的表/列。 */ }
  }
  try {
    const rows = db.prepare(`SELECT json_extract(seedance2_voice_asset, '$.local_path') AS local_path
      FROM characters WHERE deleted_at IS NULL AND json_valid(seedance2_voice_asset)
      AND json_extract(seedance2_voice_asset, '$.url') = ?`).all(raw);
    paths.push(...rows.map(row => row.local_path));
  } catch (_) {}
  return paths.filter(Boolean);
}

function referenceRelativePath(raw, storage, filesBaseUrl) {
  if (!/^https?:\/\//i.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  for (const base of [filesBaseUrl, storage.public_base_url, storage.base_url,
    storage.endpoint && storage.bucket ? `${storage.endpoint.replace(/\/$/, '')}/${storage.bucket}` : '']) {
    if (!base) continue;
    const prefix = String(base).replace(/\/$/, '') + '/';
    const withoutQuery = url.origin + url.pathname;
    if (withoutQuery.startsWith(prefix)) return withoutQuery.slice(prefix.length);
  }
  if (!isPublicHttpUrl(raw) && url.pathname.startsWith('/static/')) return url.pathname.slice(8);
  return null;
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (!h.includes('.') && !h.includes(':')) return false;
    if (h === '::' || h === '::1' || /^(?:fc|fd)[\da-f]{2}:|^fe80:/i.test(h)) return false;
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [a, b] = parts;
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    return true;
  } catch (_) { return false; }
}

function safeLocalPath(storagePath, value) {
  if (!value || /^(?:https?:|data:|asset:)/i.test(value)) return null;
  try {
    let raw = String(value).split(/[?#]/)[0];
    try { raw = decodeURIComponent(raw); } catch (_) { /* 工程名可能包含未编码的 %。 */ }
    raw = raw.replace(/\\/g, '/').replace(/^\/?static\//i, '');
    if (raw.includes('\0')) return null;
    const root = path.resolve(storagePath);
    const absolute = path.resolve(root, raw);
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return { absolute, relative: relative.replace(/\\/g, '/') };
  } catch (_) {
    return null;
  }
}

/** 每次生成任务创建一个解析器：共享查找结果，避免首帧和参考图重复上传。 */
function createReferenceResolver(db, log, opts = {}) {
  const cfg = require('../config').loadConfig();
  const storage = cfg.storage || {};
  const storagePath = path.resolve(opts.storage_local_path || storage.local_path || './data/storage');
  const proxy = uploadService.loadImageProxyConfig(cfg.image_proxy || {});
  const memo = new Map();
  const transfers = new Map();

  async function resolve(raw, kind, localPathHint, preferLocal) {
    if (!raw || /^(?:data:|asset:|tos:)/i.test(raw)) return raw;
    const candidates = [...new Set([localPathHint, ...storedLocalPaths(db, raw), referenceRelativePath(raw, storage, opts.files_base_url)])]
      .map(value => safeLocalPath(storagePath, value)).filter(Boolean);
    let local = candidates.find(candidate => fs.existsSync(candidate.absolute) && fs.statSync(candidate.absolute).isFile());
    if (!local && objectStorage.isS3Storage(storage)) {
      for (const candidate of candidates) {
        if (await uploadService.ensureLocalFile(storagePath, candidate.relative, log)) {
          local = candidate;
          break;
        }
      }
    }
    if (!local) {
      if (isPublicHttpUrl(raw) && await proxyCache.isProxyUrlAlive(raw)) return raw;
      throw new Error(`参考${kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '图片'}链接已失效或本地文件不存在，请重新上传素材后重试`);
    }
    // 图生接口保留自己的压缩、inlineData 和 Gemini 中转偏好处理。
    if (preferLocal) return local.relative;
    const transferKey = JSON.stringify([kind, local.relative]);
    if (!transfers.has(transferKey)) transfers.set(transferKey, publishLocal(local, kind));
    return transfers.get(transferKey);
  }

  async function publishLocal(local, kind) {
    const mimeType = MIME_TYPES[path.extname(local.relative).toLowerCase()] || 'application/octet-stream';
    if (objectStorage.isS3Storage(storage)) {
      try {
        const url = await uploadService.uploadLocalPathToStorage(storagePath, local.relative, mimeType, log);
        if (isPublicHttpUrl(url)) return url;
      } catch (e) {
        log?.warn?.('[素材中转] S3 上传失败', { kind, error: e.message });
      }
    } else if (uploadService.isImageProxyEnabled(proxy)) {
      const buffer = await fs.promises.readFile(local.absolute);
      // 内容变化或切换中转配置后，不再复用旧文件/旧图床的链接。
      const cacheKey = proxyCache.buildProxyCacheKey(buffer, mimeType, proxy);
      const cached = await proxyCache.getProxyCacheValidated(db, cacheKey, log, opts.video_gen_id);
      if (cached) return cached;
      const url = await uploadService.uploadToImageProxy(buffer, mimeType, log, opts.video_gen_id, proxy);
      if (isPublicHttpUrl(url)) {
        proxyCache.setProxyCache(db, cacheKey, url);
        return url;
      }
    }
    // 图片协议仍可使用 base64；音频/视频参考须得到可供云端拉取的 URL。
    if (kind === 'image') {
      return `data:${mimeType};base64,${(await fs.promises.readFile(local.absolute)).toString('base64')}`;
    }
    throw new Error(`参考${kind === 'audio' ? '音频' : '视频'}上传失败，请检查文件临时图床是否支持该格式，或配置可公开访问的 S3 中转后重试`);
  }

  return (value, { kind = 'image', localPathHint = '', preferLocal = false } = {}) => {
    const raw = String(value || '').trim();
    const key = JSON.stringify([raw, kind, localPathHint, preferLocal]);
    if (!memo.has(key)) memo.set(key, resolve(raw, kind, localPathHint, preferLocal));
    return memo.get(key);
  };
}

async function prepareImageReferences(db, log, opts) {
  if (!Array.isArray(opts.reference_image_urls) || !opts.reference_image_urls.length) return opts;
  const resolve = createReferenceResolver(db, log, opts);
  const refs = [];
  for (const ref of opts.reference_image_urls) refs.push(await resolve(ref, { preferLocal: true }));
  return { ...opts, reference_image_urls: refs };
}

async function prepareVideoReferences(db, log, opts, { preferLocalImages = false, preserveImageReference = () => false } = {}) {
  const resolve = createReferenceResolver(db, log, opts);
  const resolveImage = (value, localPathHint = '') => preserveImageReference(String(value || '').trim())
    ? value : resolve(value, { localPathHint, preferLocal: preferLocalImages });
  const out = { ...opts };
  for (const field of ['image_url', 'first_frame_url', 'last_frame_url']) {
    const localPathHint = field === 'image_url' ? opts.image_local_path : opts[field.replace('_url', '_local_path')];
    if (opts[field] || localPathHint) out[field] = await resolveImage(opts[field] || localPathHint, localPathHint);
  }
  if (Array.isArray(opts.reference_urls)) {
    out.reference_urls = [];
    for (const ref of opts.reference_urls) out.reference_urls.push(await resolveImage(ref));
  }
  if (opts.voice_reference_url) out.voice_reference_url = await resolve(opts.voice_reference_url, { kind: 'audio' });
  return out;
}

module.exports = { createReferenceResolver, prepareImageReferences, prepareVideoReferences };
