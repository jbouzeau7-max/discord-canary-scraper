'use strict';
/**
 * Régressions : reprise après un run interrompu.
 *
 * saveState() écrit une génération complète dans data/.state_staging/<runId>/
 * puis la promeut. Un crash entre les deux laissait le dossier pour toujours
 * (fichiers JSON non suivis dans data/). La purge ne doit toucher QUE les
 * générations abandonnées : jamais celle du run courant ni celle d'un autre
 * process encore actif (mtime récent).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { saveState, pruneStaleStaging } = require('../src/lib/state');

async function makeDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-resume-'));
  return dir;
}

const BASE_STATE = {
  build: { buildNumber: '690123', versionHash: 'abc', assets: ['a'], cssAssets: [] },
  experiments: [{ id: 'e1', type: 'user', variations: { 1: {} } }],
  strings: { S1: 'x' },
  routes: { '/a': 'A' },
};

test('pruneStaleStaging : purge les vieilles générations, garde le run courant', async () => {
  const dataDir = await makeDataDir();
  const root = path.join(dataDir, '.state_staging');
  const old = path.join(root, 'old-run');
  const fresh = path.join(root, 'other-process');
  await fs.outputJson(path.join(old, 'build.json'), { stale: true });
  await fs.outputJson(path.join(fresh, 'build.json'), { inFlight: true });
  const past = Date.now() - 48 * 3600 * 1000;
  await fs.utimes(old, new Date(past), new Date(past));

  const removed = await pruneStaleStaging(root, { keep: 'current-run' });
  assert.deepEqual(removed, ['old-run']);
  assert.equal(await fs.pathExists(old), false);
  assert.equal(await fs.pathExists(fresh), true, 'un staging récent peut être en cours');
  await fs.remove(dataDir);
});

test('pruneStaleStaging : racine absente ou fichier parasite → aucune exception', async () => {
  const dataDir = await makeDataDir();
  assert.deepEqual(await pruneStaleStaging(path.join(dataDir, 'nope')), []);
  const root = path.join(dataDir, 'staging');
  await fs.outputFile(path.join(root, 'file-not-dir'), 'x');
  const past = Date.now() - 48 * 3600 * 1000;
  await fs.utimes(path.join(root, 'file-not-dir'), new Date(past), new Date(past));
  assert.deepEqual(await pruneStaleStaging(root), []);
  assert.equal(await fs.pathExists(path.join(root, 'file-not-dir')), true);
  await fs.remove(dataDir);
});

test('saveState : laisse data/ propre et purge une génération abandonnée', async () => {
  const dataDir = await makeDataDir();
  const root = path.join(dataDir, '.state_staging');
  const abandoned = path.join(root, 'crash-2026');
  await fs.outputJson(path.join(abandoned, 'build.json'), { partial: true });
  const past = Date.now() - 48 * 3600 * 1000;
  await fs.utimes(abandoned, new Date(past), new Date(past));

  const { runId } = await saveState(dataDir, BASE_STATE);
  assert.ok(runId);
  assert.deepEqual(await fs.readJson(path.join(dataDir, 'build.json')).then((d) => d.buildNumber), '690123');
  assert.equal(await fs.pathExists(path.join(root, runId)), false, 'staging du run courant supprimé');
  assert.equal(await fs.pathExists(abandoned), false, 'génération abandonnée purgée');
  await fs.remove(dataDir);
});

test('saveState : refuse un buildNumber manquant sans laisser de staging', async () => {
  const dataDir = await makeDataDir();
  await assert.rejects(() => saveState(dataDir, { build: {}, experiments: [] }), /missing or unknown buildNumber/);
  const root = path.join(dataDir, '.state_staging');
  assert.equal(await fs.pathExists(root), false);
  await fs.remove(dataDir);
});
