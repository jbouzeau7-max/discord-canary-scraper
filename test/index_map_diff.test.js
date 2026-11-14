'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMapDiff } = require('../src/index');

function map(n, prefix = 'k') {
  const o = {};
  for (let i = 0; i < n; i++) o[`${prefix}${i}`] = `v${i}`;
  return o;
}

test('computeMapDiff : ajout, modification, suppression', () => {
  const last = { a: '1', b: '2', c: '3' };
  const cur = { a: '1', b: '9', d: '4' };
  const d = computeMapDiff(last, cur);
  assert.deepEqual(d.added, { d: '4' });
  assert.deepEqual(d.modified, { b: '9' });
  assert.deepEqual(d.removed, { c: '3' });
});

test('computeMapDiff : clé connue non ré-annoncée, sauf catch-up', () => {
  const d = computeMapDiff({}, { fresh: 'x' }, { known: new Set(['fresh']) });
  assert.deepEqual(d.added, {});
  const c = computeMapDiff({}, { fresh: 'x' }, { known: new Set(['fresh']), isCatchUp: true });
  assert.deepEqual(c.added, { fresh: 'x' });
});

test('computeMapDiff : clés de prototype traitées comme de vraies clés', () => {
  // Avant : `'constructor' in last` valait true (héritage Object) → perdu.
  const d = computeMapDiff({}, { constructor: 'x', toString: 'y' });
  assert.deepEqual(d.added, { constructor: 'x', toString: 'y' });
  const m = computeMapDiff({ constructor: 'old' }, { constructor: 'new' });
  assert.deepEqual(m.modified, { constructor: 'new' });
  const prev = { toString: 'v', ...map(99) };
  const r = computeMapDiff(prev, map(99));
  assert.deepEqual(r.removed, { toString: 'v' });
});

test('computeMapDiff : valeurs 0/false/null comparées en texte', () => {
  const d = computeMapDiff({ a: 0, b: false }, { a: '0', b: 'false' });
  assert.deepEqual(d.modified, {});
  const c = computeMapDiff({ a: 0 }, { a: 1 });
  assert.deepEqual(c.modified, { a: 1 });
});

test('computeMapDiff : ratio hors bornes → aucune suppression', () => {
  const last = map(100);
  const cur = map(10); // ratio 0.1
  assert.deepEqual(computeMapDiff(last, cur).removed, {});
  const cur2 = map(200); // ratio 2
  assert.deepEqual(computeMapDiff(last, cur2).removed, {});
});

test('computeMapDiff : plafond de suppressions → removed vidé', () => {
  const last = map(100);
  const cur = map(60); // ratio 0.6 < 0.75 → déjà vide
  assert.deepEqual(computeMapDiff(last, cur, { maxRemoved: 5 }).removed, {});
  const last2 = map(100);
  const cur2 = map(80); // ratio 0.8, 20 suppressions
  assert.deepEqual(computeMapDiff(last2, cur2, { maxRemoved: 5 }).removed, {});
  const d = computeMapDiff(last2, cur2, { maxRemoved: 50 });
  assert.equal(Object.keys(d.removed).length, 20);
});

test('computeMapDiff : plafond d\'ajouts', () => {
  const d = computeMapDiff({}, map(10), { maxAdded: 3 });
  assert.equal(Object.keys(d.added).length, 3);
});

test('computeMapDiff : entrées nulles / non-objets', () => {
  assert.deepEqual(computeMapDiff(null, null), { added: {}, modified: {}, removed: {} });
  assert.deepEqual(computeMapDiff(undefined, { a: 1 }).added, { a: 1 });
  // ratio 0 → suppression non fiable, jamais annoncée
  assert.deepEqual(computeMapDiff({ a: 1 }, null).removed, {});
});
