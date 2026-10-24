const { AsyncLocalStorage } = require('async_hooks');
const uploadService = require('./uploadService');
const { buildProxyCacheKey, setProxyCache } = require('./mediaProxyCache');
const uploads = new AsyncLocalStorage();

function withReferenceUploads(callback) {
  return uploads.run(new Map(), callback);
}

async function uploadReference(buffer, mimeType, log, db, tag, proxy) {
  const key = buildProxyCacheKey(buffer, mimeType, proxy);
  const current = uploads.getStore();
  if (current?.has(key)) return current.get(key);
  const pending = uploadService.uploadToImageProxy(buffer, mimeType, log, tag, proxy).then(url => {
    if (url && db) setProxyCache(db, key, url);
    return url;
  });
  current?.set(key, pending);
  return pending;
}

module.exports = { withReferenceUploads, uploadReference };
