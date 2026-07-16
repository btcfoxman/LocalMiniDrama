/**
 * 将后端媒体字段转换为浏览器可访问的地址。
 * 后端既可能返回 storage 相对路径，也可能已经返回 /static/ 地址；
 * 已带 /static/ 时必须原样保留，避免生成 /static/static/...。
 */
export function normalizeMediaUrl(value) {
  if (value === undefined || value === null) return ''
  const raw = String(value).trim()
  if (!raw) return ''
  if (/^(?:https?:|data:|blob:)/i.test(raw) || raw.startsWith('//')) return raw

  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/static/')) return normalized
  if (normalized.startsWith('static/')) return '/' + normalized
  return '/static/' + normalized.replace(/^\/+/, '')
}

/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return normalizeMediaUrl(lp)
  return normalizeMediaUrl(item.image_url)
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return normalizeMediaUrl(lp)
  return normalizeMediaUrl(sb.video_url)
}

export function audioUrl(localPath) {
  return normalizeMediaUrl(localPath)
}
