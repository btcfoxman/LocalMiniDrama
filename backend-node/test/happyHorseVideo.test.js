const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildHappyHorseVideoRequest } = require('../src/services/videoClient');

describe('buildHappyHorseVideoRequest', () => {
  it('builds an official HappyHorse text-to-video request', () => {
    const result = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.1-t2v',
      prompt: 'A horse runs across a meadow',
      resolution: '720p',
      aspect_ratio: '9:16',
      duration: 20,
      watermark: true,
      seed: 42.4,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.mode, 't2v');
    assert.deepEqual(result.body, {
      model: 'happyhorse-1.1-t2v',
      input: { prompt: 'A horse runs across a meadow' },
      parameters: {
        resolution: '720P',
        duration: 15,
        watermark: true,
        seed: 42,
        ratio: '9:16',
      },
    });
  });

  it('uses first_frame media for image-to-video and lets the image determine ratio', () => {
    const result = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.0-i2v',
      prompt: 'The camera slowly pushes in',
      first_frame_url: 'https://cdn.example.com/first.png',
      aspect_ratio: '21:9',
      duration: 1,
    });

    assert.equal(result.mode, 'i2v');
    assert.deepEqual(result.body.input.media, [
      { type: 'first_frame', url: 'https://cdn.example.com/first.png' },
    ]);
    assert.equal(result.body.parameters.resolution, '1080P');
    assert.equal(result.body.parameters.duration, 3);
    assert.equal(result.body.parameters.watermark, false);
    assert.equal(result.body.parameters.ratio, undefined);
  });

  it('builds reference media, limits it to nine images, and converts project image tokens', () => {
    const references = Array.from(
      { length: 10 },
      (_, index) => `https://cdn.example.com/reference-${index + 1}.jpg`
    );
    const result = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.1-r2v',
      prompt: '@图片1 runs toward @图片9',
      reference_urls: references,
      aspect_ratio: '4:5',
      duration: 8,
    });

    assert.equal(result.mode, 'r2v');
    assert.equal(result.body.input.prompt, '[Image 1] runs toward [Image 9]');
    assert.equal(result.body.input.media.length, 9);
    assert.ok(result.body.input.media.every((item) => item.type === 'reference_image'));
    assert.equal(result.body.parameters.ratio, '4:5');
  });

  it('rejects missing required images and unsupported video-edit models', () => {
    const i2v = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.1-i2v',
      prompt: 'Move',
    });
    const r2v = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.1-r2v',
      prompt: 'Move',
    });
    const edit = buildHappyHorseVideoRequest({
      model: 'happyhorse-1.0-video-edit',
      prompt: 'Edit',
    });

    assert.match(i2v.error, /HappyHorse|happyhorse/i);
    assert.match(r2v.error, /HappyHorse|happyhorse/i);
    assert.match(edit.error, /HappyHorse|happyhorse/i);
  });
});
