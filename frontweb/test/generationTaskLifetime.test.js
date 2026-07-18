import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VIDEO_TASK_EXPIRED_MSG,
  activeTaskTerminalMessage,
  localTaskStaleMs,
  pollMaxAttemptsForTask,
} from '../src/utils/generationTaskLifetime.js'

test('video generation remains recoverable when heartbeat is older than ten minutes', () => {
  const now = Date.parse('2026-07-18T06:00:00.000Z')
  const task = {
    type: 'video_generation',
    status: 'processing',
    created_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(now - 30 * 60 * 1000).toISOString(),
  }
  assert.equal(activeTaskTerminalMessage(task, {}, now), '')
})

test('video generation expires six hours after original creation', () => {
  const now = Date.parse('2026-07-18T06:00:00.000Z')
  const task = {
    type: 'video_generation',
    status: 'processing',
    created_at: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(now - 5_000).toISOString(),
  }
  assert.equal(activeTaskTerminalMessage(task, {}, now), VIDEO_TASK_EXPIRED_MSG)
})

test('video task polling and local recovery windows both cover six hours', () => {
  const meta = { resourceType: 'sb_video' }
  assert.equal(pollMaxAttemptsForTask(meta, 2000), 10_800)
  assert.equal(localTaskStaleMs(meta), 6 * 60 * 60 * 1000)
})

test('non-video tasks retain the existing orphan protection', () => {
  const now = Date.parse('2026-07-18T06:00:00.000Z')
  const task = {
    type: 'image_generation',
    status: 'processing',
    created_at: new Date(now - 20 * 60 * 1000).toISOString(),
    updated_at: new Date(now - 11 * 60 * 1000).toISOString(),
  }
  assert.match(activeTaskTerminalMessage(task, {}, now), /长时间无进展/)
  assert.equal(pollMaxAttemptsForTask({ resourceType: 'sb_image' }, 2000), 450)
})
