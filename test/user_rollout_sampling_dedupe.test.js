'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordAssignments, sampleFingerprints, sampleRecord, pruneWindow } = require('../src/user_rollouts');

const NOW = 1_800_000_000_000;
const assignment = (hash, bucket, pos, revision = 1) => [hash, revision, bucket, -1, 1, pos, 0, 0, null, null, null];
const response = (fingerprint, assignments) => ({ fingerprint, assignments });
const deps = (responses, calls = []) => ({
  fetchAssignments: async (headers) => {
    calls.push(headers);
    if (!responses.length) throw new Error('unexpected request');
    return responses.shift();
  },
  sleep: async () => {},
  random: () => 0,
  now: () => NOW,
});

test('recordAssignments : une ligne au bucket invalide ne bloque pas le doublon valide suivant', () => {
  const byHash = new Map();
  const byRev = new Map();
  const count = recordAssignments(byHash, byRev, [
    [77, 1, 1.5, -1, 1, 100, 0, 0, null, null, null],
    assignment(77, 2, 500, 2),
  ]);
  assert.equal(count, 1);
  assert.deepEqual([...byHash.get(77).keys()], [2]);
  assert.deepEqual(byHash.get(77).get(2), [500]);
  assert.equal(byRev.get(77), 2);
});

test('recordAssignments : une position hors échelle ne réserve pas le hash', () => {
  const byHash = new Map();
  const byRev = new Map();
  const count = recordAssignments(byHash, byRev, [
    assignment(88, 1, 10000),
    assignment(88, 1, 9999),
  ]);
  assert.equal(count, 1);
  assert.deepEqual(byHash.get(88).get(1), [9999]);
});

test('sampleFingerprints : un fingerprint répété n’augmente ni k/n ni l’échantillon exact', async () => {
  const repeated = '12345678901234567.same';
  const fresh = '22345678901234567.new';
  const results = [
    response(repeated, [assignment(77, 1, 100)]),
    response(repeated, [assignment(77, 2, 200)]),
    response(fresh, [assignment(77, 2, 300)]),
  ];
  const sampled = await sampleFingerprints(3, 1, deps(results));
  assert.equal(sampled.ok, 2);
  assert.equal(sampled.fail, 0);
  assert.equal(sampled.duplicates, 1);
  assert.equal(sampled.samples.length, 2);
  assert.deepEqual(sampled.byHash.get(77).get(1), [100]);
  assert.deepEqual(sampled.byHash.get(77).get(2), [300]);
});

test('sampleFingerprints : fingerprints distincts restent tous comptés en concurrence', async () => {
  const results = [
    response('32345678901234567.a', [assignment(99, 1, 123)]),
    response('42345678901234567.b', [assignment(99, 2, 456)]),
  ];
  const sampled = await sampleFingerprints(2, 2, deps(results));
  assert.equal(sampled.ok, 2);
  assert.equal(sampled.duplicates, 0);
  assert.equal(sampled.samples.length, 2);
  assert.deepEqual(sampled.byHash.get(99).get(1), [123]);
  assert.deepEqual(sampled.byHash.get(99).get(2), [456]);
});

test('sampleRecord : hash non uint32 et positions invalides ignorés avant déduplication', () => {
  const record = sampleRecord('52345678901234567.test', [
    assignment(4294967296, 1, 100),
    assignment(77, 1, 10000),
    assignment(77, 2, 200),
    assignment(77, 3, 300),
  ], NOW);
  assert.deepEqual(record.a, { '77': [2, 200] });
});

test('pruneWindow : fingerprint historique dupliqué garde la dernière observation', () => {
  const fingerprint = '62345678901234567';
  const window = pruneWindow({
    batches: [],
    samples: [
      { f: fingerprint, t: NOW - 100, a: { '77': [1, 100] } },
      { f: '72345678901234567', t: NOW - 25, a: {} },
      { f: fingerprint, t: NOW - 50, a: { '77': [2, 200] } },
    ],
  }, NOW);
  assert.equal(window.samples.length, 2);
  assert.deepEqual(window.samples[0], { f: fingerprint, t: NOW - 50, a: { '77': [2, 200] } });
  assert.equal(window.samples[1].f, '72345678901234567');
});

test('pruneWindow : valeurs expirées ou malformées retirées, ordre chronologique rétabli', () => {
  const window = pruneWindow({
    batches: [],
    samples: [
      { f: '82345678901234567', t: NOW - 100, a: {} },
      { f: 'invalid', t: NOW - 50, a: {} },
      { f: '92345678901234567', t: NOW - 5 * 3600 * 1000, a: {} },
      { f: '10345678901234567', t: NOW - 25, a: [] },
      { f: '92345678901234567', t: NOW - 10, a: {} },
    ],
  }, NOW);
  assert.deepEqual(window.samples.map((sample) => sample.f), ['82345678901234567', '92345678901234567']);
});

test('sampleFingerprints : cible zéro ne déclenche aucune requête', async () => {
  const sampled = await sampleFingerprints(0, 1, {
    fetchAssignments: async () => { throw new Error('must not call'); },
    sleep: async () => {},
    random: () => 0,
    now: () => NOW,
  });
  assert.equal(sampled.ok, 0);
  assert.equal(sampled.fail, 0);
  assert.equal(sampled.duplicates, 0);
  assert.equal(sampled.samples.length, 0);
  assert.equal(sampled.byHash.size, 0);
});
