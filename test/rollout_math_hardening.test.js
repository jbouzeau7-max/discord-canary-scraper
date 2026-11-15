'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableChangeFingerprint,
  stableStringify,
  parseRangeStrings,
  classifyChange,
  estimateFromPoints,
  wilsonPctInterval,
} = require('../src/lib/rollout_math');

// --- Empreinte stable : le bug historique collisionnait sur l'imbriqué ---

test('stableChangeFingerprint : objets imbriqués différents → empreintes différentes', () => {
  const a = stableChangeFingerprint({ id: 'x', deltas: { 0: [1, 2], 1: [3, 4] } });
  const b = stableChangeFingerprint({ id: 'x', deltas: { 0: [9, 9], 1: [3, 4] } });
  assert.notEqual(a, b);
});

test('stableChangeFingerprint : ordre des clés indifférent, structure profonde incluse', () => {
  const a = stableChangeFingerprint({ b: 2, a: { y: [1, { q: 3 }], x: 1 } });
  const b = stableChangeFingerprint({ a: { x: 1, y: [1, { q: 3 }] }, b: 2 });
  assert.equal(a, b);
  const c = stableChangeFingerprint({ b: 2, a: { y: [1, { q: 4 }], x: 1 } });
  assert.notEqual(a, c);
});

test('stableStringify : types spéciaux et cycles sont sérialisés sans lever', () => {
  assert.doesNotThrow(() => stableStringify({ a: Infinity, b: NaN, c: undefined }));
  const o = { a: 1 };
  o.self = o;
  assert.match(stableStringify(o), /"cycle",0/);
  assert.equal(stableStringify([1, 2, 3]), '[1,2,3]');
});

// --- parseRangeStrings ---

test('parseRangeStrings : tableaux et objets {start,end} acceptés', () => {
  assert.deepEqual(parseRangeStrings([[0, 1500]]), [[0, 1500]]);
  assert.deepEqual(parseRangeStrings([{ start: 10, end: 20 }, { s: 30, e: 40 }]), [
    [10, 20],
    [30, 40],
  ]);
});

test('parseRangeStrings : séparateurs de milliers et espaces', () => {
  assert.deepEqual(parseRangeStrings(['1,500 - 3,000']), [[1500, 3000]]);
  assert.deepEqual(parseRangeStrings(['1 500 - 3 000']), [[1500, 3000]]);
});

test('parseRangeStrings : données invalides ignorées sans lever', () => {
  assert.deepEqual(parseRangeStrings([null, undefined, 42, '', 'x-y', ['a', 'b']]), []);
  assert.deepEqual(parseRangeStrings([['0', '0']]), []);
});

// --- classifyChange ---

test('classifyChange : apparition à 0 % n\'est pas un démarrage', () => {
  assert.deepEqual(classifyChange(null, 0), { changeType: null, change: 0 });
});

test('classifyChange : minDelta négatif ou NaN ne fait pas tout notifier', () => {
  assert.equal(classifyChange(10, 10.2, -5).changeType, 'ROLLOUT_INCREASED');
  assert.equal(classifyChange(10, 11.2, NaN).changeType, 'ROLLOUT_INCREASED');
  assert.equal(classifyChange(10, 10.4, 0).changeType, 'ROLLOUT_INCREASED');
});

test('classifyChange : seuils stricts et cas 100 %', () => {
  assert.equal(classifyChange(98, 100, 1).changeType, 'ROLLOUT_COMPLETED');
  assert.equal(classifyChange(0, 100, 1).changeType, 'ROLLOUT_COMPLETED');
  assert.equal(classifyChange(5, 0, 1).changeType, 'ROLLOUT_REMOVED');
});

// --- estimateFromPoints ---

test('estimateFromPoints : points hors échelle ignorés pour observed', () => {
  const e = estimateFromPoints([-5, 1, 2, 3, 4, 20000], 10);
  assert.deepEqual(e.observed, [1, 4]);
  assert.ok(e.percentage >= 0 && e.percentage <= 100);
});

test('estimateFromPoints : couverture quasi totale des buckets → ~100 %', () => {
  const pts = [];
  for (let i = 0; i < 10000; i += 10) pts.push(i);
  const e = estimateFromPoints(pts, 50);
  assert.ok(e.percentage >= 99.9 && e.percentage <= 100, String(e.percentage));
});

test('estimateFromPoints : aucun point valide → insuffisant, pas de observed', () => {
  const e = estimateFromPoints([-1, 20000, NaN], 10);
  assert.equal(e.observed, null);
  assert.equal(e.percentage, null);
  assert.equal(e.status, 'insufficient_data');
});

// --- wilsonPctInterval ---

test('wilsonPctInterval : k > n ne produit pas un intervalle invalide', () => {
  const ci = wilsonPctInterval(20, 10);
  assert.ok(ci.lo >= 0 && ci.lo <= 100);
  assert.ok(ci.hi >= 0 && ci.hi <= 100);
  assert.ok(ci.lo <= ci.hi);
});

test('wilsonPctInterval : n = 0 → intervalle maximal', () => {
  assert.deepEqual(wilsonPctInterval(0, 0), { lo: 0, hi: 100, sigma: 100 });
});
