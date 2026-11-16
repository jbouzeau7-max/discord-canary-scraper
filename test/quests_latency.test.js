'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/quests');

test('main utilise uniquement la source publique et retourne le code 1 si elle est vide', async () => {
  let publicCalls = 0;
  let exitCode = 0;
  const result = await main({
    fetchQuestRegions: async () => new Map(),
    fetchPublicQuests: async () => { publicCalls++; return []; },
    setExitCode: (code) => { exitCode = code; },
  });

  // Les assertions après await prouvent que main() retourne normalement au watcher.
  assert.equal(publicCalls, 1);
  assert.equal(exitCode, 1);
  assert.equal(result.reason, 'no-quests');
  assert.equal('fetchOfficialQuests' in require('../src/quests'), false);
});
