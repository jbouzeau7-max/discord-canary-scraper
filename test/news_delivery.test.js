'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRssItems, cleanDesc, buildItem, buildComponents } = require('../src/news');

const src = { id: 'gn-monde-fr', cat: 'monde', name: 'Google News' };
const now = Date.parse('2026-11-08T12:00:00Z');
const raw = { title: 'Une découverte - Le Monde', sourceTag: 'Le Monde', dateRaw: new Date(now).toISOString(), link: 'https://example.org/a' };

test('Atom : le titre ouvre la page HTML, pas le flux ni la pièce jointe', () => {
  const entry = '<entry><title>Science</title><link rel="self" href="https://example.org/feed"/><link rel="enclosure" href="https://example.org/audio"/><link href="https://example.org/article?a=1&amp;b=2" type="text/html" rel="alternate"/></entry>';
  assert.equal(parseRssItems(entry)[0].link, 'https://example.org/article?a=1&b=2');
  assert.deepEqual(parseRssItems('<entry><title>Sans article</title><link rel="self" href="https://example.org/feed"/></entry>'), []);
  assert.equal(parseRssItems(entry.replace('rel="alternate"/>', 'rel="alternate"></link>'))[0].link, 'https://example.org/article?a=1&b=2');
});

test('résumé : garde les détails qui suivent le titre, sans répéter le titre', () => {
  assert.equal(cleanDesc('Une découverte : les chercheurs publient leurs résultats.', 'Une découverte'), 'les chercheurs publient leurs résultats.');
  assert.equal(cleanDesc('Une découverte - Le Monde', 'Une découverte', 'Le Monde'), '');
  assert.equal(cleanDesc('France won the final.', 'France'), 'France won the final.');
});

test('carte agrégée : nomme le média, conserve la provenance et l’heure', () => {
  const item = buildItem(raw, src, now);
  const text = buildComponents(item)[0].components.map(c => c.content).join('\n');
  assert.match(text, /Le Monde/);
  assert.match(text, /Google News/);
  assert.match(text, /<t:\d+:R>/);
});

test('lien long : le titre reste cliquable sans bouton à destination tronquée', () => {
  const item = buildItem({ ...raw, link: 'https://example.org/' + 'a'.repeat(600) }, src, now);
  const components = buildComponents(item);
  assert.ok(components[0].components.some(c => c.content?.includes(item.url)));
  assert.ok(!components.flatMap(c => c.components).some(c => c.style === 5 && c.url !== item.url));
  for (const length of [512, 513]) {
    const url = 'https://example.org/'.padEnd(length, 'a');
    assert.equal(buildComponents({ ...item, url }).length, length === 512 ? 2 : 1);
  }
  assert.equal(buildItem({ ...raw, link: 'https://example.org/' + '('.repeat(4000) }, src, now), null);
});
