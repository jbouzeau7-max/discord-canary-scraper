'use strict';
/**
 * Régressions : fiabilité des % estimés par échantillonnage d'empreintes.
 *
 * Avant : un seul tirage non enrollé produisait « not_started 0 % » et 50/50
 * était publié comme un 100 % exact — deux états tranchés que l'échantillon
 * ne permet pas de justifier. La classification passe maintenant par un
 * intervalle de Wilson (rollout_math).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySampledPercentage, parseGuildExperiment } = require('../src/experiment_rollouts');

test('classifySampledPercentage : 1 tirage ne tranche jamais', () => {
  for (const [k, n] of [[0, 1], [1, 1], [0, 2], [2, 2], [0, 8]]) {
    const r = classifySampledPercentage(k, n);
    assert.equal(r.status, 'insufficient_data', `${k}/${n} ne doit pas être tranché`);
    assert.equal(r.confidence, 'low');
    assert.ok(r.ci95, 'un IC est toujours publié');
  }
});

test('classifySampledPercentage : 0/50 → not_started avec borne haute documentée', () => {
  const r = classifySampledPercentage(0, 50);
  assert.equal(r.percentage, 0);
  assert.equal(r.status, 'not_started');
  assert.equal(r.confidence, 'high');
  assert.ok(r.ci95[1] > 0 && r.ci95[1] <= 10, `borne haute réaliste, reçu ${r.ci95[1]}`);
});

test('classifySampledPercentage : 50/50 → full_rollout mais pas 100 % exact', () => {
  const r = classifySampledPercentage(50, 50);
  assert.equal(r.percentage, 100);
  assert.equal(r.status, 'full_rollout');
  assert.ok(r.ci95[0] >= 90 && r.ci95[0] < 100, 'la borne basse interdit de lire un 100 % exact');
});

test('classifySampledPercentage : valeur intermédiaire → partial, pourcentage inchangé', () => {
  const r = classifySampledPercentage(3, 50);
  assert.equal(r.percentage, 6);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.ci95.map(Math.round), [2, 17]);
  // Arrondi identique à l'ancien calcul pour ne pas déplacer les données publiées.
  assert.equal(classifySampledPercentage(1, 3).percentage, 33.33);
});

test('classifySampledPercentage : entrées dégénérées sans exception', () => {
  assert.deepEqual(classifySampledPercentage(0, 0), {
    percentage: null, status: 'unknown', confidence: 'low', ci95: null,
  });
  assert.equal(classifySampledPercentage(-5, 10).percentage, 0);
  assert.equal(classifySampledPercentage(99, 10).percentage, 100, 'enrolled borné à n');
  assert.equal(classifySampledPercentage(NaN, 10).percentage, 0);
});

test('classifySampledPercentage : seuils surchargeables (tests/env)', () => {
  const strict = classifySampledPercentage(0, 20, { minSamples: 21 });
  assert.equal(strict.status, 'insufficient_data');
  const wide = classifySampledPercentage(0, 20, { minSamples: 5, edgeMarginPct: 30 });
  assert.equal(wide.status, 'not_started', 'IC haut ~16 % sous la marge de 30 pts');
});

test('parseGuildExperiment : la classification exacte (plages) reste inchangée', () => {
  const full = parseGuildExperiment([2, 'f', 1, [[[[1, [[0, 10000]]]], []]]]);
  assert.equal(full.status, 'full_rollout');
  assert.equal(full.percentage, 100);
  const none = parseGuildExperiment([1, 'e', 1, [[[[0, [[0, 5000]]]], []]]]);
  assert.equal(none.status, 'not_started');
});
