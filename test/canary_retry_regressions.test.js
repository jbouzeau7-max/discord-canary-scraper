'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitExpectedBuild } = require('../src/lib/expected_build');

// Horloge virtuelle : tests reproductibles, aucun appel au CDN.
function clock(t) {
  let ms = 1000;
  t.mock.method(Date, 'now', () => ms);
  t.mock.method(global, 'setTimeout', (fn, delay) => { ms += delay; queueMicrotask(fn); });
}

test('Canary: un edge en retard ne remplace pas le meilleur build vu', async (t) => {
  clock(t);
  const best = { buildNumber: '103' };
  let calls = 0;
  const result = await awaitExpectedBuild({ buildNumber: '100' }, '104', {
    delayMs: 5, maxWaitMs: 15, fetchBuild: async () => (++calls === 1 ? best : { buildNumber: '99' }),
  });
  assert.equal(result, best);
});

test('Canary: une réponse vide est réessayée avec pause, sans dépasser le budget', async (t) => {
  clock(t);
  const times = [];
  const result = await awaitExpectedBuild(null, '104', {
    delayMs: 5, maxWaitMs: 12, fetchBuild: async () => {
      times.push(Date.now());
      return times.length < 4 ? null : { buildNumber: '104' };
    },
  });
  assert.deepEqual(times, [1000, 1005, 1010]);
  assert.equal(result, null);
});
