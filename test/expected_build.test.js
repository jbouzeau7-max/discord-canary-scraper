'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitExpectedBuild } = require('../src/lib/expected_build');

test('awaitExpectedBuild: sans EXPECTED_BUILD → inchangé', async () => {
  const b = { buildNumber: '10' };
  assert.equal(await awaitExpectedBuild(b, ''), b);
  assert.equal(await awaitExpectedBuild(b, undefined), b);
});

test('awaitExpectedBuild: edge en retard → re-fetch jusqu au build attendu', async () => {
  let n = 0;
  const fetchBuild = async () => ({ buildNumber: String(10 + ++n) });
  const out = await awaitExpectedBuild({ buildNumber: '10' }, '12', { fetchBuild, delayMs: 1 });
  assert.equal(out.buildNumber, '12');
  assert.equal(n, 2);
});

test('awaitExpectedBuild: délai max respecté, garde le dernier build', async () => {
  const fetchBuild = async () => ({ buildNumber: '10' });
  const t = Date.now();
  const out = await awaitExpectedBuild({ buildNumber: '10' }, '99', { fetchBuild, delayMs: 5, maxWaitMs: 40 });
  assert.equal(out.buildNumber, '10');
  assert.ok(Date.now() - t < 1000);
});

test('awaitExpectedBuild: erreur de fetch tolérée', async () => {
  const fetchBuild = async () => { throw new Error('boom'); };
  const out = await awaitExpectedBuild({ buildNumber: '5' }, '6', { fetchBuild, delayMs: 1, maxWaitMs: 20 });
  assert.equal(out.buildNumber, '5');
});

test('awaitExpectedBuild: sans build initial, fetch immédiat', async () => {
  const out = await awaitExpectedBuild(null, '7', { fetchBuild: async () => ({ buildNumber: '7' }), delayMs: 1000 });
  assert.equal(out.buildNumber, '7');
});
