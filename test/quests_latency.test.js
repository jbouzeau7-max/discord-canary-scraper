'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/quests');

test('main utilise uniquement la source publique et retourne si elle est vide', async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  let publicCalls = 0;
  try {
    const result = await main({
      fetchQuestRegions: async () => new Map(),
      fetchPublicQuests: async () => { publicCalls++; return []; },
    });

    // Les assertions après await prouvent que main() retourne au watcher au lieu
    // d'arrêter le processus; le code de sortie non nul est conservé pour CI.
    assert.equal(publicCalls, 1);
    assert.equal(process.exitCode, 1);
    assert.equal(result.reason, 'no-quests');
    assert.equal('fetchOfficialQuests' in require('../src/quests'), false);
  } finally {
    process.exitCode = previousExitCode;
  }
});
