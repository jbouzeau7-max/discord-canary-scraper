'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rangesPercentExclusive } = require('../src/lib/rollout_math');
const { parseGuildExperiment } = require('../src/experiment_rollouts');

test('rangesPercentExclusive : une plage sous zéro est tronquée à la borne basse', () => {
  assert.equal(rangesPercentExclusive([[-1000, 500]]), 5);
});

test('rangesPercentExclusive : une plage au-dessus de l’échelle est tronquée à la borne haute', () => {
  assert.equal(rangesPercentExclusive([[9500, 20000]]), 5);
});

test('rangesPercentExclusive : chevauchements et dépassements sont bornés avant fusion', () => {
  assert.equal(rangesPercentExclusive([[-200, 1000], [500, 1200], [9000, 10200]]), 22);
});

test('rangesPercentExclusive : échelles nulles, négatives ou non finies ne produisent pas NaN', () => {
  for (const scale of [0, -1, NaN, Infinity]) {
    assert.equal(rangesPercentExclusive([[0, 500]], scale), 0);
  }
});

test('parseGuildExperiment : populations non-tableau donnent unknown, pas un faux 0 %', () => {
  const result = parseGuildExperiment([123, 'test_exp', 1, { malformed: true }]);
  assert.equal(result.percentage, null);
  assert.equal(result.status, 'unknown');
  assert.equal(result.dataStatus, 'malformed');
});

test('parseGuildExperiment : tableau de populations vide est un vrai 0 % complet', () => {
  const result = parseGuildExperiment([123, 'test_exp', 1, []]);
  assert.equal(result.percentage, 0);
  assert.equal(result.status, 'not_started');
  assert.equal(result.dataStatus, 'complete');
});

test('parseGuildExperiment : structures imbriquées ou intervalles malformés ne valent pas 0 %', () => {
  const malformedPopulation = parseGuildExperiment([123, 'test_exp', 1, [{ malformed: true }]]);
  const malformedRange = parseGuildExperiment([123, 'test_exp', 1, [[[[1, [['bad', 1000]]]], []]]]);
  for (const result of [malformedPopulation, malformedRange]) {
    assert.equal(result.percentage, null);
    assert.equal(result.status, 'unknown');
    assert.equal(result.dataStatus, 'malformed');
  }
});

test('parseGuildExperiment : plages qui se chevauchent sur deux populations ne sont pas additionnées deux fois', () => {
  const populations = [
    [[[1, [[0, 1000]]]], []],
    [[[2, [[500, 1500]]]], []],
  ];
  const result = parseGuildExperiment([123, 'test_exp', 1, populations]);
  assert.equal(result.percentage, 15);
  assert.equal(result.status, 'partial');
  assert.equal(result.dataStatus, 'complete');
  assert.deepEqual(result.treatmentRanges, [[0, 1500]]);
});
