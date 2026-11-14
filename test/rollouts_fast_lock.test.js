'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queueCommit, runTracker } = require('../src/rollouts_fast');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('queueCommit : attend la fin du tracker actif avant de committer', async () => {
  const events = [];
  let releaseTracker;
  let trackerActive = false;
  const runStep = async () => {
    trackerActive = true;
    events.push('tracker-start');
    await new Promise((r) => {
      releaseTracker = r;
    });
    trackerActive = false;
    events.push('tracker-end');
    return 0;
  };
  const impl = async () => {
    events.push('commit-start');
    assert.equal(trackerActive, false, 'commit lancé pendant le tracker');
    await sleep(2);
    events.push('commit-end');
  };

  const trackerP = runTracker('guild', {
    runStep,
    git: true,
    commit: async () => {}, // annexe : pas de second commit ici
    awaitTail: true,
  });
  // Laisse le tracker entrer dans son étape critique.
  await sleep(5);
  assert.equal(trackerActive, true);
  const commitP = queueCommit(['data/x.json'], 'test', impl);
  await sleep(5);
  assert.deepEqual(events, ['tracker-start'], 'commit ne doit pas démarrer');

  releaseTracker();
  await Promise.all([commitP, trackerP]);
  assert.deepEqual(events, ['tracker-start', 'tracker-end', 'commit-start', 'commit-end']);
});

test('queueCommit : commits sérialisés', async () => {
  const events = [];
  const impl = async (_files, msg) => {
    events.push('start:' + msg);
    await sleep(10);
    events.push('end:' + msg);
  };
  await Promise.all([
    queueCommit([], 'a', impl),
    queueCommit([], 'b', impl),
    queueCommit([], 'c', impl),
  ]);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('queueCommit : une erreur du commit ne casse pas la chaîne', async () => {
  let calls = 0;
  await queueCommit([], 'boom', async () => {
    calls++;
    throw new Error('boom');
  });
  await queueCommit([], 'ok', async () => {
    calls++;
  });
  assert.equal(calls, 2);
});
