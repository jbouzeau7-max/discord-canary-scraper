'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rangesToPct } = require('../src/apex_rollouts.js');

test('rangesToPct : précision 0,01 pt (1 position / 10000)', () => {
  assert.strictEqual(rangesToPct([{ s: 0, e: 1 }]), 0.01);
  assert.strictEqual(rangesToPct([{ s: 0, e: 1234 }]), 12.34);
  assert.strictEqual(rangesToPct([{ s: 0, e: 500 }, { s: 400, e: 1000 }]), 10);
  assert.strictEqual(rangesToPct([{ s: 0, e: 10000 }]), 100);
});

test('buildEmbeds : montée/baisse avec emoji, barre et avant → après', () => {
  const { buildEmbeds, pctBar } = require('../src/apex_rollouts.js');
  assert.strictEqual(pctBar(50), '▰▰▰▰▰▱▱▱▱▱');
  assert.strictEqual(pctBar(150), '▰'.repeat(10));
  const [up] = buildEmbeds({ added: [], removed: [], changed: [{ after: { id: 'x', revision: 2 }, maxAbs: 15, deltas: [{ label: 'Variant 1', bucket: 1, from: 10, to: 25, delta: 15 }] }] });
  assert.match(up.title, /^📈 Montée de rollout serveur — x$/);
  assert.match(up.description, /10,00 % → \*\*25,00 %\*\*/);
  assert.match(up.description, /<t:\d+:R>/);
  const [down] = buildEmbeds({ added: [], removed: [], changed: [{ after: { id: 'y' }, maxAbs: 5, deltas: [{ label: 'Variant 1', from: 10, to: 5, delta: -5 }] }] });
  assert.match(down.title, /^📉 Baisse/);
  const all = buildEmbeds({ added: Array.from({ length: 12 }, (_, i) => ({ id: 'a' + i, treatments: [{ bucket: 1, label: 'Variant 1', pct: 1 }] })), changed: [], removed: [] });
  assert.strictEqual(all.length, 10, 'jamais plus de 10 embeds par lot');
});
