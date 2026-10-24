import test from 'node:test'
import assert from 'node:assert/strict'
import { retrySavedImage } from '../src/utils/imageCacheRetry.js'

test('cache retry uses the saved result and never creates another generation', async () => {
  const calls = []
  const api = {
    async list(scope) { calls.push(['list', scope]); return { items: [{ id: 103, error_msg: '图片已生成，但本地缓存失败', image_url: 'https://temporary.test/result' }] } },
    async retryCache(id) { calls.push(['retryCache', id]); return { id, local_path: 'images/saved.png' } },
    create() { throw new Error('Must not generate again') },
  }
  assert.equal((await retrySavedImage(api, { character_id: 7 })).id, 103)
  assert.deepEqual(calls, [['list', { character_id: 7, status: 'failed', page_size: 100 }], ['retryCache', 103]])
})

test('a result already restored at startup can be applied without generating again', async () => {
  const api = {
    async list(scope) { return { items: scope.status === 'completed' ? [{ id: 103, local_path: 'images/saved.png' }] : [] } },
    async retryCache(id) { return { id, local_path: 'images/saved.png' } },
  }
  assert.equal((await retrySavedImage(api, { scene_id: 8 })).id, 103)
})
