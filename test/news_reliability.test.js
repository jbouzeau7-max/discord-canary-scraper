'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRssItems, dedupeSimilar, buildItem } = require('../src/news');

test('une entité numérique invalide ne fait pas perdre le flux', () => {
  const rss = ['&#99999999; &#xD800; &#x1F30D;', 'Article suivant'].map((title) =>
    `<item><title>${title}</title><link>https://example.org/news</link></item>`).join('');
  assert.deepEqual(parseRssItems(rss).map((it) => it.title), ['� � 🌍', 'Article suivant']);
});

test('même URL ou titre court : une seule carte, sources et image conservées', () => {
  const items = [
    { title: 'Séisme', keys: ['u1', 't1'], sourceName: 'BBC' },
    { title: 'Tremblement de terre', keys: ['u1', 't2'], sourceName: 'AFP', image: 'https://example.org/img' },
    { title: 'Séisme', keys: ['u3', 't1'], sourceName: 'AFP' },
    { title: 'Éruption', keys: ['u4', 't4'], sourceName: 'BBC' },
  ];
  const { kept, dropped } = dedupeSimilar(items);
  assert.deepEqual(kept, [items[0], items[3]]);
  assert.deepEqual(dropped, [items[1], items[2]]);
  assert.deepEqual(kept[0].alsoBy, ['AFP']);
  assert.equal(kept[0].image, items[1].image);
});

test('un lien non publiable ne consomme pas de place dans la sélection', () => {
  const now = Date.now();
  const make = (link) => buildItem({ title: 'Séisme', link, dateRaw: new Date(now).toISOString() }, { cat: 'monde' }, now);
  for (const link of ['pas un lien', 'ftp://example.org/a']) assert.equal(make(link), null);
  assert.equal(make('https://example.org/a?utm_source=x').url, 'https://example.org/a');
});
