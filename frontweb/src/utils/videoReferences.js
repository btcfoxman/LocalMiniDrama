import { normalizeMediaUrl } from './mediaUrl.js'

function videoReferenceUrl(value, origin) {
  if (!value) return value
  const raw = String(value).trim()
  if (/^(?:https?:)?\/\//i.test(raw)) {
    try {
      const url = new URL(raw, origin || undefined)
      // 只有当前应用的静态素材属于后端本地文件；外部同名路径仍保留原地址。
      if (origin && url.origin === new URL(origin).origin && url.pathname.startsWith('/static/')) {
        return url.pathname + url.search
      }
    } catch (_) {}
    return raw
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return raw
  return normalizeMediaUrl(raw)
}

/** 所有视频生成入口共用，避免通过公网域名绕回自身读取本地参考图。 */
export function prepareVideoGenerationRequest(body, origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const out = { ...body }
  for (const field of ['image_url', 'first_frame_url', 'last_frame_url', 'voice_reference_url']) {
    if (body?.[field]) out[field] = videoReferenceUrl(body[field], origin)
  }
  if (Array.isArray(body?.reference_image_urls)) {
    out.reference_image_urls = body.reference_image_urls.map(ref => videoReferenceUrl(ref, origin))
  }
  return out
}
