const test = require('node:test');
const assert = require('node:assert');
const { watch } = require('../src/quests');

test('quests watch: une seule passe par défaut (watchMs=0)', async () => {
  let calls = 0;
  const r = await watch({ watchMs: 0, main: async () => { calls++; }, sleep: async () => {} });
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.passes, 1);
});

test('quests watch: enchaîne les passes jusqu\'à la deadline', async () => {
  let t = 0;
  let calls = 0;
  const r = await watch({
    watchMs: 120000,
    pollMs: 30000,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    main: async () => { calls++; t += 1000; },
  });
  assert.ok(calls >= 4 && calls <= 5, 'calls=' + calls);
  assert.strictEqual(r.passes, calls);
  process.exitCode = 0;
});

test('quests watch: conserve le pire exitCode et survit à une exception', async () => {
  let t = 0;
  let n = 0;
  const r = await watch({
    watchMs: 60000,
    pollMs: 30000,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    main: async () => {
      n++;
      t += 100;
      if (n === 1) process.exitCode = 2;
      if (n === 2) throw new Error('boom');
    },
  });
  assert.ok(r.passes >= 2);
  assert.strictEqual(r.exitCode, 2);
  process.exitCode = 0;
});

test('quests watch: enchaîne immédiatement le lot suivant si des quêtes restent à envoyer', async () => {
  let t = 0;
  let calls = 0;
  let sleeps = 0;
  const r = await watch({
    watchMs: 30000,
    pollMs: 30000,
    now: () => t,
    sleep: async (ms) => { sleeps++; t += ms; },
    main: async () => {
      calls++;
      t += 10;
      return calls === 1
        ? { unsent: 3, sentFail: 0 }
        : { unsent: 0, sentFail: 0 };
    },
  });
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(r.passes, 2);
  process.exitCode = 0;
});
