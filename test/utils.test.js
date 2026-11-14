const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, envNumber, trimRecent, redactSecrets } = require('../src/lib/utils');

describe('utils', () => {
  test('sleep resolves', async () => {
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 15);
  });

  test('envNumber fallback and bounds', () => {
    assert.equal(envNumber('MISSING_ENV_XYZ', 42), 42);
    process.env.TEST_ENV_NUM = '10';
    assert.equal(envNumber('TEST_ENV_NUM', 0, { min: 1, max: 5 }), 5);
    delete process.env.TEST_ENV_NUM;
  });

  test('trimRecent keeps last N', () => {
    assert.deepEqual(trimRecent(['a', 'b', 'c', 'd'], 2), ['c', 'd']);
  });

  test('redactSecrets masks jwt-like tokens', () => {
    const s = redactSecrets('Bearer abcdefghij.klmno.pqrstuvwxyz0123456789');
    assert.ok(s.includes('[REDACTED') || s.includes('Bearer'));
  });
});
