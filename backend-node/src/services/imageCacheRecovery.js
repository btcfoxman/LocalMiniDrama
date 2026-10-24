const fs = require('fs');
const path = require('path');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');

const IMAGE_COLUMNS = [
  ['assets', 'url', 'local_path', 'uploads'],
  ['image_generations', 'image_url', 'local_path', 'images'],
  ['characters', 'image_url', 'local_path', 'characters'],
  ['scenes', 'image_url', 'local_path', 'scenes'],
  ['props', 'image_url', 'local_path', 'props'],
  ['character_libraries', 'image_url', 'local_path', 'characters'],
  ['scene_libraries', 'image_url', 'local_path', 'scenes'],
  ['prop_libraries', 'image_url', 'local_path', 'props'],
  ['storyboards', 'image_url', 'local_path', 'images'],
  ['storyboards', 'last_frame_image_url', 'last_frame_local_path', 'images'],
];

function imageCacheRoots(cfg, cwd = process.cwd()) {
  return [...new Set([cfg.storage?.local_path || './data/storage', './data/storage', './data/storage-cache']
    .map(value => path.resolve(cwd, value)))];
}

function safeImagePath(root, value) {
  if (!value || /^(?:https?:|data:)/i.test(value)) return null;
  const relative = String(value).replace(/\\/g, '/').replace(/^\/?static\//, '');
  if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(relative)) return null;
  const absolute = path.resolve(root, relative);
  const check = path.relative(root, absolute);
  if (!check || check.startsWith('..' + path.sep) || check === '..' || path.isAbsolute(check)) return null;
  return { absolute, relative: check.replace(/\\/g, '/') };
}

async function existingImagePath(roots, values) {
  for (const value of values) {
    for (const root of roots) {
      const file = safeImagePath(root, value);
      if (!file) continue;
      try {
        const stat = await fs.promises.stat(file.absolute);
        if (!stat.isFile() || !stat.size) continue;
        if (root !== roots[0]) {
          const target = safeImagePath(roots[0], file.relative);
          await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
          await fs.promises.copyFile(file.absolute, target.absolute);
        }
        return file.relative;
      } catch (_) {}
    }
  }
  return null;
}

/** 启动时恢复文件与数据库的关联。只读取已保存的素材地址，不触发新的 AI 生成。 */
async function recoverImageCaches(db, cfg, log, { cwd = process.cwd() } = {}) {
  const roots = imageCacheRoots(cfg, cwd);
  const saved = new Map();
  let restored = 0;
  for (const [table, urlColumn, pathColumn, defaultCategory] of IMAGE_COLUMNS) {
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND
        (COALESCE(${urlColumn}, '') != '' OR COALESCE(${pathColumn}, '') != '')${table === 'assets' ? " AND type = 'image'" : ''}`).all();
    } catch (_) { continue; }
    for (const row of rows) {
      const source = String(row[urlColumn] || '').trim();
      const cacheFailed = String(row.error_msg || '').startsWith('图片已生成，但本地缓存失败');
      const initialTask = table === 'image_generations' && row.task_id ? taskService.getTask(db, row.task_id) : null;
      const interrupted = row.status === 'processing' && initialTask?.error === taskService.ORPHAN_ASYNC_TASK_MSG;
      if (table === 'image_generations' && row.status !== 'completed' && !cacheFailed && !interrupted) continue;
      const initialPath = row[pathColumn];
      const staticPath = source.startsWith('/static/') ? decodeStaticPath(source) : null;
      let localPath = await existingImagePath(roots, [initialPath, staticPath, source ? saved.get(source) : null]);
      if (!localPath && /^(?:https?:\/\/|data:image\/)/i.test(source)) {
        const category = table === 'image_generations' ? (row.scene_id ? 'scenes' : row.character_id ? 'characters' : initialTask?.type === 'prop_image_generation' ? 'props' : 'images') : defaultCategory;
        const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
        localPath = await uploadService.downloadImageToLocal(roots[0], source, category, log, 'ig', projectSubdir);
      }
      if (!localPath) continue;
      if (source) saved.set(source, localPath);
      if (localPath === initialPath && !cacheFailed && !interrupted) continue;
      // 下载期间用户可能替换了主图，不能将旧结果回写到新素材上。
      const result = db.prepare(`UPDATE ${table} SET ${pathColumn} = ? WHERE id = ? AND ${urlColumn} IS ? AND ${pathColumn} IS ? AND deleted_at IS NULL`)
        .run(localPath, row.id, row[urlColumn], initialPath ?? null);
      if (!result.changes) continue;
      restored += 1;
      if (table === 'image_generations' && (cacheFailed || interrupted)) {
        const task = row.task_id ? taskService.getTask(db, row.task_id) : null;
        if (!task || String(task.error || '').startsWith('图片已生成，但本地缓存失败') || task.error === taskService.ORPHAN_ASYNC_TASK_MSG) {
          const now = new Date().toISOString();
          db.prepare("UPDATE image_generations SET status = 'completed', error_msg = NULL, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(now, now, row.id);
          if (task) taskService.updateTaskResult(db, row.task_id, { image_generation_id: row.id, image_url: source, local_path: localPath, status: 'completed' });
        }
      }
    }
  }
  if (restored) log.info('[图片缓存] 已恢复本地图片关联', { count: restored });
  return restored;
}

function decodeStaticPath(source) {
  const value = source.split(/[?#]/)[0];
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

module.exports = { recoverImageCaches, imageCacheRoots };
