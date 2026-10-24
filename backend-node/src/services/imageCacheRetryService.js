const path = require('path');
const fs = require('fs');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');

const isCacheFailure = value => String(value || '').startsWith('图片已生成，但本地缓存失败');

async function retryImageCache(db, log, id) {
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new Error('图片记录不存在');
  const cfg = require('../config').loadConfig();
  const storageRoot = path.resolve(cfg.storage?.local_path || './data/storage');
  if (row.status === 'completed' && row.local_path) {
    const absolute = path.resolve(storageRoot, row.local_path);
    const relative = path.relative(storageRoot, absolute);
    if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
      const stat = await fs.promises.stat(absolute).catch(() => null);
      if (stat?.isFile() && stat.size > 0) return row;
    }
  }
  if (!row.image_url || !isCacheFailure(row.error_msg) || row.status !== 'failed') throw new Error('该记录没有待恢复的图片缓存');
  const initialTask = row.task_id ? taskService.getTask(db, row.task_id) : null;
  if (initialTask && !isCacheFailure(initialTask.error)) throw new Error('原任务已取消或结束，不能恢复缓存');
  const category = row.scene_id ? 'scenes' : row.character_id ? 'characters' : initialTask?.type === 'prop_image_generation' ? 'props' : 'images';
  let localPath;
  try {
    localPath = await uploadService.downloadImageToLocal(storageRoot, row.image_url, category, log, 'ig', storageLayout.getProjectStorageSubdir(db, row.drama_id), { throwOnError: true });
    if (!localPath) throw new Error('未取得可用的本地文件');
  } catch (error) {
    throw new Error(uploadService.imageCacheFailureMessage(error));
  }
  const now = new Date().toISOString();
  const imageUrl = uploadService.buildPublicUrl(localPath, cfg.storage?.base_url || '');
  db.transaction(() => {
    const task = row.task_id ? taskService.getTask(db, row.task_id) : null;
    if (task && !isCacheFailure(task.error)) throw new Error('原任务状态已变化，未覆盖当前任务');
    const changed = db.prepare(`UPDATE image_generations SET status = 'completed', error_msg = NULL,
      image_url = ?, local_path = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'failed' AND image_url = ? AND error_msg = ? AND deleted_at IS NULL`)
      .run(imageUrl, localPath, now, now, row.id, row.image_url, row.error_msg);
    if (!changed.changes) throw new Error('图片记录已变化，未覆盖当前图片');
    if (task) {
      taskService.updateTaskResult(db, task.id, { image_generation_id: row.id, image_url: imageUrl, local_path: localPath, status: 'completed' });
      db.prepare('UPDATE async_tasks SET error = NULL WHERE id = ?').run(task.id);
    }
  })();
  log.info('[图片缓存] 已重试保存已有生成结果', { image_gen_id: row.id, local_path: localPath });
  return db.prepare('SELECT * FROM image_generations WHERE id = ?').get(row.id);
}

module.exports = { retryImageCache };
