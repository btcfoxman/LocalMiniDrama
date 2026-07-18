const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pollVideoTask } = require('../src/services/videoClient');

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

const pollConfig = {
  provider: 'openai',
  api_protocol: 'openai',
  base_url: 'https://video.example.test',
  query_endpoint: '/v1/videos/{taskId}',
  api_key: 'test-key',
};

describe('video provider polling lifecycle', () => {
  it('emits a heartbeat while the provider task is still processing', async () => {
    const originalFetch = global.fetch;
    let fetchCount = 0;
    let heartbeatCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'processing' }),
      };
    };

    try {
      const result = await pollVideoTask(
        null,
        silentLog,
        7,
        'provider-task',
        pollConfig,
        1,
        1,
        {
          deadlineMs: Date.now() + 10_000,
          timeoutError: 'expired',
          onHeartbeat: () => { heartbeatCount += 1; },
        }
      );
      assert.equal(result.error, 'expired');
      assert.equal(fetchCount, 1);
      assert.equal(heartbeatCount, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not query the provider after the absolute deadline', async () => {
    let heartbeatCount = 0;
    const result = await pollVideoTask(
      null,
      silentLog,
      7,
      'provider-task',
      pollConfig,
      10,
      1,
      {
        deadlineMs: Date.now() - 1,
        timeoutError: 'expired',
        onHeartbeat: () => { heartbeatCount += 1; },
      }
    );
    assert.equal(result.error, 'expired');
    assert.equal(heartbeatCount, 0);
  });
});
