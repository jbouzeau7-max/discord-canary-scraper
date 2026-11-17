'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs-extra');

const os = require('os');

// Répertoire temporaire isolé : ne JAMAIS toucher au vrai data/notify_dedupe.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-test-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;
// Petit délai injectable pour borner les tests de verrou sans attendre 8 s.
process.env.NOTIFY_DEDUPE_LOCK_WAIT_MS = '70';

async function freshModule() {
  await fs.ensureDir(DATA);
  if (await fs.pathExists(DEDUPE)) await fs.remove(DEDUPE);
  if (await fs.pathExists(DEDUPE + '.lock')) await fs.remove(DEDUPE + '.lock');
  const modPath = require.resolve('../src/lib/webhook_dedupe');
  delete require.cache[modPath];
  return require('../src/lib/webhook_dedupe');
}

test('claim → markPosted: wasPosted true, second claim blocked', async () => {
  const d = await freshModule();
  const fp = 'test:sent:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markPosted(fp);
  assert.equal(await d.wasPosted(fp), true);
  assert.equal(await d.claimPosted(fp), false, 'already sent must not re-claim');
});

test('claim → markFailed: immediately re-claimable, wasPosted false', async () => {
  const d = await freshModule();
  const fp = 'test:fail:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markFailed(fp, 'HTTP 400');
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true, 'failed must be re-claimable');
});

test('pending claim blocks concurrent claim until stale', async () => {
  const d = await freshModule();
  const fp = 'test:pending:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  assert.equal(await d.claimPosted(fp), false, 'pending must block');
  assert.equal(await d.wasPosted(fp), false, 'pending must NOT count as sent');
});

test('lock timeout: reservation fails closed without executing its critical function', async () => {
  const d = await freshModule();
  const lock = DEDUPE + '.lock';
  await fs.writeJson(lock, { pid: process.pid, token: 'owner-live', createdAt: Date.now() });
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(lock, old, old);

  const result = await d.claimState('test:locked-out');

  assert.equal(result, 'unavailable', 'timeout must be retryable, never claimed');
  assert.equal(await fs.pathExists(DEDUPE), false, 'the claim callback must not write dedupe state');
  assert.equal((await fs.readJson(lock)).token, 'owner-live', 'a live owner lock must not be removed');
});

test('an old legacy lock without owner metadata remains recoverable', async () => {
  const d = await freshModule();
  const lock = DEDUPE + '.lock';
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(lock, old, old);

  assert.equal(await d.claimState('test:legacy-stale-lock'), 'claimed');
  assert.equal(await fs.pathExists(lock), false, 'the stale legacy lock should be replaced and released');
});

test('two concurrent claims for the same ID produce exactly one claim', async () => {
  const d = await freshModule();
  const results = await Promise.all([
    d.claimState('test:race-same-id'),
    d.claimState('test:race-same-id'),
  ]);
  assert.equal(results.filter((result) => result === 'claimed').length, 1);
  assert.equal(results.filter((result) => result === 'pending').length, 1);
});

test('stale pending is re-claimable', async () => {
  const d = await freshModule();
  const fp = 'test:stale:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  const data = await fs.readJson(DEDUPE);
  data.fps[fp] = {
    ts: Date.now() - (d.CLAIM_STALE_MS + 1000),
    status: 'pending',
  };
  await fs.writeJson(DEDUPE, data);
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true, 'stale pending re-claimable');
});

test('failed reservation is not treated as sent', async () => {
  const d = await freshModule();
  const fp = 'test:notsent:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markFailed(fp, 'network');
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true);
  await d.markPosted(fp);
  assert.equal(await d.wasPosted(fp), true);
});

test('registre dedupe corrompu : claim indisponible et aucun state réinitialisé', async () => {
  const d = await freshModule();
  await fs.writeFile(DEDUPE, '{invalid json');
  assert.equal(await d.claimState('test:corrupt-state'), 'unavailable');
  assert.equal(await fs.readFile(DEDUPE, 'utf8'), '{invalid json');
});

test('échec de toutes les écritures atomiques : le claim reste indisponible', async () => {
  const d = await freshModule();
  const originalMove = fs.move;
  fs.move = async (from, to, options) => {
    if (String(from).includes('.tmp.')) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
    return originalMove.call(fs, from, to, options);
  };
  try {
    assert.equal(await d.claimState('test:write-failure'), 'unavailable');
    assert.equal(await fs.pathExists(DEDUPE), false, 'aucun registre partiel ne doit être supposé durable');
  } finally {
    fs.move = originalMove;
  }
});
