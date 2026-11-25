'use strict';
/**
 * Régressions : agrégation des % guild depuis l'état apex.
 *
 * Deux variantes qui partagent le même bucket (ou une entrée dupliquée par une
 * fusion de runs) ne doublent pas le déploiement : sans dédoublonnage,
 * `[{bucket:1,pct:30},{bucket:1,pct:30}]` donnait 60 % et le plafond à 100
 * masquait le double comptage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { guildPctFromApex } = require('../src/lib/rollout_percentages');

test('guildPctFromApex : un bucket compté une seule fois (variantes partagées)', () => {
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: 1, pct: 30 }, { bucket: 1, pct: 30 }] }),
    30,
  );
});

test('guildPctFromApex : entrée dupliquée par une fusion de runs', () => {
  assert.equal(
    guildPctFromApex({
      treatments: [
        { bucket: 1, pct: 12 },
        { bucket: 2, pct: 8 },
        { bucket: 1, pct: 12 },
      ],
    }),
    20,
  );
});

test('guildPctFromApex : buckets distincts toujours sommés (règle documentée)', () => {
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: 1, pct: 30 }, { bucket: 2, pct: 30 }] }),
    60,
  );
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: 1, pct: 60 }, { bucket: 2, pct: 60 }] }),
    100,
    'plafond conservé',
  );
});

test('guildPctFromApex : bucket/pct textuels, contrôle et valeurs invalides', () => {
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: '3', pct: '7.5' }, { bucket: 3, pct: 2 }] }),
    7.5,
  );
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: 0, pct: 50 }, { bucket: 1, pct: 25 }] }),
    25,
    'le bucket 0 (contrôle) ne compte jamais',
  );
  assert.equal(guildPctFromApex({ treatments: [{ bucket: 1, pct: 'x' }, { bucket: 1 }] }), null);
});
