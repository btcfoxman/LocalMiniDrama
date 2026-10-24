export function isImageCacheFailure(value) {
  return String(value || '').startsWith('图片已生成，但本地缓存失败')
}

export async function retrySavedImage(api, scope) {
  const data = await api.list({ ...scope, status: 'failed', page_size: 100 })
  let record = (data?.items || []).find(item => isImageCacheFailure(item.error_msg) && item.image_url)
  if (!record) {
    const recovered = await api.list({ ...scope, status: 'completed', page_size: 1 })
    record = (recovered?.items || []).find(item => item.local_path)
  }
  if (!record) throw new Error('没有找到待恢复的生成结果，请检查图片记录')
  return api.retryCache(record.id)
}
