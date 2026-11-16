'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { main } = require('../src/quests');

test('main utilise uniquement la source publique et garde le watcher vivant si elle est vide', async () => {
  let publicCalls = 0;
  let exitCode = 0;
  const result = await main({
    fetchQuestRegions: async () => new Map(),
    fetchPublicQuests: async () => { publicCalls++; return []; },
    setExitCode: (code) => { exitCode = code; },
  });
  assert.equal(publicCalls, 1);
  assert.equal(exitCode, 1);
  assert.equal(result.reason, 'no-quests');
  assert.equal('fetchOfficialQuests' in require('../src/quests'), false);
});

test('aucune quête publique ne termine sans tuer le processus du watcher', () => {
  const source = path.resolve(__dirname, '../src/quests.js');
  const script = `
    const { main } = require(${JSON.stringify(source)});
    main({
      fetchQuestRegions: async () => new Map(),
      fetchPublicQuests: async () => [],
      setExitCode: (code) => console.log('EXIT_CODE', code),
    }).then((result) => console.log('RESULT', JSON.stringify(result)));
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const output = child.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(output, /EXIT_CODE 1/);
  assert.match(output, /"reason":"no-quests"/);
});
