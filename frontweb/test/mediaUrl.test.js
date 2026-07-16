import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMediaUrl } from '../src/utils/mediaUrl.js'

test('keeps an existing static media URL unchanged', () => {
  assert.equal(
    normalizeMediaUrl('/static/projects/demo/videos/merged/episode.mp4'),
    '/static/projects/demo/videos/merged/episode.mp4'
  )
})

test('converts storage-relative paths to static media URLs', () => {
  assert.equal(
    normalizeMediaUrl('projects/demo/videos/merged/episode.mp4'),
    '/static/projects/demo/videos/merged/episode.mp4'
  )
  assert.equal(normalizeMediaUrl('static/videos/episode.mp4'), '/static/videos/episode.mp4')
})

test('keeps remote and browser-native media URLs unchanged', () => {
  for (const url of [
    'https://cdn.example.com/episode.mp4?token=abc',
    'http://127.0.0.1:5679/static/videos/episode.mp4',
    'blob:https://app.example.com/id',
  ]) {
    assert.equal(normalizeMediaUrl(url), url)
  }
})

test('returns an empty URL for missing values', () => {
  assert.equal(normalizeMediaUrl(null), '')
  assert.equal(normalizeMediaUrl('  '), '')
})
