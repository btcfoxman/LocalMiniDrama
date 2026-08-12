export function videoModelNameFromAiConfig(config) {
  if (!config) return ''
  const defaultModel = String(config.default_model || '').trim()
  if (defaultModel) return defaultModel
  const models = config.model
  if (Array.isArray(models) && models.length) return String(models[0] || '').trim()
  return String(models || '').trim()
}

export function isSeedance2VideoModel(modelName) {
  const model = String(modelName || '').toLowerCase().trim()
  if (!model) return false
  if (/seedance[-_]?2|seedance2/.test(model)) return true
  if (/2[-_]0[-_]/.test(model)) return true
  return /(^|[-_./])sd2($|[-_./])/.test(model)
}

export function isHappyHorseReferenceVideoConfig(config) {
  if (!config) return false
  const protocol = String(config.api_protocol || '').trim().toLowerCase()
  const provider = String(config.provider || '').trim().toLowerCase()
  const usesDashScope = protocol === 'dashscope' || (!protocol && provider === 'dashscope')
  if (!usesDashScope) return false
  return /^happyhorse-1\.(?:0|1)-r2v$/i.test(videoModelNameFromAiConfig(config))
}

export function canUseUniversalOmniVideoApi(config) {
  if (!config) return false
  const protocol = String(config.api_protocol || '').toLowerCase()
  const provider = String(config.provider || '').toLowerCase()
  const model = videoModelNameFromAiConfig(config).toLowerCase()
  if (isHappyHorseReferenceVideoConfig(config)) return true
  if (protocol === 'kling_omni') return true
  // 显式选择全能协议即表示渠道支持多图，模型名可能是网关别名。
  if (protocol === 'volcengine_omni') return true
  if (protocol === 'agnes' || provider === 'agnes' || /agnes-video/.test(model)) return true
  return false
}
