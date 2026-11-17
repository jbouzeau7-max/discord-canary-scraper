'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeExpDiff, buildGap, mergeExp, MIN_EXP_FOR_DIFF } = require('../src/index');

function exp(i, kind = 'guild', label = 'x') {
  return { id: `2024-01_exp_${i}`, kind, label, variations: { 0: { id: 0 }, 1: { id: 1 } } };
}

function snapMap(n) {
  const out = {};
  for (let i = 0; i < n; i++) out[exp(i).id] = { id: exp(i).id, type: 'guild', kind: 'guild' };
  return out;
}

test('buildGap : numéros valides, manquants, régression', () => {
  assert.equal(buildGap('100', '105'), 5);
  assert.equal(buildGap('105', '100'), 0);
  assert.equal(buildGap(null, '100'), 0);
  assert.equal(buildGap('unknown', '100'), 0);
  assert.equal(buildGap(undefined, undefined), 0);
});

test('mergeExp : remplace par id, ignore les entrées invalides, trie', () => {
  const out = mergeExp(
    [{ id: 'b', label: 'old' }, null, 'c'],
    [{ id: 'b', label: 'new' }, { id: 'a' }, null, {}],
  );
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(out.find((e) => e.id === 'b').label, 'new');
});

test('computeExpDiff : extract partiel conserve la baseline (pas d\'écrasement)', () => {
  const lastExp = snapMap(400);
  const current = Array.from({ length: 10 }, (_, i) => exp(i));
  const { expDiff, nextExpSnap, coverage } = computeExpDiff(current, lastExp, new Set());
  assert.equal(expDiff.added.length, 0);
  assert.equal(expDiff.removed.length, 0);
  assert.equal(coverage.reliable, false);
  // Les 400 snapshots restent présents, les 10 extraits rafraîchis.
  assert.equal(Object.keys(nextExpSnap).length, 400);
  assert.ok(nextExpSnap[exp(0).id]);
});

test('computeExpDiff : extract partiel n\'ajoute pas de faux nouveaux', () => {
  const lastExp = snapMap(100);
  const current = Array.from({ length: 5 }, (_, i) => exp(1000 + i));
  const { nextExpSnap } = computeExpDiff(current, lastExp, new Set());
  assert.deepEqual(nextExpSnap, lastExp);
  assert.equal(Object.keys(nextExpSnap).length, 100);
});

test('computeExpDiff : extract complet détecte ajout et modification', () => {
  const lastExp = {};
  for (let i = 0; i < 100; i++) {
    lastExp[exp(i).id] = { id: exp(i).id, type: 'guild', kind: 'guild', label: 'x', variations: { 0: {}, 1: {} } };
  }
  const current = [];
  for (let i = 0; i < 100; i++) current.push(exp(i));
  current.push(exp(999)); // ajout
  current[0] = { ...current[0], label: 'nouveau label' }; // modification
  const { expDiff, coverage } = computeExpDiff(current, lastExp, new Set());
  assert.equal(coverage.reliable, true);
  assert.equal(expDiff.added.length, 1);
  assert.equal(expDiff.added[0].id, exp(999).id);
  assert.equal(expDiff.modified.length, 1);
});

test('computeExpDiff : ids hash: et entrées invalides ignorés', () => {
  const lastExp = snapMap(100);
  const current = Array.from({ length: 100 }, (_, i) => exp(i));
  current.push({ id: 'hash:abcdef' }, null, {});
  const { nextExpSnap } = computeExpDiff(current, lastExp, new Set());
  assert.equal(Object.keys(nextExpSnap).some((k) => k.startsWith('hash:')), false);
});

test('MIN_EXP_FOR_DIFF reste un seuil positif', () => {
  assert.ok(Number.isFinite(MIN_EXP_FOR_DIFF) && MIN_EXP_FOR_DIFF > 0);
});

test('computeExpDiff : rétention faible préserve le snapshot et supprime les diff fantômes', () => {
  const lastExp = snapMap(100);
  const current = Array.from({ length: 100 }, (_, i) => exp(1000 + i));
  const { expDiff, nextExpSnap, coverage } = computeExpDiff(current, lastExp, new Set());
  assert.equal(coverage.reliable, false);
  assert.equal(coverage.reason, 'retention_too_low');
  assert.equal(expDiff.added.length, 0);
  assert.equal(expDiff.removed.length, 0);
  assert.deepEqual(nextExpSnap, lastExp);
});
