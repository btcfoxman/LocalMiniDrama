export const VIDEO_TASK_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000
export const DEFAULT_TASK_POLL_WINDOW_MS = 15 * 60 * 1000
export const DEFAULT_LOCAL_TASK_STALE_MS = 30 * 60 * 1000
export const DEFAULT_ORPHAN_PROCESSING_MS = 10 * 60 * 1000

export const VIDEO_TASK_EXPIRED_MSG = '视频生成任务已超过6小时有效期，请重新生成'
export const ORPHAN_TASK_MSG = '任务长时间无进展，可能因服务重启而中断，请重新操作'

export function isVideoGenerationTask(remote, meta = {}) {
  return remote?.type === 'video_generation' || meta?.resourceType === 'sb_video'
}

/**
 * 返回进行中任务的终止原因；返回空表示仍应继续轮询。
 * 视频任务以 created_at 的 6 小时绝对有效期为准，不再被 10 分钟通用僵尸判定误杀。
 */
export function activeTaskTerminalMessage(
  remote,
  meta = {},
  nowMs = Date.now(),
  orphanProcessingMs = DEFAULT_ORPHAN_PROCESSING_MS
) {
  if (!remote || !['pending', 'processing', 'running'].includes(remote.status)) return ''

  if (isVideoGenerationTask(remote, meta)) {
    const createdAtMs = remote.created_at ? new Date(remote.created_at).getTime() : Number.NaN
    if (Number.isFinite(createdAtMs) && nowMs - createdAtMs >= VIDEO_TASK_MAX_LIFETIME_MS) {
      return VIDEO_TASK_EXPIRED_MSG
    }
    return ''
  }

  const updatedAtMs = remote.updated_at ? new Date(remote.updated_at).getTime() : Number.NaN
  if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > orphanProcessingMs) {
    return ORPHAN_TASK_MSG
  }
  return ''
}

export function pollMaxAttemptsForTask(meta = {}, intervalMs = 2000) {
  const windowMs = isVideoGenerationTask(null, meta)
    ? VIDEO_TASK_MAX_LIFETIME_MS
    : DEFAULT_TASK_POLL_WINDOW_MS
  return Math.max(1, Math.ceil(windowMs / Math.max(1, intervalMs)))
}

export function localTaskStaleMs(meta = {}) {
  return isVideoGenerationTask(null, meta)
    ? VIDEO_TASK_MAX_LIFETIME_MS
    : DEFAULT_LOCAL_TASK_STALE_MS
}
