'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, textDisplay, embedsToComponents, embedToComponents, buildSectionMessages } = require('../src/lib/components_v2');

test('single and grouped cards keep the source link, but not unsupported schemes', () => {
  for (const render of [embedToComponents, e => embedsToComponents([e])]) {
    const renderText = url => render({ title: 'Article', url }).flatMap(([c]) => c.components.map(x => x.content)).join('\n');
    assert.match(renderText('https://example.org/article'), /Source : <https:\/\/example\.org\/article>/);
    assert.doesNotMatch(renderText('javascript:example'), /javascript|Source/);
  }
});
test('section summary gives the count in French and omits unknown build numbers', () => {
  const [[card]] = buildSectionMessages({ sections: [{ label: 'Textes', count: 1, lines: ['Bonjour'] }] });
  assert.match(card.components[0].content, /1 élément/);
  assert.doesNotMatch(card.components[0].content, /undefined|items/);
});

for (const boundary of [' ', '\n', '🚀']) {
  test(`long descriptions survive a ${JSON.stringify(boundary)} at the cut`, () => {
    const text = 'a'.repeat(boundary === '🚀' ? 3999 : 4000) + boundary + 'fin';
    const parts = embedsToComponents([{ description: text }]).flatMap(([c]) => c.components.map(x => x.content));
    assert.ok(parts.every(x => x.length <= 3900 && !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(x)));
    assert.equal(parts.join(''), text);
    assert.ok(chunkText(text).every(x => x.length <= 4000));
  });
}
test('a clipped standalone text visibly signals omission without a broken emoji', () => {
  const result = textDisplay('a'.repeat(3998) + '🚀fin').content;
  assert.equal(result, 'a'.repeat(3998) + '…');
});
