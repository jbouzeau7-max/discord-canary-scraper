'use strict';

// A permissive configured ratio must not let a tiny incomplete asset batch pass.
process.env.MIN_DOWNLOAD_SUCCESS_RATIO = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  computeExpDiff,
  computeMapDiff,
  selectNextMapBaseline,
  MIN_EXP_FOR_DIFF,
} = require('../src/index');
const {
  downloadList,
  getDownloadStats,
  resetDownloadStats,
} = require('../src/lib/download');

function exp(i, label = 'old') {
  return {
    id: `2024-01_exp_${i}`,
    kind: 'guild',
    type: 'guild',
    label,
    variations: { 0: { id: 0 }, 1: { id: 1 } },
  };
}

function expSnapshot(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const item = exp(i);
      return [item.id, item];
    }),
  );
}

function map(count, prefix = 'key') {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}${i}`, `value-${i}`]),
  );
}

function response(status, body = Buffer.from('x'.repeat(100))) {
  const stream = (async function* () {
    if (body.length) yield body;
  })();
  stream.destroy = () => {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: stream,
  };
}

const JS_BODY = Buffer.from('function chunk(){ return "canary"; }'.repeat(4));

// 1
test('partial experiments vides ne remplacent pas une baseline complète', () => {
  const previous = expSnapshot(100);
  const result = computeExpDiff([], previous, new Set());
  assert.deepEqual(result.nextExpSnap, previous);
  assert.equal(result.coverage.reliable, false);
});

// 2
test('partial experiments sous MIN_EXP_FOR_DIFF conservent la baseline', () => {
  const previous = expSnapshot(100);
  const current = Array.from({ length: MIN_EXP_FOR_DIFF - 1 }, (_, i) => exp(i));
  assert.deepEqual(computeExpDiff(current, previous, new Set()).nextExpSnap, previous);
});

// 3
test('une modification vue dans un extrait incomplet reste à annoncer ensuite', () => {
  const previous = expSnapshot(100);
  const current = Array.from({ length: 20 }, (_, i) => exp(i, i === 0 ? 'changed' : 'old'));
  const result = computeExpDiff(current, previous, new Set());
  assert.equal(result.expDiff.modified.length, 0);
  assert.equal(result.nextExpSnap[exp(0).id].label, 'old');
});

// 4
test('un nouvel ID trouvé dans un extrait incomplet ne devient pas connu par la baseline', () => {
  const previous = expSnapshot(100);
  const current = Array.from({ length: 20 }, (_, i) => exp(i));
  current.push(exp(500));
  const result = computeExpDiff(current, previous, new Set());
  assert.equal(result.nextExpSnap[exp(500).id], undefined);
});

// 5
test('une omission partielle ne devient pas une suppression persistée', () => {
  const previous = expSnapshot(100);
  const current = Array.from({ length: 20 }, (_, i) => exp(i));
  const result = computeExpDiff(current, previous, new Set());
  assert.equal(result.expDiff.removed.length, 0);
  assert.ok(result.nextExpSnap[exp(99).id]);
});

// 6
test('la prochaine extraction complète rapporte ajout, modification et suppression différés', () => {
  const previous = expSnapshot(100);
  const partial = Array.from({ length: 25 }, (_, i) => exp(i, i === 0 ? 'changed' : 'old'));
  partial.push(exp(500));
  const partialResult = computeExpDiff(partial, previous, new Set());
  const nextFull = Array.from({ length: 99 }, (_, i) => exp(i, i === 0 ? 'changed' : 'old'));
  nextFull.push(exp(500));
  const fullResult = computeExpDiff(nextFull, partialResult.nextExpSnap, new Set());
  assert.ok(fullResult.expDiff.added.some((item) => item.id === exp(500).id));
  assert.ok(fullResult.expDiff.modified.some((item) => item.id === exp(0).id));
  assert.ok(fullResult.expDiff.removed.some((item) => item.id === exp(99).id));
});

// 7
test('une baseline de 39 expériences reste insuffisante même si l’extraction est grande', () => {
  const previous = expSnapshot(39);
  const current = Array.from({ length: MIN_EXP_FOR_DIFF }, (_, i) => exp(i));
  assert.deepEqual(computeExpDiff(current, previous, new Set()).nextExpSnap, previous);
});

// 8
test('la borne basse de baseline conserve un extract juste sous le seuil courant', () => {
  const previous = expSnapshot(40);
  const current = Array.from({ length: MIN_EXP_FOR_DIFF - 1 }, (_, i) => exp(i));
  assert.deepEqual(computeExpDiff(current, previous, new Set()).nextExpSnap, previous);
});

// 9
test('exactement MIN_EXP_FOR_DIFF permet de promouvoir le snapshot courant', () => {
  const previous = expSnapshot(40);
  const current = Array.from({ length: MIN_EXP_FOR_DIFF }, (_, i) => exp(i));
  const promoted = computeExpDiff(current, previous, new Set()).nextExpSnap;
  assert.equal(Object.keys(promoted).length, current.length);
  assert.equal(promoted[exp(0).id].label, 'old');
  assert.equal(promoted[exp(MIN_EXP_FOR_DIFF - 1).id].variationCount, 2);
});

// 10
test('les IDs hash et éléments invalides ne contaminent pas le snapshot partiel', () => {
  const previous = expSnapshot(100);
  const current = [exp(0), { id: 'hash:abcd' }, null, {}, 'invalid'];
  assert.deepEqual(computeExpDiff(current, previous, new Set()).nextExpSnap, previous);
});

// 11
test('un duplicate ID partiel ne modifie pas la valeur de baseline acquittée', () => {
  const previous = expSnapshot(100);
  const current = [exp(0, 'first'), exp(0, 'second')];
  const result = computeExpDiff(current, previous, new Set());
  assert.equal(result.nextExpSnap[exp(0).id].label, 'old');
});

// 12
test('199 strings n’avancent pas une baseline strings valide de 300 entrées', () => {
  const previous = map(300);
  const current = map(199);
  assert.deepEqual(selectNextMapBaseline(previous, current, 200), previous);
});

// 13
test('49 routes n’avancent pas une baseline routes valide', () => {
  const previous = map(80, 'route');
  const current = map(49, 'route');
  assert.deepEqual(selectNextMapBaseline(previous, current, 50), previous);
});

// 14
test('un résultat vide préserve les données antérieures plutôt que de vider l’état', () => {
  const previous = { key: 'old' };
  assert.deepEqual(selectNextMapBaseline(previous, {}, 1), previous);
});

// 15
test('exactement 200 strings est assez complet pour devenir le nouveau snapshot', () => {
  const current = map(200);
  assert.deepEqual(selectNextMapBaseline(map(250), current, 200), current);
});

// 16
test('exactement 50 routes est assez complet pour devenir le nouveau snapshot', () => {
  const current = map(50, 'route');
  assert.deepEqual(selectNextMapBaseline(map(80, 'route'), current, 50), current);
});

// 17
test('une entrée sous le seuil strings est conservée pour le run suivant', () => {
  const previous = map(250);
  assert.deepEqual(selectNextMapBaseline(previous, map(199), 200), previous);
});

// 18
test('une entrée sous le seuil routes est conservée pour le run suivant', () => {
  const previous = map(60, 'route');
  assert.deepEqual(selectNextMapBaseline(previous, map(49, 'route'), 50), previous);
});

// 19
test('un baseline vide ne se remplit pas avec un seed strings incomplet', () => {
  assert.deepEqual(selectNextMapBaseline({}, map(199), 200), {});
});

// 20
test('un ancien baseline tableau invalide est ignoré', () => {
  assert.deepEqual(selectNextMapBaseline(['bad'], map(10), 20), {});
});

// 21
test('un résultat extrait tableau invalide ne remplace pas le baseline valide', () => {
  const previous = map(40, 'route');
  assert.deepEqual(selectNextMapBaseline(previous, ['bad'], 1), previous);
});

// 22
test('après un extrait strings incomplet, le diff complet retrouve changement et suppression', () => {
  const previous = map(100);
  const partial = map(70);
  partial.key0 = 'changed';
  const retained = selectNextMapBaseline(previous, partial, 200);
  const complete = map(80);
  complete.key0 = 'changed';
  const diff = computeMapDiff(retained, complete);
  assert.equal(diff.modified.key0, 'changed');
  assert.equal(Object.keys(diff.removed).length, 20);
});

// 23
test('après un extrait routes incomplet, les nouvelles routes sont détectées au run complet', () => {
  const previous = map(80, 'route');
  const retained = selectNextMapBaseline(previous, map(30, 'route'), 50);
  const complete = { ...previous, '/api/new': 'v1' };
  const diff = computeMapDiff(retained, complete);
  assert.equal(diff.added['/api/new'], 'v1');
});

// 24
test('un seuil non numérique échoue fermé et préserve le baseline', () => {
  const previous = { a: 'old' };
  assert.deepEqual(selectNextMapBaseline(previous, { a: 'new' }, NaN), previous);
});

// 25
test('la sélection du snapshot ne modifie ni le baseline ni l’extraction', () => {
  const previous = Object.freeze({ a: 'old', b: 'keep' });
  const current = Object.freeze({ a: 'new' });
  const selected = selectNextMapBaseline(previous, current, 2);
  assert.equal(selected, previous);
  assert.deepEqual(previous, { a: 'old', b: 'keep' });
  assert.deepEqual(current, { a: 'new' });
});

// 26
test('une map complète amorce correctement un baseline initial vide', () => {
  const current = map(200);
  assert.deepEqual(selectNextMapBaseline({}, current, 200), current);
});

async function runTinyBatch(size, failedIndex) {
  resetDownloadStats();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canary-tiny-batch-'));
  const urls = Array.from(
    { length: size },
    (_, i) => `https://cdn.test/assets/chunk-${i}.js`,
  );
  try {
    await assert.rejects(
      downloadList(urls, dir, true, {
        fetch: async (url) =>
          url.includes(`chunk-${failedIndex}.js`)
            ? response(404, Buffer.from('not found'))
            : response(200, JS_BODY),
      }),
      /download success ratio/,
    );
    assert.equal(getDownloadStats().jobs, size);
    assert.equal(getDownloadStats().failed, 1);
  } finally {
    await fs.remove(dir);
  }
}

// 27
test('un échec bloque un lot d’un seul asset même avec ratio configuré à zéro', async () => {
  await runTinyBatch(1, 0);
});

// 28
test('un échec bloque un lot de deux assets même si l’autre réussit', async () => {
  await runTinyBatch(2, 0);
});

// 29
test('un échec bloque un lot de trois assets sans avaler le chunk manquant', async () => {
  await runTinyBatch(3, 1);
});

// 30
test('un échec bloque un lot de quatre assets malgré 75 pour cent de succès', async () => {
  await runTinyBatch(4, 2);
});

// 31
test('une liste sans assets valides ne déclenche pas de faux échec', async () => {
  resetDownloadStats();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canary-empty-batch-'));
  try {
    await downloadList(['https://cdn.test/other.js', 'invalid'], dir, true, {
      fetch: async () => response(200, JS_BODY),
    });
    assert.equal(getDownloadStats().jobs, 0);
    assert.equal(getDownloadStats().failed, 0);
  } finally {
    await fs.remove(dir);
  }
});
