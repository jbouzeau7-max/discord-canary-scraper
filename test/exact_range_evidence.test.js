'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferExactRanges } = require('../src/lib/exact_ranges');

const sequence = (start, n, label) => Array.from({ length: n }, (_, i) => ({ pos: start + i, label }));

test('a rounded boundary must cover both compatible endpoints in its uncertainty', () => {
  const sample = [...sequence(980, 20, 1), ...sequence(1100, 20, -99)];
  const result = inferExactRanges(sample);
  assert.equal(result.ok, true);
  assert.equal(result.pct['1'], 10);
  // Both [0,1000) and [0,1100) fit all observations.
  assert.ok(result.pct['1'] + result.uncertainty['1'] >= 11);
});

test('repeated observations cannot satisfy a minimum of twenty spatial positions', () => {
  assert.equal(inferExactRanges(Array(30).fill({ pos: 42, label: 1 })), null);
});

test('repeating an isolated position cannot conceal a contradictory island', () => {
  const sample = [...sequence(0, 20, 1), ...Array(30).fill({ pos: 25, label: 2 }), ...sequence(30, 20, 1)];
  assert.equal(inferExactRanges(sample).ok, false);
});
