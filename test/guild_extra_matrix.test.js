'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeFilters, fallbackGuildRollouts } = require('../src/experiment_rollouts');

test('describeFilters : restitue les filtres de feature, de membres et de plage d’ID', () => {
  const filters = [
    [1604612045, [[12, 'guild_discovery'], [13, 7], 'legacy-feature']],
    [2404720969, [10, 100]],
    [2918402255, { min: 1000, max: 2000 }],
    [987654321, null],
    ['invalide'],
  ];

  assert.equal(
    describeFilters(filters),
    'feature:guild_discovery,feature_13,legacy-feature; member_count:[10,100]; id_range:{"min":1000,"max":2000}; filter_987654321; filter_invalide',
  );
});

test('fallbackGuildRollouts : préserve par hash une baseline malformée sans identifiant local', () => {
  const previous = {
    guildExperiments: [
      { id: 'exp-ancienne', hash: 2468, percentage: 37.5, status: 'partial', treatmentRanges: [[100, 3850]] },
    ],
  };
  const freshMalformed = [
    { id: null, hash: 2468, name: 'exp-nouvelle', percentage: null, status: 'unknown', dataStatus: 'malformed' },
  ];

  const result = fallbackGuildRollouts(previous, freshMalformed);
  assert.equal(result.stale, false);
  assert.deepEqual(result.list, [
    {
      id: 'exp-ancienne',
      hash: 2468,
      percentage: 37.5,
      status: 'partial',
      treatmentRanges: [[100, 3850]],
      name: 'exp-nouvelle',
      dataStatus: 'stale_preserved',
      currentDataStatus: 'malformed',
      stale: true,
    },
  ]);
});
