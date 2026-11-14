'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  configuredDiscordTokens,
  fetchOfficialQuests,
} = require('../src/quests');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

test('configuredDiscordTokens fusionne, parse et déduplique les secrets', () => {
  assert.deepEqual(configuredDiscordTokens({
    DISCORD_TOKEN: 'token-a',
    DISCORD_USER_TOKEN: ' token-b ',
    DISCORD_USER_TOKEN_1: 'token-a',
    DISCORD_USER_TOKEN_2: 'token-c',
    DISCORD_USER_TOKENS: '["token-d", "token-b"]',
  }), ['token-a', 'token-b', 'token-c', 'token-d']);
  assert.deepEqual(configuredDiscordTokens({ DISCORD_USER_TOKENS: 'x, y;z' }), ['x', 'y', 'z']);
  assert.deepEqual(configuredDiscordTokens({}), []);
});

test('fetchOfficialQuests passe au token suivant après 401 sans essayer le second host', async () => {
  const calls = [];
  const result = await fetchOfficialQuests(Promise.resolve(new Map()), {
    tokens: ['expired-token', 'valid-token'],
    fetchWithRetry: async (url, opts) => {
      calls.push({ url, token: opts.headers.Authorization });
      if (opts.headers.Authorization === 'expired-token') return response(401, { message: 'invalid token' });
      return response(200, [{ id: 'quest-1', messages: { quest_name: 'Quête rapide' } }]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, 'expired-token');
  assert.equal(calls[0].url, 'https://canary.discord.com/api/v10/quests/@me');
  assert.equal(calls[1].token, 'valid-token');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Quête rapide');
});

test('fetchOfficialQuests ne tente pas les autres tokens pour contourner un 429', async () => {
  let calls = 0;
  const result = await fetchOfficialQuests(Promise.resolve(new Map()), {
    tokens: ['token-a', 'token-b'],
    fetchWithRetry: async () => {
      calls++;
      return response(429, { retry_after: 1 });
    },
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 1);
});

test('main retourne au watcher sans tuer le processus quand aucune source ne fournit de quêtes', () => {
  const source = path.resolve(__dirname, '../src/quests.js');
  const script = `
    const { main } = require(${JSON.stringify(source)});
    main({
      fetchQuestRegions: async () => new Map(),
      fetchOfficialQuests: async () => [],
      fetchPublicQuests: async () => [],
      setExitCode: (code) => console.log('EXIT_CODE', code),
    }).then((result) => console.log('RESULT', JSON.stringify(result)));
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const stdout = child.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(stdout, /EXIT_CODE 1/);
  assert.match(stdout, /"reason":"no-quests"/);
});
