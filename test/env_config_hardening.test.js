'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VARS = [
  'USER_ROLLOUT_SAMPLES',
  'USER_ROLLOUT_CONCURRENCY',
  'USER_ROLLOUT_DELAY_MS',
  'APEX_MIN_PCT_DELTA',
  'USER_ROLLOUT_MIN_OK',
  'USER_ROLLOUT_MAX_MS',
  'USER_ROLLOUT_NOISE_Z',
  'USER_ROLLOUT_WINDOW_H',
  'USER_ROLLOUT_WINDOW_BATCHES',
  'USER_ROLLOUT_SAMPLE_CAP',
  'GIST_ROLLOUT_MIN_PCT_DELTA',
  'GIST_ROLLOUT_STALE_H',
  'MAX_CHUNK_SCAN_BYTES',
];

function withEnv(env, fn) {
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  const load = (rel) => {
    const p = require.resolve(path.join(ROOT, rel));
    delete require.cache[p];
    return require(p);
  };
  try {
    return fn(load);
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('user_rollouts : env absentes → valeurs par défaut', () => {
  withEnv({}, (load) => {
    const c = load('src/user_rollouts.js').config;
    assert.equal(c.SAMPLES, 150);
    assert.equal(c.CONC, 2);
    assert.equal(c.DELAY_MS, 300);
    assert.equal(c.MIN_DELTA, 1);
    assert.equal(c.MIN_OK, 25);
    assert.equal(c.MAX_MS, 90000);
    assert.equal(c.NOISE_Z, 2);
    assert.equal(c.WINDOW_H, 4);
    assert.equal(c.MAX_BATCHES, 60);
    assert.equal(c.SAMPLE_CAP, 4000);
  });
});

test('user_rollouts : env aberrantes ("abc") → défauts, jamais NaN', () => {
  withEnv(
    {
      USER_ROLLOUT_SAMPLES: 'abc',
      USER_ROLLOUT_CONCURRENCY: 'NaN',
      USER_ROLLOUT_DELAY_MS: '',
      APEX_MIN_PCT_DELTA: 'x',
      USER_ROLLOUT_MIN_OK: ' ',
      USER_ROLLOUT_MAX_MS: 'Infinity',
      USER_ROLLOUT_NOISE_Z: 'zz',
      USER_ROLLOUT_WINDOW_H: 'no',
      USER_ROLLOUT_WINDOW_BATCHES: '?',
      USER_ROLLOUT_SAMPLE_CAP: 'null',
    },
    (load) => {
      const c = load('src/user_rollouts.js').config;
      for (const [k, v] of Object.entries(c)) {
        assert.ok(Number.isFinite(v), `${k} doit être fini (${v})`);
      }
      assert.equal(c.SAMPLES, 150);
      assert.equal(c.CONC, 2);
      assert.equal(c.NOISE_Z, 2);
    },
  );
});

test('user_rollouts : env valides et bornes respectées', () => {
  withEnv(
    {
      USER_ROLLOUT_SAMPLES: '9999',
      USER_ROLLOUT_CONCURRENCY: '0',
      USER_ROLLOUT_DELAY_MS: '1',
      APEX_MIN_PCT_DELTA: '-3',
      USER_ROLLOUT_NOISE_Z: '0',
      USER_ROLLOUT_WINDOW_BATCHES: '2',
    },
    (load) => {
      const c = load('src/user_rollouts.js').config;
      assert.equal(c.SAMPLES, 400);
      assert.equal(c.CONC, 1);
      assert.equal(c.DELAY_MS, 80);
      assert.equal(c.MIN_DELTA, 0);
      assert.equal(c.NOISE_Z, 0);
      assert.equal(c.MAX_BATCHES, 5);
    },
  );
});

test('gist_user_rollouts : env aberrantes → défauts', () => {
  withEnv({ GIST_ROLLOUT_MIN_PCT_DELTA: 'abc', GIST_ROLLOUT_STALE_H: 'NaN' }, (load) => {
    const c = load('src/gist_user_rollouts.js').config;
    assert.equal(c.MIN_DELTA_PCT, 0.05);
    assert.equal(c.STALE_H, 72);
  });
});

test('gist_user_rollouts : env valides conservées', () => {
  withEnv({ GIST_ROLLOUT_MIN_PCT_DELTA: '0.5', GIST_ROLLOUT_STALE_H: '12' }, (load) => {
    const c = load('src/gist_user_rollouts.js').config;
    assert.equal(c.MIN_DELTA_PCT, 0.5);
    assert.equal(c.STALE_H, 12);
  });
});

test('extract : MAX_CHUNK_SCAN_BYTES aberrant → défaut', () => {
  withEnv({ MAX_CHUNK_SCAN_BYTES: 'abc' }, (load) => {
    assert.equal(load('src/lib/extract.js').MAX_CHUNK_SCAN_BYTES, 16_000_000);
  });
});
