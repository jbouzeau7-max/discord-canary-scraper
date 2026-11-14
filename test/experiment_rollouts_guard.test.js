'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGuildExperiment,
  fallbackGuildRollouts,
} = require('../src/experiment_rollouts');

test('parseGuildExperiment : tuple standard, plages half-open exactes', () => {
  const ge = [
    123456,
    '2025-01_test',
    7,
    [
      [
        [
          [0, [[0, 2500]]],
          [1, [[2500, 5000]]],
        ],
        [],
      ],
    ],
  ];
  const p = parseGuildExperiment(ge);
  assert.equal(p.hash, 123456);
  assert.equal(p.name, '2025-01_test');
  assert.equal(p.percentage, 25, 'seul le bucket > 0 (treatment) compte');
  assert.equal(p.status, 'partial');
  assert.deepEqual(p.treatmentRanges, [[2500, 5000]]);
});

test('parseGuildExperiment : 0 % et 100 % classés correctement', () => {
  const none = parseGuildExperiment([1, 'e', 1, [[[[0, [[0, 5000]]]], []]]]);
  assert.equal(none.percentage, 0);
  assert.equal(none.status, 'not_started');
  const full = parseGuildExperiment([2, 'f', 1, [[[[1, [[0, 10000]]]], []]]]);
  assert.equal(full.percentage, 100);
  assert.equal(full.status, 'full_rollout');
});

test('parseGuildExperiment : plages qui se chevauchent comptées une seule fois', () => {
  const p = parseGuildExperiment([
    3,
    'g',
    1,
    [[[[1, [[0, 5000], [2500, 5000]]]], []]],
  ]);
  assert.equal(p.percentage, 50);
});

test('parseGuildExperiment : hash textuel converti en nombre', () => {
  const p = parseGuildExperiment([ '42', 'h', 1, [[[[1, [[0, 1000]]]], []]] ]);
  assert.equal(p.hash, 42);
  assert.equal(p.percentage, 10);
});

test('parseGuildExperiment : tuples invalides → null sans lever', () => {
  assert.equal(parseGuildExperiment(null), null);
  assert.equal(parseGuildExperiment([]), null);
  assert.equal(parseGuildExperiment([1, 2, 3]), null);
  assert.equal(parseGuildExperiment([1, 'x', 1, 'not-an-array']).percentage, 0);
  const weird = parseGuildExperiment([1, 'x', 1, [[null, 'x'], [42]]]);
  assert.equal(weird.percentage, 0);
});

test('parseGuildExperiment : plages inversées ou nulles ignorées', () => {
  const p = parseGuildExperiment([1, 'x', 1, [[[[1, [[5000, 5000], [6000, 5000], [0, 1000]]]], []]]]);
  assert.deepEqual(p.treatmentRanges, [[0, 1000]]);
});

test('fallbackGuildRollouts : fresh non vide gagne, jamais stale', () => {
  const r = fallbackGuildRollouts({ guildExperiments: [{ id: 'old' }] }, [{ id: 'new' }]);
  assert.deepEqual(r, { list: [{ id: 'new' }], stale: false });
});

test('fallbackGuildRollouts : panne API conserve les données précédentes', () => {
  const r = fallbackGuildRollouts({ guildExperiments: [{ id: 'old' }] }, []);
  assert.deepEqual(r, { list: [{ id: 'old' }], stale: true });
});

test('fallbackGuildRollouts : premier run sans données → vide non stale', () => {
  assert.deepEqual(fallbackGuildRollouts(null, []), { list: [], stale: false });
  assert.deepEqual(fallbackGuildRollouts({ guildExperiments: [] }, []), { list: [], stale: false });
});

test('fallbackGuildRollouts : entrées invalides filtrées des deux côtés', () => {
  const r = fallbackGuildRollouts({ guildExperiments: [null, { id: '' }, { id: 'ok' }] }, [null, {}]);
  assert.deepEqual(r, { list: [{ id: 'ok' }], stale: true });
});
