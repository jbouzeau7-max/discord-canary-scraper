'use strict';
// Fuzz déterministe : 200 entrées aberrantes par fonction pure exposée aux
// données externes (HTML Discord, JSON d'état, réponses réseau). Aucune ne doit
// lever ni boucler (régression : snapBoundary O(hi) bloquait sur 2^53).
const test = require('node:test');
const assert = require('node:assert');

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
function gen(d = 0) {
  switch (Math.floor(rnd() * 12)) {
    case 0: return null;
    case 1: return undefined;
    case 2: return pick([0, -1, Infinity, NaN, -0, 2 ** 53, 3.7, -1e9]);
    case 3: return pick(['', 'x'.repeat(5000), '\u0000', '{"a":1}', '<html>', '__proto__', '123', '🎉']);
    case 4: return d > 2 ? [] : Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
    case 5: { if (d > 2) return {}; const o = {}; for (let i = 0; i < 3; i++) o[pick(['id', 'name', 'pos', 'lo', 'hi', 'title', 'url', 'length'])] = gen(d + 1); return o; }
    case 6: return true;
    case 7: return [[1, 2], [3, 'x'], null];
    case 8: return new Date(NaN);
    case 9: return [{ pos: 1, label: 0 }, { lo: 1, hi: 2 }];
    case 10: return 'a'.repeat(Math.floor(rnd() * 30));
    default: return { length: -1 };
  }
}

const targets = {
  '../src/lib/exact_ranges.js': ['inferExactRanges', 'snapBoundary'],
};

for (const [mod, fns] of Object.entries(targets)) {
  const m = require(mod);
  for (const name of fns) {
    test(`fuzz x200: ${mod.split('/').pop()}:${name} ne lève jamais`, () => {
      const fn = m[name];
      assert.strictEqual(typeof fn, 'function', `${name} exporté`);
      for (let i = 0; i < 200; i++) {
        const args = [gen(), gen(), gen()];
        assert.doesNotThrow(() => fn(...args), `${name}(${i})`);
      }
    });
  }
}

test('snapBoundary: bornes géantes en O(1) et résultat inchangé', () => {
  const { snapBoundary } = require('../src/lib/exact_ranges.js');
  const t = Date.now();
  snapBoundary(0, 2 ** 53);
  assert.ok(Date.now() - t < 50);
  assert.strictEqual(snapBoundary(480, 520), 500);
  assert.strictEqual(snapBoundary(10, 11), 11);
});
