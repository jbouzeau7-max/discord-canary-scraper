'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupemany-'));
const FILE = path.join(DATA, 'dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = FILE;

const dedupe = require('../src/lib/webhook_dedupe');

function reset() {
  fs.removeSync(FILE);
}

function countWrites(fn) {
  const real = fs.writeJson.bind(fs);
  let n = 0;
  fs.writeJson = (...args) => {
    n++;
    return real(...args);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      fs.writeJson = real;
    })
    .then(() => n);
}

test('claimMany : toutes réclamées en une seule écriture', async () => {
  reset();
  const keys = ['a', 'b', 'c', 'a', 'b'];
  let map;
  const writes = await countWrites(async () => {
    map = await dedupe.claimMany(keys);
  });
  assert.equal(map.size, 3);
  assert.deepEqual([...map.values()], ['claimed', 'claimed', 'claimed']);
  assert.equal(writes, 1);
  for (const k of ['a', 'b', 'c']) assert.equal(await dedupe.claimState(k), 'pending');
});

test('claimMany : sent conservé, pending conservé, failed réclamé', async () => {
  reset();
  await dedupe.markPostedMany(['sent1']);
  await dedupe.markFailed('failed1', 'boom');
  await dedupe.claimState('pending1');
  const map = await dedupe.claimMany(['sent1', 'failed1', 'pending1', 'new1']);
  assert.equal(map.get('sent1'), 'sent');
  assert.equal(map.get('failed1'), 'claimed');
  assert.equal(map.get('pending1'), 'pending');
  assert.equal(map.get('new1'), 'claimed');
});

test('claimMany : pending expiré (crash > 5 min) redevient réclamable', async () => {
  reset();
  await dedupe.claimState('old');
  const d = await fs.readJson(FILE);
  d.fps.old.ts = Date.now() - dedupe.CLAIM_STALE_MS - 1000;
  await fs.writeJson(FILE, d);
  const map = await dedupe.claimMany(['old']);
  assert.equal(map.get('old'), 'claimed');
});

test('claimMany : sent expiré (> 24 h) redevient réclamable', async () => {
  reset();
  await dedupe.markPostedMany(['ancient']);
  const d = await fs.readJson(FILE);
  d.fps.ancient.ts = Date.now() - dedupe.WINDOW_MS - 1000;
  await fs.writeJson(FILE, d);
  assert.equal((await dedupe.claimMany(['ancient'])).get('ancient'), 'claimed');
});

test('claimMany : liste vide / clés vides', async () => {
  reset();
  assert.equal((await dedupe.claimMany([])).size, 0);
  assert.equal((await dedupe.claimMany(null)).size, 0);
  const m = await dedupe.claimMany(['', null, 'x']);
  assert.deepEqual([...m.keys()], ['x']);
});

test('claimMany : fichier corrompu → fail-closed (unavailable, aucun envoi sûr)', async () => {
  reset();
  await fs.writeFile(FILE, '{oops');
  const m = await dedupe.claimMany(['k1', 'k2']);
  assert.equal(m.get('k1'), 'unavailable');
  assert.equal(m.get('k2'), 'unavailable');
  assert.equal(await fs.readFile(FILE, 'utf8'), '{oops');
});

test('markFailedMany : une écriture, statuts failed, re-réclamables', async () => {
  reset();
  await dedupe.claimMany(['f1', 'f2', 'f3']);
  const writes = await countWrites(async () => {
    await dedupe.markFailedMany([
      { key: 'f1', error: 'HTTP 500' },
      { key: 'f2', error: 'HTTP 502' },
    ]);
  });
  assert.equal(writes, 1);
  const d = await fs.readJson(FILE);
  assert.equal(d.fps.f1.status, 'failed');
  assert.equal(d.fps.f2.status, 'failed');
  assert.equal(d.fps.f3.status, 'pending');
  const map = await dedupe.claimMany(['f1', 'f2']);
  assert.equal(map.get('f1'), 'claimed');
  assert.equal(map.get('f2'), 'claimed');
});

test('markFailedMany : entrées invalides ignorées sans lever', async () => {
  reset();
  await dedupe.markFailedMany(null);
  await dedupe.markFailedMany([null, {}, { key: '' }]);
  assert.equal(fs.existsSync(FILE), false);
});
