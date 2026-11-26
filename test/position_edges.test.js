'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyState, addPoint, bounds } = require('../src/lib/position_bounds');

test('une observation isolée ne place pas les frontières inconnues aux extrêmes', () => {
  const s = emptyState();
  addPoint(s, 5000, true);
  const b = bounds(s);
  assert.equal(b.minPct, 0.01);
  assert.equal(b.maxPct, 100);
  assert.equal(b.estPct, 50.01);
});

test('frontières externes et internes : estimation médiane, sans déplacer les bornes', () => {
  const s = emptyState();
  addPoint(s, 1000, true);
  addPoint(s, 2000, false);
  const b = bounds(s);
  assert.equal(b.minPct, 0.01);
  assert.equal(b.maxPct, 20);
  assert.equal(b.estPct, 10.01);
});
