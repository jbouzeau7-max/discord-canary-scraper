'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEWS = ['app.js', 'mobile.js', 'rollouts.js', 'shop.js'];

test('les vues de données n’interprètent jamais le JSON comme du HTML', () => {
  for (const name of VIEWS) {
    const source = fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8');
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/, name);
    assert.match(source, /textContent/, `${name} doit rendre les valeurs en texte`);
  }
});
