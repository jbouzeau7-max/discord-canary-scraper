'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAudiencePercentage } = require('../src/lib/experiment_percentages');
const { buildEmbed } = require('../src/gist_user_rollouts');

test('an explicit percent sign takes precedence over field units', () => {
  for (const payload of [{ percentage: '0,5 %' }, { rate: '0.5%' }, { user: '0.5 %' }, { fraction: '0.5%', percent: '0.5%' }]) {
    assert.equal(computeAudiencePercentage({ kind: 'user', ...payload }, 'user').value, 0.5);
  }
  assert.equal(computeAudiencePercentage({ kind: 'user', rate: 0.5 }, 'user').value, 50);
  assert.equal(computeAudiencePercentage({ kind: 'user', pct: 0.5 }, 'user').value, null);
});

test('notification distinguishes configured coverage from observed adoption', () => {
  const after = { type: 'user', hasData: true, totalsAvailable: true, variants: [], treatment: { pct: 25 }, control: { pct: 75 }, notEligible: { pct: 0 }, unassigned: { pct: 0 } };
  const embed = buildEmbed({ kind: 'new', id: 'demo', after }, {});
  assert.match(embed.description, /25.*plages.*traitement/i);
  assert.doesNotMatch(embed.description, /des utilisateurs en treatment/i);
  after.totalsAvailable = false;
  assert.match(buildEmbed({ kind: 'changed', id: 'demo', after }, {}).description, /total fiable/);
  after.projectedCoverage = { treatment: { pct: 25 } };
  assert.match(buildEmbed({ kind: 'changed', id: 'demo', after }, {}).description, /total fiable/);
  after.projected = true;
  assert.match(buildEmbed({ kind: 'changed', id: 'demo', after }, {}).description, /poids des populations/);
});
