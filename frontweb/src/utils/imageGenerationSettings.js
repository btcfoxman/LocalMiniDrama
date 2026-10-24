function parseSettings(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) { return {} }
}

export function isAsyncImageGeneration(settings) {
  return ![false, 0, 'false'].includes(parseSettings(settings).image_async)
}

export function buildImageGenerationSettings(settings, enabled) {
  return { ...parseSettings(settings), image_async: !!enabled }
}

export function responsesImageEndpointPreview(baseUrl, endpoint, queryEndpoint) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const join = value => {
    let ep = '/' + String(value).replace(/^\/+/, '')
    if (/\/v1$/i.test(base) && ep.startsWith('/v1/')) ep = ep.slice(3)
    return (base || '(未填 Base URL)') + ep
  }
  const configured = String(endpoint || '').trim()
  const isAuto = !configured || /^\/?(?:v1\/)?images\/generations\/?$/i.test(configured)
  const submit = join(isAuto ? '/v1/responses' : configured)
  return {
    submit,
    query: queryEndpoint ? join(queryEndpoint) : submit.replace(/\/$/, '') + '/{response_id}',
    isAuto,
  }
}
