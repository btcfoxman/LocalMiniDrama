import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canUseUniversalOmniVideoApi,
  isHappyHorseReferenceVideoConfig,
} from '../src/utils/videoModelCapabilities.js'

test('accepts HappyHorse 1.1 R2V with explicit DashScope protocol', () => {
  const config = {
    provider: 'dashscope',
    api_protocol: 'dashscope',
    default_model: 'happyhorse-1.1-r2v',
  }
  assert.equal(isHappyHorseReferenceVideoConfig(config), true)
  assert.equal(canUseUniversalOmniVideoApi(config), true)
})

test('accepts HappyHorse 1.0 R2V when DashScope protocol is inferred from provider', () => {
  assert.equal(canUseUniversalOmniVideoApi({
    provider: 'dashscope',
    api_protocol: '',
    model: ['happyhorse-1.0-r2v'],
  }), true)
})

test('does not classify HappyHorse T2V or I2V as multi-reference models', () => {
  for (const model of ['happyhorse-1.1-t2v', 'happyhorse-1.1-i2v']) {
    assert.equal(canUseUniversalOmniVideoApi({
      provider: 'dashscope',
      api_protocol: 'dashscope',
      default_model: model,
    }), false)
  }
})

test('does not override an explicitly incompatible protocol', () => {
  assert.equal(canUseUniversalOmniVideoApi({
    provider: 'dashscope',
    api_protocol: 'openai',
    default_model: 'happyhorse-1.1-r2v',
  }), false)
})

test('preserves existing universal video capability checks', () => {
  assert.equal(canUseUniversalOmniVideoApi({ api_protocol: 'kling_omni' }), true)
  assert.equal(canUseUniversalOmniVideoApi({
    api_protocol: 'volcengine_omni',
    default_model: 'doubao-seedance-2-0-260128',
  }), true)
  assert.equal(canUseUniversalOmniVideoApi({
    api_protocol: 'volcengine_omni',
    default_model: 'doubao-seedance-1-5-pro-251215',
  }), false)
})
