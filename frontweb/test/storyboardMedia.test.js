import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSbVideoRecord, videoRecordUrl, imageRecordUrl } from '../src/utils/storyboardMedia.js'

test('storyboard image cache is not used as a video path after reload', () => {
  const sb = { id: 1, local_path: 'images/frame.png', image_url: 'https://expired.example.test/frame', video_url: '/static/videos/result.mp4' }
  assert.equal(imageRecordUrl(sb), '/static/images/frame.png')
  assert.equal(videoRecordUrl(resolveSbVideoRecord(sb, {})), '/static/videos/result.mp4')
  assert.equal(resolveSbVideoRecord({ ...sb, video_url: null }, {}), null)
})
