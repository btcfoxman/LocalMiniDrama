const { it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sceneService = require('../src/services/sceneService');

it('saves extracted scenes with the correct SQL parameter values', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drama_id INTEGER,
        episode_id INTEGER,
        location TEXT,
        time TEXT,
        prompt TEXT,
        negative_prompt TEXT,
        image_url TEXT,
        local_path TEXT,
        ref_image TEXT,
        storyboard_count INTEGER,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
    `);
    const log = { info() {} };
    const scene = sceneService.createSceneForEpisode(db, log, 7, 12, {
      location: '客厅',
      time: '夜晚',
      prompt: '昏暗的客厅',
    });

    assert.ok(scene?.id);
    assert.deepEqual(
      db.prepare('SELECT drama_id, episode_id, location, time, prompt, negative_prompt, image_url, local_path, ref_image, storyboard_count, status FROM scenes WHERE id = ?').get(scene.id),
      {
        drama_id: 7,
        episode_id: 12,
        location: '客厅',
        time: '夜晚',
        prompt: '昏暗的客厅',
        negative_prompt: null,
        image_url: null,
        local_path: null,
        ref_image: null,
        storyboard_count: 1,
        status: 'pending',
      }
    );
  } finally {
    db.close();
  }
});
