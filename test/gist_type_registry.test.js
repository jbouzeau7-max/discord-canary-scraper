'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
process.env.GIST_ROLLOUT_TEST_QUIET = '1';
const { loadTypeRegistry, saveTypeRegistry } = require('../src/gist_user_rollouts');

test('registre de types : ajout des types du build, jamais d effacement', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'reg-')), 'experiment_types.json');
  assert.deepEqual({ ...(await loadTypeRegistry(file)) }, {});
  const reg = await loadTypeRegistry(file);
  const defs = new Map([
    ['a', { type: 'user', title: 'A' }],
    ['b', { type: 'guild', title: 'b' }],
    ['c', { type: '', title: 'c' }],
  ]);
  assert.equal(await saveTypeRegistry(reg, defs, file), 2);
  const j = await fs.readJson(file);
  assert.equal(j.count, 2);
  assert.deepEqual(j.types.a, { type: 'user', title: 'A' });
  assert.equal(j.types.b.type, 'guild');
  // build suivant : 'a' a disparu du client → toujours au registre
  const reg2 = await loadTypeRegistry(file);
  await saveTypeRegistry(reg2, new Map([['d', { type: 'user', title: 'D' }]]), file);
  const j2 = await fs.readJson(file);
  assert.deepEqual(Object.keys(j2.types), ['a', 'b', 'd']);
});

test('registre de types : fichier corrompu → registre vide, pas d exception', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'reg-')), 'experiment_types.json');
  await fs.writeFile(file, '{not json');
  assert.deepEqual({ ...(await loadTypeRegistry(file)) }, {});
});
