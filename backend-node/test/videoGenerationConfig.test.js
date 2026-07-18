const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MINUTES,
  MAX_VIDEO_GENERATION_TIMEOUT_MINUTES,
  resolveVideoGenerationTimeoutMinutes,
  resolveVideoGenerationLifetime,
} = require('../src/config/videoGeneration');

describe('video generation lifetime', () => {
  it('defaults to six hours and caps larger configuration values', () => {
    assert.equal(DEFAULT_VIDEO_GENERATION_TIMEOUT_MINUTES, 360);
    assert.equal(MAX_VIDEO_GENERATION_TIMEOUT_MINUTES, 360);
    assert.equal(resolveVideoGenerationTimeoutMinutes(), 360);
    assert.equal(resolveVideoGenerationTimeoutMinutes({ video: { generation_timeout_minutes: 999 } }), 360);
    assert.equal(resolveVideoGenerationTimeoutMinutes({ video: { generation_timeout_minutes: 120 } }), 120);
  });

  it('keeps an absolute deadline across application restarts', () => {
    const createdAtMs = Date.parse('2026-07-18T00:00:00.000Z');
    const cfg = { video: { generation_timeout_minutes: 360 } };
    const afterFiveHours = resolveVideoGenerationLifetime(
      new Date(createdAtMs).toISOString(),
      cfg,
      createdAtMs + 5 * 60 * 60 * 1000
    );
    assert.equal(afterFiveHours.expired, false);
    assert.equal(afterFiveHours.remainingMs, 60 * 60 * 1000);

    const afterRestartPastDeadline = resolveVideoGenerationLifetime(
      new Date(createdAtMs).toISOString(),
      cfg,
      createdAtMs + 6 * 60 * 60 * 1000 + 1
    );
    assert.equal(afterRestartPastDeadline.expired, true);
    assert.equal(afterRestartPastDeadline.remainingMs, 0);
    assert.equal(afterRestartPastDeadline.deadlineMs, createdAtMs + 6 * 60 * 60 * 1000);
  });
});
