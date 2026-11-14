'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  loadKnownIds,
  markBuild,
  wasBuildAnnounced,
} = require('../src/index');

async function tmpFile(name = 'state.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idxstate-'));
  return path.join(dir, name);
}

test('loadKnownIds : ids valides chargés et dédupliqués', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { ids: ['a', 'b', 'a', 3] });
  const s = await loadKnownIds(f, false);
  assert.deepEqual([...s].sort(), ['3', 'a', 'b']);
});

test('loadKnownIds : clé "keys" legacy supportée', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { keys: ['x', 'y'] });
  assert.deepEqual([...await loadKnownIds(f, false)].sort(), ['x', 'y']);
});

test('loadKnownIds : ids en chaîne/objet ignorés', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { ids: 'abcdef' });
  assert.equal((await loadKnownIds(f, false)).size, 0);
  await fs.writeJson(f, { ids: { a: 1 } });
  assert.equal((await loadKnownIds(f, false)).size, 0);
});

test('loadKnownIds : entrées vides retirées', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { ids: ['', '  ', null, 'ok'] });
  assert.deepEqual([...await loadKnownIds(f, false)], ['ok']);
});

test('markBuild : builds corrompu (chaîne) ne lève pas et réinitialise', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { builds: 'oops' });
  await markBuild('671591', f);
  const d = await fs.readJson(f);
  assert.deepEqual(d.builds, ['671591']);
});

test('markBuild : ajoute sans doublon et conserve les précédents', async () => {
  const f = await tmpFile();
  await fs.writeJson(f, { builds: ['1', '2'] });
  await markBuild('3', f);
  await markBuild('3', f);
  const d = await fs.readJson(f);
  assert.deepEqual(d.builds, ['1', '2', '3']);
});

test('markBuild : fichier absent créé', async () => {
  const f = await tmpFile('new.json');
  await markBuild('42', f);
  assert.equal(await wasBuildAnnounced('42', f), true);
});

test('wasBuildAnnounced : fichier absent/corrompu → false', async () => {
  const f = await tmpFile();
  assert.equal(await wasBuildAnnounced('1', f), false);
  await fs.writeFile(f, '{oops');
  assert.equal(await wasBuildAnnounced('1', f), false);
  await fs.writeJson(f, { builds: { nope: true } });
  assert.equal(await wasBuildAnnounced('1', f), false);
});
