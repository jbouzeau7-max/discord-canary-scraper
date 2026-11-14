'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeGuildWire, rangesToPct } = require('../src/apex_rollouts');
const {
  parseRange,
  unionIntervals,
  positionsToPct,
  computeVariantEntry,
} = require('../src/lib/gist_rollouts');

const HM = new Map([[123, '2025-01_named']]);

test('decodeGuildWire : tuple normal décodé (buckets et plages)', () => {
  const e = decodeGuildWire([123, '', 4, [[[[0, [[0, 1000]]], [1, [[1000, 3000]]]]], []]], HM);
  assert.equal(e.id, '2025-01_named');
  assert.equal(e.treatments.length, 2);
  assert.equal(e.treatments[1].pct, 20);
  assert.equal(e.revision, 4);
});

test('decodeGuildWire : populations non-tableau → expérience conservée', () => {
  const e = decodeGuildWire([123, '', 1, { not: 'an array' }], HM);
  assert.equal(e.id, '2025-01_named');
  assert.deepEqual(e.treatments, []);
});

test('decodeGuildWire : positions/ranges malformés ignorés sans lever', () => {
  const e = decodeGuildWire([123, '', 1, [[[[0, 'x'], [1, [[0, 5000]]], ['bad', [[0, 1000]]]]], []]], HM);
  assert.equal(e.treatments.length, 2);
  assert.equal(e.treatments.find((t) => t.bucket === 1).pct, 50);
});

test('decodeGuildWire : hash sans nom → id hash: et non annoncé', () => {
  const e = decodeGuildWire([999, '', 1, [[[[1, [[0, 1000]]]], []]]], HM);
  assert.equal(e.id, 'hash:999');
});

test('rangesToPct : débordement borné à 100 %, plages vides ignorées', () => {
  assert.equal(rangesToPct([[9000, 20000]]), 10);
  assert.equal(rangesToPct([[5000, 5000]]), 0);
  assert.equal(rangesToPct(null), 0);
  assert.equal(rangesToPct([[0, 1000], [1000, 2000]]), 20);
  assert.equal(rangesToPct([{ s: '0', e: '500' }]), 5);
});

test('parseRange : tirets en/em et espaces acceptés', () => {
  assert.deepEqual(parseRange('150 – 3000'), { lo: 150, hi: 3000 });
  assert.deepEqual(parseRange('150—3000'), { lo: 150, hi: 3000 });
  assert.deepEqual(parseRange(' 0 - 10000 '), { lo: 0, hi: 10000 });
});

test('parseRange : invalides refusés', () => {
  assert.equal(parseRange('0-0'), null);
  assert.equal(parseRange('3000-150'), null);
  assert.equal(parseRange('0-10001'), null);
  assert.equal(parseRange('-1-500'), null);
  assert.equal(parseRange(42), null);
  assert.equal(parseRange(''), null);
});

test('unionIntervals : hi < lo ne produit pas de longueur négative', () => {
  const r = unionIntervals([{ lo: 0, hi: 1000 }, { lo: 500, hi: 400 }]);
  assert.equal(r.length, 1000);
  assert.equal(r.hasOverlap, false);
});

test('unionIntervals : chevauchement détecté, longueur dédupliquée', () => {
  const r = unionIntervals([{ lo: 0, hi: 2000 }, { lo: 1000, hi: 3000 }]);
  assert.equal(r.length, 3000);
  assert.equal(r.hasOverlap, true);
});

test('positionsToPct : bornes 0..10000 et arrondi 2 décimales', () => {
  assert.equal(positionsToPct(0), 0);
  assert.equal(positionsToPct(10000), 100);
  assert.equal(positionsToPct(15000), 100);
  assert.equal(positionsToPct(-5), 0);
  assert.equal(positionsToPct(1), 0.01);
});

test('computeVariantEntry : entrée invalide → null, plages valides conservées', () => {
  assert.equal(computeVariantEntry(null), null);
  assert.equal(computeVariantEntry({ ranges: [] }), null);
  assert.equal(computeVariantEntry({ ranges: ['bad'] }), null);
  const v = computeVariantEntry({ variant: 1, role: 'treatment', ranges: ['0 – 2500', 'bad'] });
  assert.equal(v.pct, 25);
  assert.equal(v.invalidRanges, 1);
});
