const test = require('node:test');
const assert = require('node:assert');
const { trimRecent } = require('../src/lib/utils');

test('trimRecent keeps re-touched fingerprints', () => {
  const s = new Set(['a', 'b', 'c']);
  s.delete('a'); s.add('a');
  assert.deepStrictEqual(trimRecent(s, 2), ['c', 'a']);
});

test('safeIso never throws on malformed dates', () => {
  const { safeIso } = require('../src/lib/utils');
  assert.strictEqual(safeIso('not a date'), null);
  assert.strictEqual(safeIso(undefined, 'x'), 'x');
  assert.strictEqual(safeIso('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
});
