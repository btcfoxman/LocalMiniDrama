import test from 'node:test'
import assert from 'node:assert/strict'
import { buildImageGenerationSettings, isAsyncImageGeneration, responsesImageEndpointPreview } from '../src/utils/imageGenerationSettings.js'

test('new and existing image configs default to async; explicit sync choices survive editing', () => {
  for (const settings of [undefined, null, '', '{}', 'invalid JSON', { quality: 'high' }]) {
    assert.equal(isAsyncImageGeneration(settings), true)
  }
  const original = { quality: 'high', image_async: true, custom_field: 'keep' }
  const saved = buildImageGenerationSettings(original, false)
  assert.equal(isAsyncImageGeneration(JSON.stringify(saved)), false)
  assert.deepEqual(saved, { quality: 'high', image_async: false, custom_field: 'keep' })
  assert.equal(original.image_async, true)
  assert.equal(isAsyncImageGeneration(buildImageGenerationSettings(JSON.stringify(saved), true)), true)
})

test('endpoint preview shows Responses POST and GET with one v1 prefix', () => {
  for (const base of ['https://api.example.com', 'https://api.example.com/v1/']) {
    assert.deepEqual(responsesImageEndpointPreview(base, '/images/generations'), {
      submit: 'https://api.example.com/v1/responses', query: 'https://api.example.com/v1/responses/{response_id}', isAuto: true,
    })
  }
  assert.deepEqual(responsesImageEndpointPreview('https://api.example.com/v1', '/custom/responses', '/custom/jobs/{response_id}'), {
    submit: 'https://api.example.com/v1/custom/responses', query: 'https://api.example.com/v1/custom/jobs/{response_id}', isAuto: false,
  })
})
