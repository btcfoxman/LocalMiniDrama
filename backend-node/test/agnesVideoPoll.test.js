const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pickProxyVideoUrl } = require('../src/services/videoClient');

describe('pickProxyVideoUrl Agnes completed task', () => {
  it('reads MP4 from remixed_from_video_id when video_url is absent', () => {
    const data = {
      status: 'completed',
      progress: 100,
      remixed_from_video_id:
        'https://platform-outputs.agnes-ai.space/videos/agnes-video-v2.0/2026/06/15/video_7237611b.mp4',
      video_id: 'video_7237611b',
    };
    assert.equal(
      pickProxyVideoUrl(data),
      'https://platform-outputs.agnes-ai.space/videos/agnes-video-v2.0/2026/06/15/video_7237611b.mp4'
    );
  });
});
