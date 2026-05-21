/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now) {
  try {
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
}

function list(db, query) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const uploadService = require('./uploadService');
const { getFfmpegPath } = require('../utils/ffmpegPath');

const fsp = fs.promises;

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

function downloadedVideoLooksInvalid(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'empty response';
  const ct = String(contentType || '').toLowerCase();
  const head = buffer.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (ct.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html')) {
    return 'response is HTML';
  }
  if (ct.includes('application/json') || head.startsWith('{')) {
    return 'response is JSON';
  }
  return '';
}

async function readFileHead(filePath, length = 512) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 将远程 video_url 下载到本地
 * @returns {string|null} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  let filePath = '';
  try {
    await fsp.mkdir(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    filePath = path.join(dir, name);
    const res = await fetch(videoUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalMiniDrama/1.0)',
        Accept: 'video/mp4,video/*,*/*',
      },
    });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      return null;
    }
    if (res.body && typeof Readable.fromWeb === 'function') {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(filePath, buf);
    }
    const stat = await fsp.stat(filePath);
    const headBuf = stat.size > 0 ? await readFileHead(filePath) : Buffer.alloc(0);
    const invalidReason = downloadedVideoLooksInvalid(headBuf, res.headers.get('content-type'));
    if (invalidReason) {
      log.warn('Download video returned non-video content', {
        videoGenId,
        reason: invalidReason,
        content_type: res.headers.get('content-type') || '',
        bytes: stat.size,
        url_head: videoUrl.slice(0, 160),
      });
      try {
        await fsp.unlink(filePath);
      } catch (_) {}
      return null;
    }
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    if (filePath) {
      try {
        await fsp.unlink(filePath);
      } catch (_) {}
    }
    log.warn('Download video error', { videoGenId, error: e.message });
    return null;
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免 Grok 等返回实际像素不一致导致连播时画面跳动。
 */
function runProcessAsync(bin, args, log, videoGenId) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      log.warn('[video] ffmpeg start failed', { videoGenId, error: err.message });
      resolve({ status: -1, stderr: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ status: code, stderr });
    });
  });
}

async function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = await runProcessAsync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], log, videoGenId);
  if (r.status !== 0) {
    r = await runProcessAsync(ffmpeg, [...baseArgs, '-an', tmpOut], log, videoGenId);
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      await fsp.unlink(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    await fsp.unlink(absPath);
    await fsp.rename(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      await fsp.unlink(tmpOut);
    } catch (_) {}
    return false;
  }
}

async function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
  await normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

async function processVideoGeneration(db, log, videoGenId) {
  log.info('processVideoGeneration started', { videoGenId });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) {
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, videoGenId);
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const storagePublicBase = cfg.storage?.public_base_url || cfg.storage?.base_url;
    const filesBaseUrl = storagePublicBase ? String(storagePublicBase).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const config = videoClient.getDefaultVideoConfig(db, row.model);
    if (!config) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    let reference_urls = null;
    if (row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    // 优先使用分镜自身的镜头时长（storyboard.duration），其次用 video_generations.duration
    let effectiveDuration = row.duration || null;
    if (row.storyboard_id) {
      const sb = db.prepare('SELECT duration FROM storyboards WHERE id = ?').get(row.storyboard_id);
      if (sb && sb.duration > 0) {
        effectiveDuration = sb.duration;
        log.info('使用分镜镜头时长', { storyboard_id: row.storyboard_id, duration: effectiveDuration, video_gen_id: videoGenId });
      }
    }
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const result = await videoClient.callVideoApi(db, log, {
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: row.image_url,
      first_frame_url: row.first_frame_url,
      last_frame_url: row.last_frame_url,
      reference_urls,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
    });
    const now2 = new Date().toISOString();
    if (result.error) {
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      let localPath = null;
      let finalVideoUrl = directVideo.video_url;
      try {
        const loadConfig = require('../config').loadConfig;
        const cfg = loadConfig();
        const storagePath = path.isAbsolute(cfg.storage?.local_path)
          ? cfg.storage.local_path
          : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
        const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
        localPath = await downloadVideoToLocal(storagePath, directVideo.video_url, videoGenId, log, projectSubdir);
        await maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
        if (localPath) {
          finalVideoUrl = await uploadService.uploadLocalPathToStorage(storagePath, localPath, 'video/mp4', log)
            || uploadService.buildPublicUrl(localPath, cfg.storage?.base_url || '')
            || directVideo.video_url;
        }
      } catch (_) {}
      try {
        db.prepare(
          'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
        ).run('completed', finalVideoUrl, localPath, now2, now2, videoGenId);
      } catch (e) {
        if ((e.message || '').includes('completed_at')) {
          db.prepare(
            'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
          ).run('completed', finalVideoUrl, localPath, now2, videoGenId);
        } else throw e;
      }
      // 自动更新分镜的主视频
      if (row.storyboard_id) {
        try {
          db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
            finalVideoUrl, localPath, now2, row.storyboard_id
          );
          log.info('Updated storyboard video', { storyboard_id: row.storyboard_id, video_url: finalVideoUrl });
        } catch (_) {}
      }
      if (row.task_id) taskService.updateTaskResult(db, row.task_id, { video_generation_id: videoGenId, video_url: finalVideoUrl, status: 'completed' });
      log.info('Video generation completed', { id: videoGenId, video_url: finalVideoUrl, local_path: localPath });
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run(
        'processing',
        now2,
        videoGenId
      );
      const POLL_INTERVAL_MS = 10000;
      const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
      const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
      const pollMaxAttempts = Math.max(
        1,
        Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
      );
      const pollResult = await videoClient.pollVideoTask(
        db,
        log,
        videoGenId,
        result.task_id,
        config,
        pollMaxAttempts,
        POLL_INTERVAL_MS
      );
      const now3 = new Date().toISOString();
      const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
      if (polledVideo.ok) {
        let localPath = null;
        let finalVideoUrl = polledVideo.video_url;
        try {
          const loadConfig = require('../config').loadConfig;
          const cfg = loadConfig();
          const storagePath = path.isAbsolute(cfg.storage?.local_path)
            ? cfg.storage.local_path
            : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
          const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
          localPath = await downloadVideoToLocal(storagePath, polledVideo.video_url, videoGenId, log, projectSubdir);
          await maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
          if (localPath) {
            finalVideoUrl = await uploadService.uploadLocalPathToStorage(storagePath, localPath, 'video/mp4', log)
              || uploadService.buildPublicUrl(localPath, cfg.storage?.base_url || '')
              || polledVideo.video_url;
          }
        } catch (_) {}
        try {
          db.prepare(
            'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
          ).run('completed', finalVideoUrl, localPath, now3, now3, videoGenId);
        } catch (e) {
          if ((e.message || '').includes('completed_at')) {
            db.prepare(
              'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
            ).run('completed', finalVideoUrl, localPath, now3, videoGenId);
          } else throw e;
        }
        // 自动更新分镜的主视频
        if (row.storyboard_id) {
          try {
            db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
              finalVideoUrl, localPath, now3, row.storyboard_id
            );
            log.info('Updated storyboard video (poll)', { storyboard_id: row.storyboard_id, video_url: finalVideoUrl });
          } catch (_) {}
        }
        if (row.task_id) taskService.updateTaskResult(db, row.task_id, { video_generation_id: videoGenId, video_url: finalVideoUrl, status: 'completed' });
        log.info('Video generation completed (after poll)', { id: videoGenId, local_path: localPath });
      } else {
        setVideoGenFailed(db, videoGenId, polledVideo.error, now3);
        if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
        log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
      }
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const now2 = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now2);
    if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation error', { id: videoGenId, error: err.message });
  }
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

module.exports = {
  list,
  getById,
  deleteById,
  processVideoGeneration,
};
