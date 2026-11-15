'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stableStringify, stableChangeFingerprint } = require('../src/lib/rollout_math');

test('fingerprint : null et undefined restent distincts', () => {
  assert.notEqual(stableStringify({ value: null }), stableStringify({ value: undefined }));
  assert.notEqual(stableChangeFingerprint({ value: null }), stableChangeFingerprint({ value: undefined }));
});

test('fingerprint : NaN, ±Infinity, null et zéro ne collisionnent pas', () => {
  const values = [NaN, Infinity, -Infinity, null, 0];
  const serializations = values.map((value) => stableStringify({ value }));
  assert.equal(new Set(serializations).size, values.length);
});

test('fingerprint : type tableau/objet et objet sentinelle restent distincts', () => {
  assert.notEqual(stableStringify([]), stableStringify({}));
  assert.notEqual(stableStringify({ value: undefined }), stableStringify({ value: { $type: 'undefined' } }));
});

test('fingerprint : trou de tableau distinct de undefined explicite', () => {
  const sparse = Array(1);
  assert.notEqual(stableStringify(sparse), stableStringify([undefined]));
});

test('fingerprint : ordre des clés profondes sans effet, valeur différente détectée', () => {
  const a = { z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] };
  const b = { a: [{ x: 1, y: 2 }], z: { a: 1, b: 2 } };
  const c = { a: [{ x: 1, y: 3 }], z: { a: 1, b: 2 } };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}', 'payloads JSON ordinaires gardent leur représentation historique');
  assert.equal(stableChangeFingerprint(a), stableChangeFingerprint(b));
  assert.notEqual(stableChangeFingerprint(a), stableChangeFingerprint(c));
});

test('fingerprint : graphes cycliques structurellement égaux sont déterministes', () => {
  const a = { value: 1 };
  a.self = a;
  const b = { value: 1 };
  b.self = b;
  const c = { value: 2 };
  c.self = c;
  assert.equal(stableStringify(a), stableStringify(b));
  assert.notEqual(stableStringify(a), stableStringify(c));
});
