'use strict';

/**
 * Régressions du pipeline principal Canary :
 *  - la mémoire « déjà annoncé » (known_string_keys / known_route_keys) doit
 *    être plafonnée par RÉCENCE, pas par ordre alphabétique ;
 *  - la référence last_extract_experiments doit conserver les pourcentages,
 *    sinon la comparaison « modifiée » ne peut pas distinguer un vrai
 *    changement de rollout d'un artefact de sérialisation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const index = require('../src/index.js');
const experimentState = require('../src/lib/experiment_state');

const mkExp = (i, pct) => ({
  id: 'exp_' + i,
  type: 'user',
  variations: { 0: { label: 'control' }, 1: { label: 'treat' } },
  ...(pct == null ? {} : { percentage: pct }),
});

const manyExps = (n, pct) => Array.from({ length: n }, (_, i) => mkExp(i, pct));

test('capKnownIds garde les clés les plus récentes, pas les premières de l’alphabet', () => {
  // Insertion : trois clés anciennes (chiffres) puis une récente.
  const known = new Set(['0aaaaa', '1bbbbb', '2ccccc', 'zzzzzz']);
  assert.deepEqual(index.capKnownIds(known, 2), ['2ccccc', 'zzzzzz']);
  // Un tri AVANT la sélection aurait gardé '0aaaaa' et '1bbbbb'.
  assert.ok(!index.capKnownIds(known, 2).includes('0aaaaa'));
});

test('capKnownIds déduplique, filtre le vide et trie la sortie', () => {
  const out = index.capKnownIds(['bbb', 'aaa', 'bbb', '', null], 10);
  assert.deepEqual(out, ['aaa', 'bbb']);
  assert.deepEqual(index.capKnownIds([], 10), []);
  // Plafond <= 0 = pas de plafond (contrat de trimRecent), jamais une purge totale.
  assert.deepEqual(index.capKnownIds(['a'], 0), ['a']);
});

test('capKnownIds n’évince rien sous le plafond configuré', () => {
  const ids = Array.from({ length: 100 }, (_, i) => 'k' + String(i).padStart(3, '0'));
  assert.equal(index.capKnownIds(ids, index.KNOWN_STR_MAX_KEYS).length, 100);
});

test('expSnapshot conserve les pourcentages (référence last_extract)', () => {
  const snap = index.expSnapshot(mkExp(1, 25));
  assert.deepEqual(
    { status: snap.userPercentage.status, value: snap.userPercentage.value },
    { status: 'provided', value: 25 },
  );
  assert.equal(index.expSnapshot(mkExp(2)).userPercentage, null);
  assert.equal(index.expSnapshotPercentage({ status: 'unknown', value: null }), null);
  assert.equal(index.expSnapshotPercentage({ status: 'provided', value: 120 }), null);
});

test('un payload inchangé ne produit AUCUNE modification (régression)', () => {
  const findings = manyExps(100, 25);
  const previous = {};
  for (const e of findings) previous[e.id] = index.expSnapshot(e);
  const res = index.computeExpDiff(
    findings,
    previous,
    new Set(findings.map((e) => e.id)),
    { removedIds: new Set() },
  );
  assert.equal(res.coverage.reliable, true);
  assert.equal(res.expDiff.added.length, 0);
  // Avant le correctif : 100 « modifiées » à chaque build (référence sans %).
  assert.equal(res.expDiff.modified.length, 0);
});

test('un vrai changement de pourcentage reste annoncé, avec l’avant/après', () => {
  const findings = manyExps(100, 25);
  const previous = {};
  for (const e of findings) previous[e.id] = index.expSnapshot(e);
  const current = findings.map((e) => (e.id === 'exp_0' ? mkExp(0, 40) : e));
  const res = index.computeExpDiff(
    current,
    previous,
    new Set(findings.map((e) => e.id)),
    { removedIds: new Set() },
  );
  assert.equal(res.expDiff.modified.length, 1);
  const row = res.expDiff.modified[0];
  assert.equal(row.id, 'exp_0');
  assert.equal(row.userPercentage.value, 40);
  assert.equal(row._before.userPercentage.value, 25);
});

test('une variation de pourcentage sous le seuil 0,5 pt n’est pas annoncée', () => {
  const findings = manyExps(100, 25);
  const previous = {};
  for (const e of findings) previous[e.id] = index.expSnapshot(e);
  const current = findings.map((e) => (e.id === 'exp_0' ? mkExp(0, 25.2) : e));
  const res = index.computeExpDiff(
    current,
    previous,
    new Set(findings.map((e) => e.id)),
    { removedIds: new Set() },
  );
  assert.equal(res.expDiff.modified.length, 0);
});

test('empreinte stable après aller-retour de sérialisation (snapshot → normalize)', () => {
  const exp = mkExp(3, 12.5);
  const snap = index.expSnapshot(exp);
  const reloaded = experimentState.normalizeExperiment(snap);
  assert.equal(reloaded.fingerprint, snap.fp);
  assert.equal(reloaded.userPercentage.value, 12.5);
  // Les pourcentages d'une audience différente ne sont pas réattribués.
  const guildSnap = { id: 'g1', kind: 'guild', userPercentage: { status: 'provided', value: 30 } };
  const g = experimentState.normalizeExperiment(guildSnap);
  assert.equal(g.guildPercentage.status, 'unknown');
  assert.equal(g.userPercentage.status, 'unknown');
});

test('un pourcentage hors bornes dans un snapshot n’est jamais repris', () => {
  const bad = { id: 'x1', kind: 'user', userPercentage: { status: 'provided', value: 150 } };
  const n = experimentState.normalizeExperiment(bad);
  assert.equal(n.userPercentage.status, 'unknown');
});
