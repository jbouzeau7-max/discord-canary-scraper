const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('smoke', () => {
  test('inferType classifies guild-like ids', () => {
    const { inferType } = require('../src/lib/infer_type');
    assert.equal(inferType('guild_features_v2'), 'guild');
    assert.equal(inferType('some_user_experiment'), 'user');
  });

  test('murmur3 returns unsigned 32-bit number', () => {
    const { murmur3 } = require('../src/lib/murmur3');
    const h = murmur3('test-key', 0);
    assert.equal(typeof h, 'number');
    assert.ok(h >= 0);
    assert.ok(h <= 0xffffffff);
  });

  test('notification_gate helpers', () => {
    const { hasMapDiff, canAdvanceNotificationState } = require('../src/lib/notification_gate');
    assert.equal(hasMapDiff({ added: { a: 1 } }), true);
    assert.equal(hasMapDiff({}), false);
    assert.equal(
      canAdvanceNotificationState({
        webhookConfigured: true,
        hasNormalDiff: false,
        hasExpDiff: false,
        normalNotifyOk: true,
        experimentNotifyOk: true,
      }),
      true,
    );
  });
});
