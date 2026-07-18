const DEFAULT_VIDEO_GENERATION_TIMEOUT_MINUTES = 6 * 60;
const MAX_VIDEO_GENERATION_TIMEOUT_MINUTES = 6 * 60;
const VIDEO_GENERATION_EXPIRED_MSG = '视频生成任务已超过6小时有效期，请重新生成';

/**
 * 异步视频任务最长保留 6 小时。配置可缩短该时间，但不能超过 6 小时；
 * 缺省或非法值直接使用 6 小时。
 */
function resolveVideoGenerationTimeoutMinutes(cfg) {
  const raw = Number(cfg?.video?.generation_timeout_minutes);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_VIDEO_GENERATION_TIMEOUT_MINUTES;
  return Math.min(raw, MAX_VIDEO_GENERATION_TIMEOUT_MINUTES);
}

/**
 * 有效期从视频任务首次创建时起算，重启后只继续使用剩余时间。
 */
function resolveVideoGenerationLifetime(createdAt, cfg, nowMs = Date.now()) {
  const timeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const lifetimeMs = timeoutMinutes * 60 * 1000;
  const parsedCreatedAt = Date.parse(createdAt || '');
  const createdAtMs = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : nowMs;
  const deadlineMs = createdAtMs + lifetimeMs;
  const remainingMs = Math.max(0, deadlineMs - nowMs);
  return {
    timeoutMinutes,
    lifetimeMs,
    createdAtMs,
    deadlineMs,
    remainingMs,
    expired: remainingMs <= 0,
  };
}

module.exports = {
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MINUTES,
  MAX_VIDEO_GENERATION_TIMEOUT_MINUTES,
  VIDEO_GENERATION_EXPIRED_MSG,
  resolveVideoGenerationTimeoutMinutes,
  resolveVideoGenerationLifetime,
};
