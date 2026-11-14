'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY, SOURCES, activeSources } = require('../src/news');

test('catégories actus : chaque catégorie a des sources, ids uniques, URLs https', () => {
  const ids = new Set();
  for (const src of SOURCES) {
    assert.ok(CATEGORY[src.cat], 'catégorie inconnue ' + src.cat);
    assert.ok(!ids.has(src.id), 'id dupliqué ' + src.id);
    ids.add(src.id);
    assert.match(src.url, /^https:\/\//);
  }
  for (const cat of Object.keys(CATEGORY)) {
    assert.ok(SOURCES.some((s) => s.cat === cat), 'aucune source pour ' + cat);
  }
  assert.ok(Object.keys(CATEGORY).length >= 17);
});

test('activeSources : vide = toutes, sinon filtre par catégorie', () => {
  assert.equal(activeSources(SOURCES, new Set()).length, SOURCES.length);
  const only = activeSources(SOURCES, new Set(['foot', 'gaming']));
  assert.ok(only.length > 0 && only.every((s) => s.cat === 'foot' || s.cat === 'gaming'));
});
