'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyNotifyResult, changeText } = require('../src/blog_tracker');

for (const source of ['blog', 'support']) {
  test(`${source}: prune confirmed or silent removals; retry only undelivered ones`, () => {
    const prev = ['silent', 'sent', 'retry'].map(id => ({ id, source }));
    const items = [true, false].map((sent, i) => ({ source, e: prev[i + 1], action: 'removed', sent }));
    assert.deepEqual(applyNotifyResult(prev, [], { items }, source), [prev[2]]);
  });
}

test('summary update shows the changed words, not just a generic label', () => {
  const text = changeText({ _changes: [{ kind: 'description', before: 'Available on desktop', after: 'Available on mobile' }] }).content;
  assert.match(text, /desktop/);
  assert.match(text, /mobile/);
});
