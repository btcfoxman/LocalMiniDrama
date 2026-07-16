const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { _internals } = require('../src/services/videoMergeService');
const { getFfmpegPath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

function withStorageFile(relativePath, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-storage-'));
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'video');
  try {
    fn({ root, filePath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('maps /static project video URLs back to local storage files', () => {
  const relativePath = 'projects/0001_20260715_60后成长记/videos/vg_15.mp4';
  withStorageFile(relativePath, ({ root, filePath }) => {
    assert.equal(
      _internals.resolveStorageMediaPath(`/static/${relativePath}`, '', root),
      filePath
    );
  });
});

test('maps configured base URLs and URL-encoded paths to local storage files', () => {
  const relativePath = 'projects/测试/videos/episode.mp4';
  withStorageFile(relativePath, ({ root, filePath }) => {
    assert.equal(
      _internals.resolveStorageMediaPath(
        'http://127.0.0.1:5679/static/projects/%E6%B5%8B%E8%AF%95/videos/episode.mp4?cache=1',
        'http://127.0.0.1:5679/static',
        root
      ),
      filePath
    );
  });
});

test('rejects missing, remote, and storage-traversal media paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-storage-'));
  try {
    assert.equal(_internals.resolveStorageMediaPath('/static/missing.mp4', '', root), null);
    assert.equal(_internals.resolveStorageMediaPath('https://cdn.example.com/video.mp4', '', root), null);
    assert.equal(_internals.resolveStorageMediaPath('/static/../outside.mp4', '', root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FFmpeg concat output contains every input clip', { skip: !hasLocalFfmpeg() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-concat-'));
  const inputDir = path.join(root, '中文片段');
  fs.mkdirSync(inputDir, { recursive: true });
  const ffmpeg = getFfmpegPath();
  const inputs = ['red', 'green', 'blue'].map((color, index) => {
    const filePath = path.join(inputDir, `${index + 1}.mp4`);
    const generated = spawnSync(ffmpeg, [
      '-f', 'lavfi',
      '-i', `color=c=${color}:s=320x180:d=0.5:r=24`,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-y',
      filePath,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr?.slice(-500));
    return filePath;
  });
  const outputPath = path.join(root, 'merged.mp4');
  const log = { warn() {} };

  try {
    assert.equal(_internals.runFfmpegConcat(inputs, outputPath, log), true);
    assert.ok(fs.statSync(outputPath).size > 0);

    const inspected = spawnSync(ffmpeg, ['-i', outputPath, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr?.slice(-500));
    const durationMatch = inspected.stderr.match(/Duration:\s+\d{2}:\d{2}:(\d+(?:\.\d+)?)/);
    assert.ok(durationMatch, 'FFmpeg did not report the merged duration');
    assert.ok(Number(durationMatch[1]) >= 1.4, `merged duration was ${durationMatch[1]} seconds`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
