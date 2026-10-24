const fs = require('fs');
const path = require('path');
const { imageCacheRoots } = require('./imageCacheRecovery');
const uploadService = require('./uploadService');

async function findLocalMedia(roots, value) {
  if (!value || /^(?:https?:|data:)/i.test(value)) return null;
  for (const root of roots) {
    const absolute = path.resolve(root, String(value).replace(/\\/g, '/').replace(/^\/?static\//, ''));
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    const stat = await fs.promises.stat(absolute).catch(() => null);
    if (!stat?.isFile() || !stat.size) continue;
    if (root !== roots[0]) {
      const target = path.join(roots[0], relative);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(absolute, target);
    }
    return relative.replace(/\\/g, '/');
  }
  return null;
}

async function recoverMediaCaches(db, cfg, log, { cwd = process.cwd() } = {}) {
  const roots = imageCacheRoots(cfg, cwd);
  let restored = 0;
  for (const [table, urlColumn] of [['video_generations', 'video_url'], ['assets', 'url']]) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL${table === 'assets' ? " AND type IN ('audio', 'video')" : ''}`).all(); }
    catch (_) { continue; }
    for (const row of rows) {
      try {
        if (table === 'video_generations' && row.status === 'failed' && String(row.error_msg || '').startsWith('视频已生成，但本地缓存失败')) {
          await require('./videoService').retryVideoCache(db, log, row.id);
          restored++;
          continue;
        }
        if (table === 'video_generations' && row.status !== 'completed') continue;
        let localPath = await findLocalMedia(roots, row.local_path);
        if (!localPath && /^https?:\/\//i.test(row[urlColumn] || '')) localPath = await uploadService.downloadMediaToLocal(roots[0], row[urlColumn], row.type || 'video', log, table === 'assets' ? 'asset' : 'vg', table === 'assets' ? 'library' : require('./storageLayout').getProjectStorageSubdir(db, row.drama_id));
        if (localPath && localPath !== row.local_path) {
          restored += db.prepare(`UPDATE ${table} SET local_path = ? WHERE id = ? AND local_path IS ? AND ${urlColumn} IS ? AND deleted_at IS NULL`).run(localPath, row.id, row.local_path ?? null, row[urlColumn] ?? null).changes;
        }
      } catch (error) { log.warn('[素材缓存] 恢复暂未完成', { table, id: row.id, error: error.message }); }
    }
  }
  try {
    for (const row of db.prepare('SELECT audio_local_path, narration_audio_local_path FROM storyboards WHERE deleted_at IS NULL').all()) {
      for (const value of [row.audio_local_path, row.narration_audio_local_path]) await findLocalMedia(roots, value);
    }
  } catch (_) {}
  if (restored) log.info('[素材缓存] 已恢复音视频本地副本', { count: restored });
  return restored;
}

module.exports = { recoverMediaCaches };
