const test = require('node:test');
const assert = require('node:assert');
const { envNumber, sleep } = require('../src/lib/utils');
const { writeJsonAtomic } = require('../src/lib/atomic');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

test('envNumber: fallback sur vide / invalide / infini', () => {
  const k = 'DCS_TEST_ENV_NUM';
  delete process.env[k];
  assert.strictEqual(envNumber(k, 32), 32);
  for (const v of ['', '  ', 'abc', 'Infinity', 'NaN']) {
    process.env[k] = v;
    assert.strictEqual(envNumber(k, 32), 32, v);
  }
  process.env[k] = '0';
  assert.strictEqual(envNumber(k, 32), 0);
  process.env[k] = '7.9';
  assert.strictEqual(envNumber(k, 32, { int: true }), 7);
  process.env[k] = '-5';
  assert.strictEqual(envNumber(k, 32, { min: 1 }), 1);
  process.env[k] = '9999';
  assert.strictEqual(envNumber(k, 32, { max: 64 }), 64);
  delete process.env[k];
});

test('sleep: valeurs invalides ne bloquent pas', async () => {
  const t = Date.now();
  await sleep(NaN);
  await sleep(-10);
  assert.ok(Date.now() - t < 200);
});

test('writeJsonAtomic: écritures concurrentes du même fichier sans collision', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcs-atomic-'));
  const f = path.join(dir, 'x.json');
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, { i })));
  const v = await fs.readJson(f);
  assert.ok(typeof v.i === 'number');
  const left = (await fs.readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(left, []);
  await fs.remove(dir);
});
