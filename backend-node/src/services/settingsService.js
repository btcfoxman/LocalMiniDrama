const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const objectStorage = require('./objectStorageService');
const uploadService = require('./uploadService');

let configPath = null;
let configCache = null;

function setConfigPath(cfg) {
  const paths = [
    path.join(process.cwd(), 'configs', 'config.yaml'),
    path.join(process.cwd(), 'config.yaml'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      configPath = p;
      return p;
    }
  }
  return null;
}

function getLanguage(cfg) {
  return cfg?.app?.language || 'zh';
}

function getConfigPath() {
  if (configPath && fs.existsSync(configPath)) return configPath;
  return setConfigPath();
}

function readYamlConfig() {
  const p = getConfigPath();
  if (!p) return {};
  try {
    return yaml.load(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeYamlConfig(config) {
  const p = getConfigPath();
  if (!p) return false;
  fs.writeFileSync(p, yaml.dump(config, { lineWidth: -1 }), 'utf8');
  return true;
}

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

const LOCAL_STORAGE_DEFAULTS = Object.freeze({
  type: 'local',
  local_path: './data/storage-cache',
  base_url: '',
  public_base_url: '',
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  force_path_style: true,
  signing_host: '',
  public_read: false,
  access_key_id: '',
  secret_access_key: '',
  user_customized: false,
});

function normalizeStorageType(value) {
  return String(value || 'local').trim().toLowerCase() === 's3' ? 's3' : 'local';
}

function normalizeStorageSettings(input, current = {}) {
  const source = input || {};
  const type = normalizeStorageType(source.type || current.type || 'local');
  const get = (key, fallback = '') => {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    return current[key] !== undefined ? current[key] : fallback;
  };

  if (type === 'local') {
    return {
      ok: true,
      storage: {
        ...LOCAL_STORAGE_DEFAULTS,
        local_path: trimValue(get('local_path', LOCAL_STORAGE_DEFAULTS.local_path)) || LOCAL_STORAGE_DEFAULTS.local_path,
        user_customized: boolValue(get('user_customized', LOCAL_STORAGE_DEFAULTS.user_customized), LOCAL_STORAGE_DEFAULTS.user_customized),
      },
    };
  }

  const next = {
    ...LOCAL_STORAGE_DEFAULTS,
    type: 's3',
    local_path: trimValue(get('local_path', LOCAL_STORAGE_DEFAULTS.local_path)) || LOCAL_STORAGE_DEFAULTS.local_path,
    base_url: trimValue(get('base_url')),
    public_base_url: trimValue(get('public_base_url')),
    endpoint: trimValue(get('endpoint')),
    bucket: trimValue(get('bucket')),
    region: trimValue(get('region', 'us-east-1')) || 'us-east-1',
    force_path_style: boolValue(get('force_path_style', true), true),
    signing_host: trimValue(get('signing_host')),
    public_read: boolValue(get('public_read', true), true),
    access_key_id: trimValue(get('access_key_id')),
    secret_access_key: trimValue(get('secret_access_key')),
    user_customized: boolValue(get('user_customized', true), true),
  };

  if (!next.endpoint) return { ok: false, error: 'S3 endpoint is required' };
  if (!/^https?:\/\//i.test(next.endpoint)) return { ok: false, error: 'S3 endpoint must start with http:// or https://' };
  if (!next.bucket) return { ok: false, error: 'S3 bucket is required' };
  if (!next.access_key_id) return { ok: false, error: 'S3 access_key_id is required' };
  if (!next.secret_access_key) return { ok: false, error: 'S3 secret_access_key is required' };
  return { ok: true, storage: next };
}

function normalizeImageProxyInput(input, current = {}) {
  return uploadService.normalizeImageProxySettings(input || {}, current || {});
}

function getStorageSettings(cfg) {
  const storage = {
    ...LOCAL_STORAGE_DEFAULTS,
    ...(cfg?.storage || {}),
  };
  storage.type = normalizeStorageType(storage.type);
  const imageProxy = normalizeImageProxyInput(cfg?.image_proxy || {});
  return {
    storage,
    image_proxy: imageProxy,
    public_url_preview: storage.type === 's3' ? objectStorage.publicUrlForKey(storage, 'example.png') : '/static/example.png',
  };
}

function updateStorageSettings(cfg, log, input) {
  const normalized = normalizeStorageSettings(input, cfg?.storage || {});
  if (!normalized.ok) return normalized;
  const storage = { ...normalized.storage, user_customized: true };
  const imageProxy = normalizeImageProxyInput(
    Object.prototype.hasOwnProperty.call(input || {}, 'image_proxy') ? input.image_proxy : cfg?.image_proxy,
    cfg?.image_proxy || {}
  );
  if (!cfg.storage) cfg.storage = {};
  cfg.storage = storage;
  cfg.image_proxy = imageProxy;

  try {
    const current = readYamlConfig();
    current.storage = storage;
    current.image_proxy = imageProxy;
    writeYamlConfig(current);
  } catch (err) {
    log?.warn?.('Failed to write storage config', { error: err.message });
    return { ok: false, error: 'Failed to write config file: ' + err.message };
  }
  log?.info?.('Storage config updated', storage.type === 's3'
    ? { type: storage.type, endpoint: storage.endpoint, bucket: storage.bucket, signing_host: storage.signing_host || '' }
    : { type: storage.type, local_path: storage.local_path });
  return {
    ok: true,
    storage,
    image_proxy: imageProxy,
    public_url_preview: storage.type === 's3' ? objectStorage.publicUrlForKey(storage, 'example.png') : '/static/example.png',
  };
}

async function testStorageSettings(cfg, log, input) {
  const normalized = normalizeStorageSettings(input || cfg?.storage || {}, cfg?.storage || {});
  if (!normalized.ok) return normalized;
  const storage = normalized.storage;
  const imageProxy = normalizeImageProxyInput(
    Object.prototype.hasOwnProperty.call(input || {}, 'image_proxy') ? input.image_proxy : cfg?.image_proxy,
    cfg?.image_proxy || {}
  );
  if (storage.type !== 's3') {
    if (imageProxy.enabled) {
      const png1x1 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64'
      );
      const url = await uploadService.uploadToImageProxy(png1x1, 'image/png', log, 'settings_image_proxy_test', imageProxy);
      if (!url) {
        return { ok: false, type: 'image_proxy', error: 'Image proxy upload failed. Please check upload URL and token.' };
      }
      return { ok: true, type: 'image_proxy', message: 'Image proxy upload test passed', url };
    }
    return {
      ok: true,
      type: 'local',
      message: 'Local storage mode does not upload test objects',
      url: '/static/example.png',
      deleted: false,
    };
  }
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key = `diagnostics/storage-test-${suffix}.txt`;
  const body = Buffer.from(`LocalMiniDrama storage test ${new Date().toISOString()}\n`, 'utf8');
  try {
    const url = await objectStorage.uploadBuffer(storage, key, body, 'text/plain', log);
    let deleted = false;
    try {
      deleted = await objectStorage.deleteObject(storage, key, log);
    } catch (err) {
      log?.warn?.('Storage test cleanup failed', { key, error: err.message });
    }
    return { ok: true, key, url, deleted };
  } catch (err) {
    return { ok: false, error: err.message || 'Storage test failed' };
  }
}

function updateLanguage(cfg, log, language) {
  if (language !== 'zh' && language !== 'en') {
    return { ok: false, error: '只支持 zh 或 en' };
  }
  if (!cfg.app) cfg.app = {};
  cfg.app.language = language;
  setConfigPath(cfg);
  if (configPath) {
    try {
      const current = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      if (!current.app) current.app = {};
      current.app.language = language;
      fs.writeFileSync(configPath, yaml.dump(current, { lineWidth: -1 }), 'utf8');
    } catch (err) {
      log.warnw('Failed to write config file', { error: err.message });
    }
  }
  log.infow('System language updated', { language });
  return { ok: true, language };
}

/**
 * 从 global_settings 表读取一个键值，返回解析后的值，不存在时返回 defaultValue。
 */
function getGlobalSetting(db, key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  } catch (_) { return defaultValue; }
}

/**
 * 向 global_settings 表写入一个键值（value 会被 JSON.stringify）。
 */
function setGlobalSetting(db, key, value) {
  const now = new Date().toISOString();
  const str = JSON.stringify(value);
  db.prepare(
    `INSERT INTO global_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, str, now);
}

module.exports = {
  setConfigPath,
  getLanguage,
  updateLanguage,
  getStorageSettings,
  updateStorageSettings,
  testStorageSettings,
  getGlobalSetting,
  setGlobalSetting,
};
