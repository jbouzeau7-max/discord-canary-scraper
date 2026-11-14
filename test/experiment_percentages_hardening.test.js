'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAudiencePercentage,
  calculateFromRanges,
  calculateFromPopulations,
  readProvidedPercentage,
  parseNumericValue,
} = require('../src/lib/experiment_percentages');

// --- Parsing des valeurs fournies ---

test('parseNumericValue : nombres, chaînes, % et virgule décimale', () => {
  assert.equal(parseNumericValue(25), 25);
  assert.equal(parseNumericValue('25'), 25);
  assert.equal(parseNumericValue('25%'), 25);
  assert.equal(parseNumericValue(' 12,5 % '), 12.5);
  assert.equal(parseNumericValue('1,500'), null, 'ambigu, refusé');
  assert.equal(parseNumericValue('abc'), null);
  assert.equal(parseNumericValue(''), null);
  assert.equal(parseNumericValue(Infinity), null);
  assert.equal(parseNumericValue(null), null);
});

test('readProvidedPercentage : "25%" est accepté', () => {
  assert.equal(readProvidedPercentage({ percentage: '25%' }), 25);
  assert.equal(readProvidedPercentage({ rollout: '12,5 %' }), 12.5);
});

test('readProvidedPercentage : valeurs contradictoires → null (pas de choix silencieux)', () => {
  assert.equal(readProvidedPercentage({ rate: 0.5, percentage: 25 }), null);
});

test('readProvidedPercentage : valeurs concordantes acceptées', () => {
  assert.equal(readProvidedPercentage({ rate: 0.25, percentage: 25 }), 25);
});

test('readProvidedPercentage : 0 % et 100 % sont valides', () => {
  assert.equal(readProvidedPercentage({ percentage: 0 }), 0);
  assert.equal(readProvidedPercentage({ percentage: 100 }), 100);
  assert.equal(readProvidedPercentage({ rate: 0 }), 0);
  assert.equal(readProvidedPercentage({ rate: 1 }), 100);
});

test('readProvidedPercentage : objet vide / invalide', () => {
  assert.equal(readProvidedPercentage(null), null);
  assert.equal(readProvidedPercentage({}), null);
  assert.equal(readProvidedPercentage({ percentage: 'n/a' }), null);
});

// --- Plages ---

test('calculateFromRanges : échelle explicite 10000 pour un petit rollout', () => {
  assert.equal(calculateFromRanges({ 0: { start: 0, end: 50 } }), 50);
  assert.equal(
    calculateFromRanges({ 0: { start: 0, end: 50 } }, { scale: 10000 }),
    0.5,
  );
});

test('calculateFromRanges : bornes textuelles acceptées', () => {
  assert.equal(
    calculateFromRanges({ 0: { start: '0', end: '2500' }, 1: { start: '2500', end: '5000' } }),
    50,
  );
});

test('calculateFromRanges : plage vide ignorée, tout vide → 0', () => {
  assert.equal(calculateFromRanges({ 0: { start: 10, end: 10 } }), 0);
  assert.equal(
    calculateFromRanges({ 0: { start: 0, end: 10 }, 1: { start: 10, end: 10 } }),
    10,
  );
});

test('calculateFromRanges : données manquantes ou inversées → null', () => {
  assert.equal(calculateFromRanges({ 0: { start: 5 } }), null);
  assert.equal(calculateFromRanges({ 0: { start: 10, end: 5 } }), null);
  assert.equal(calculateFromRanges({}), null);
  assert.equal(calculateFromRanges(null), null);
});

test('calculateFromRanges : chevauchement sans double comptage et plafond 100', () => {
  assert.equal(
    calculateFromRanges({ 0: { start: 0, end: 5000 }, 1: { start: 2500, end: 5000 } }),
    50,
  );
  assert.equal(calculateFromRanges({ 0: { start: 0, end: 50000 } }, { scale: 10000 }), 100);
});

test('calculateFromRanges : échelle inconnue (> 10000 sans scale) → null', () => {
  assert.equal(calculateFromRanges({ 0: { start: 0, end: 50000 } }), null);
});

// --- Populations ---

test('calculateFromPopulations : valeurs textuelles et 0/100 %', () => {
  assert.equal(
    calculateFromPopulations({ 0: { enabled: '0', total: '100' }, 1: { enabled: '100', total: '100' } }),
    50,
  );
  assert.equal(
    calculateFromPopulations({ 0: { enabled: 0, total: 100 }, 1: { enabled: 0, total: 100 } }),
    0,
  );
  assert.equal(
    calculateFromPopulations({ 0: { enabled: 100, total: 100 }, 1: { enabled: 100, total: 100 } }),
    100,
  );
});

test('calculateFromPopulations : incohérences refusées', () => {
  assert.equal(calculateFromPopulations({ 0: { enabled: 200, total: 100 } }), null);
  assert.equal(calculateFromPopulations({ 0: { enabled: 1, total: 0 } }), null);
  assert.equal(calculateFromPopulations({ 0: { enabled: 1, total: -5 } }), null);
  assert.equal(calculateFromPopulations({ 0: null }), null);
});

// --- computeAudiencePercentage ---

test('computeAudiencePercentage : public imbriqué numérique', () => {
  const r = computeAudiencePercentage({ kind: 'guild', guild: 42 }, 'guild');
  assert.equal(r.status, 'provided');
  assert.equal(r.value, 42);
  assert.equal(r.source, 'audience_nested');
});

test('computeAudiencePercentage : 0 % et 100 % fournis restent provided', () => {
  const z = computeAudiencePercentage({ kind: 'guild', percentage: 0 }, 'guild');
  assert.equal(z.status, 'provided');
  assert.equal(z.value, 0);
  const h = computeAudiencePercentage({ kind: 'guild', percentage: 100 }, 'guild');
  assert.equal(h.status, 'provided');
  assert.equal(h.value, 100);
});

test('computeAudiencePercentage : scale explicite transmise aux plages', () => {
  const r = computeAudiencePercentage(
    { kind: 'guild', variations: { 0: { start: 0, end: 50 } } },
    'guild',
    { scale: 10000 },
  );
  assert.equal(r.status, 'calculated');
  assert.equal(r.value, 0.5);
});

test('computeAudiencePercentage : données vides ne fabriquent jamais de pourcentage', () => {
  for (const exp of [null, {}, { kind: 'guild' }, { kind: 'guild', variations: {} }]) {
    const r = computeAudiencePercentage(exp, 'guild');
    assert.equal(r.status, 'unknown');
    assert.equal(r.value, null);
  }
});
