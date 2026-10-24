const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadRanklandConfig, RANKLAND_PRODUCTION_API_BASE } = require('./rankland-config');

test('development requests use the dedicated v2 configuration', () => {
  const config = loadRanklandConfig(true, (name) => {
    assert.equal(name, './configs/rl-v2.dev');
    return { apiBase: 'http://localhost:5000/api/v2', authToken: 'test-token' };
  });
  assert.equal(config.apiBase, 'http://localhost:5000/api/v2');
  assert.equal(config.authToken, 'test-token');
});

test('production requests use the v2 API base and configured token', () => {
  const config = loadRanklandConfig(false, (name) => {
    assert.equal(name, './configs/rl-v2.prod');
    return { apiBase: 'https://example.invalid/api', authToken: 'test-token' };
  });
  assert.equal(config.apiBase, RANKLAND_PRODUCTION_API_BASE);
  assert.equal(config.apiBase, 'https://rl.algoux.cn/api/v2');
  assert.equal(config.authToken, 'test-token');
});

test('missing v2 config fails without falling back to legacy config', () => {
  const paths = [];
  assert.throws(() => loadRanklandConfig(true, (name) => {
    paths.push(name);
    throw new Error('missing fixture');
  }), /Failed to load Rankland config .\/configs\/rl-v2.dev: missing fixture/);
  assert.deepEqual(paths, ['./configs/rl-v2.dev']);
});
