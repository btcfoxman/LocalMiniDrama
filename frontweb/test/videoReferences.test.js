import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareVideoGenerationRequest } from '../src/utils/videoReferences.js'

test('all video reference fields keep same-origin static media on the backend', () => {
  for (const origin of ['http://localhost:3013', 'https://drama.example.com']) {
    const frame = '/static/projects/%E5%89%A7%E9%9B%86/images/frame.png'
    const body = {
      prompt: 'animate',
      image_url: origin + frame,
      first_frame_url: origin + frame,
      last_frame_url: origin + '/static/images/last.png',
      reference_image_urls: [origin + frame, origin + '/static/scenes/scene.png'],
      voice_reference_url: origin + '/static/audio/voice.mp3',
    }
    const prepared = prepareVideoGenerationRequest(body, origin)
    assert.equal(prepared.image_url, frame)
    assert.equal(prepared.first_frame_url, frame)
    assert.equal(prepared.last_frame_url, '/static/images/last.png')
    assert.deepEqual(prepared.reference_image_urls, [frame, '/static/scenes/scene.png'])
    assert.equal(prepared.voice_reference_url, '/static/audio/voice.mp3')
    assert.equal(prepared.prompt, 'animate')
    assert.equal(body.image_url, origin + frame)
    assert.equal(body.reference_image_urls[0], origin + frame)
  }
})

test('foreign media and provider-specific references retain their original identity', () => {
  const origin = 'https://drama.example.com'
  for (const ref of [
    'https://cdn.example.com/static/frame.png?signature=original',
    'https://drama.example.com/provider/frame.png?signature=original',
    'https://drama.example.com:8443/static/frame.png',
    '//cdn.example.com/static/frame.png',
    'data:image/png;base64,c2F2ZWQ=',
    'asset://certified-image',
    'tos://bucket/frame.png',
  ]) {
    assert.equal(prepareVideoGenerationRequest({ image_url: ref }, origin).image_url, ref)
  }
})

test('relative references and repeat submissions stay stable', () => {
  const body = {
    first_frame_url: 'images/frame.png',
    last_frame_url: 'static/images/last.png',
    reference_image_urls: ['/static/images/frame.png', 'scenes\\scene.png'],
  }
  const prepared = prepareVideoGenerationRequest(body)
  assert.equal(prepared.first_frame_url, '/static/images/frame.png')
  assert.equal(prepared.last_frame_url, '/static/images/last.png')
  assert.deepEqual(prepared.reference_image_urls, ['/static/images/frame.png', '/static/scenes/scene.png'])
  assert.deepEqual(prepareVideoGenerationRequest(prepared), prepared)
  assert.deepEqual(prepareVideoGenerationRequest({ prompt: 'text only' }), { prompt: 'text only' })
})
