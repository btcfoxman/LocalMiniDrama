const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const taskService = require('../src/services/taskService');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT,
      task_id TEXT,
      provider_task_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

describe('taskService.failOrphanedAsyncTasksOnStartup', () => {
  it('marks pending and processing tasks as failed on startup', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-pending', 'background_extraction', 'pending', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-processing', 'background_extraction', 'processing', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 100, '', ?, ?, ?, ?)`
    ).run('task-done', 'background_extraction', 'completed', '42', now, now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });
    assert.equal(count, 2);

    const pending = taskService.getTask(db, 'task-pending');
    const processing = taskService.getTask(db, 'task-processing');
    const done = taskService.getTask(db, 'task-done');

    assert.equal(pending.status, 'failed');
    assert.equal(processing.status, 'failed');
    assert.equal(pending.error, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.equal(done.status, 'completed');
  });

  it('cancelTask marks active task as failed', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-active', 'background_extraction', 'processing', '42', now, now);

    const result = taskService.cancelTask(db, { info() {} }, 'task-active');
    assert.equal(result.ok, true);
    const task = taskService.getTask(db, 'task-active');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.USER_CANCEL_TASK_MSG);
  });

  it('keeps a video task with provider task id recoverable on startup', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, 'video_generation', 'processing', 10, '', '7', ?, ?)`
    ).run('video-task', now, now);
    db.prepare(
      `INSERT INTO video_generations (status, task_id, provider_task_id, created_at, updated_at)
       VALUES ('processing', ?, 'provider-123', ?, ?)`
    ).run('video-task', now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });
    assert.equal(count, 0);
    assert.equal(taskService.getTask(db, 'video-task').status, 'processing');
  });

  it('revives only a legacy restart failure and keeps user cancellation terminal', () => {
    const db = createTestDb();
    const old = new Date(Date.now() - 60_000).toISOString();
    const insert = db.prepare(
      `INSERT INTO async_tasks
       (id, type, status, progress, message, error, resource_id, created_at, updated_at, completed_at)
       VALUES (?, 'video_generation', 'failed', 0, '', ?, '7', ?, ?, ?)`
    );
    insert.run('restart-failed', taskService.ORPHAN_ASYNC_TASK_MSG, old, old, old);
    insert.run('user-cancelled', taskService.USER_CANCEL_TASK_MSG, old, old, old);

    assert.equal(taskService.resumeRecoverableVideoTask(db, 'restart-failed'), true);
    const resumed = taskService.getTask(db, 'restart-failed');
    assert.equal(resumed.status, 'processing');
    assert.equal(resumed.error, null);
    assert.equal(resumed.completed_at, null);

    assert.equal(taskService.resumeRecoverableVideoTask(db, 'user-cancelled'), false);
    assert.equal(taskService.getTask(db, 'user-cancelled').status, 'failed');
  });

  it('touches active tasks without reviving terminal tasks', () => {
    const db = createTestDb();
    const old = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES ('active-video', 'video_generation', 'pending', 0, '', '7', ?, ?)`
    ).run(old, old);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, error, resource_id, created_at, updated_at)
       VALUES ('failed-video', 'video_generation', 'failed', 0, '', 'failed', '7', ?, ?)`
    ).run(old, old);

    assert.equal(taskService.touchTask(db, 'active-video', '正在查询进度…'), true);
    const active = taskService.getTask(db, 'active-video');
    assert.equal(active.status, 'processing');
    assert.equal(active.message, '正在查询进度…');
    assert.notEqual(active.updated_at, old);

    assert.equal(taskService.touchTask(db, 'failed-video'), false);
    assert.equal(taskService.getTask(db, 'failed-video').status, 'failed');
  });
});
