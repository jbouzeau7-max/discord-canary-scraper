'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExperiment,
  assessCoverage,
  variationKeysOnly,
  isMeaningfulModification,
} = require('../src/lib/experiment_state');

test('normalizeExperiment : variations en tableau → clés et compteur conservés', () => {
  const e = normalizeExperiment({
    id: '2025-01_array_exp',
    kind: 'guild',
    variations: [{ id: 0 }, { id: 1 }, { id: 2 }],
  });
  assert.equal(e.variationCount, 3);
  assert.equal(e.variationSource, 'variations_array');
  assert.deepEqual(variationKeysOnly(e), ['0', '1', '2']);
});

test('normalizeExperiment : objet variations inchangé', () => {
  const e = normalizeExperiment({
    id: '2025-01_obj_exp',
    kind: 'user',
    variations: { 0: {}, 1: {} },
  });
  assert.equal(e.variationCount, 2);
  assert.equal(e.variationSource, 'variations');
});

test('normalizeExperiment : ids invalides refusés', () => {
  assert.equal(normalizeExperiment(null), null);
  assert.equal(normalizeExperiment({ id: '' }), null);
  assert.equal(normalizeExperiment({ id: 'hash:abc' }), null);
});

test('isMeaningfulModification : variationCount différent détecté', () => {
  const a = normalizeExperiment({ id: 'e1', kind: 'guild', variations: [{}, {}] });
  const b = normalizeExperiment({ id: 'e1', kind: 'guild', variations: [{}, {}, {}] });
  assert.equal(isMeaningfulModification(a, b), true);
});

test('isMeaningfulModification : transitions unknown/known conservent zéro comme valeur', () => {
  const unknown = { id: 'e1', kind: 'guild', guildPercentage: { status: 'unknown', value: null } };
  const zero = { id: 'e1', kind: 'guild', guildPercentage: { status: 'active', value: 0 } };
  const known = { id: 'e1', kind: 'guild', guildPercentage: { status: 'active', value: 25 } };
  assert.equal(isMeaningfulModification(unknown, zero), true);
  assert.equal(isMeaningfulModification(unknown, known), true);
  assert.equal(isMeaningfulModification(zero, unknown), true);
  assert.equal(isMeaningfulModification(zero, { ...zero, guildPercentage: { status: 'active', value: 0.1 } }), false);
});

test('assessCoverage : env invalide ne bloque pas la couverture', () => {
  const saved = {
    a: process.env.EXP_COVERAGE_MIN_RATIO,
    b: process.env.EXP_COVERAGE_MAX_RATIO,
    c: process.env.EXP_COVERAGE_MIN_RETENTION,
  };
  process.env.EXP_COVERAGE_MIN_RATIO = 'abc';
  process.env.EXP_COVERAGE_MAX_RATIO = '';
  process.env.EXP_COVERAGE_MIN_RETENTION = 'NaN';
  try {
    const cov = assessCoverage({ currentCount: 100, previousCount: 100, extractionStatus: 'complete' });
    assert.equal(cov.reliable, true);
    assert.equal(cov.reason, 'ok');
    assert.equal(cov.minRatio, 0.8);
    assert.equal(cov.maxRatio, 1.25);
    assert.equal(cov.minRetention, 0.75);
  } finally {
    for (const [k, v] of Object.entries({
      EXP_COVERAGE_MIN_RATIO: saved.a,
      EXP_COVERAGE_MAX_RATIO: saved.b,
      EXP_COVERAGE_MIN_RETENTION: saved.c,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('assessCoverage : env valides respectées', () => {
  const saved = process.env.EXP_COVERAGE_MIN_RATIO;
  process.env.EXP_COVERAGE_MIN_RATIO = '0.5';
  try {
    const cov = assessCoverage({ currentCount: 60, previousCount: 100, extractionStatus: 'complete' });
    assert.equal(cov.minRatio, 0.5);
    assert.equal(cov.reliable, true);
  } finally {
    if (saved === undefined) delete process.env.EXP_COVERAGE_MIN_RATIO;
    else process.env.EXP_COVERAGE_MIN_RATIO = saved;
  }
});

test('assessCoverage : extraction incomplète jamais fiable', () => {
  const cov = assessCoverage({ currentCount: 100, previousCount: 100, extractionStatus: 'partial' });
  assert.equal(cov.reliable, false);
  assert.equal(cov.reason, 'extraction_not_complete');
});

test('assessCoverage : bootstrap vide / non vide', () => {
  assert.equal(assessCoverage({ currentCount: 0, previousCount: 0, extractionStatus: 'complete' }).reliable, false);
  assert.equal(assessCoverage({ currentCount: 10, previousCount: 0, extractionStatus: 'complete' }).reliable, true);
});

test('assessCoverage : churn complet à taille identique est dégradé, réordonnancement reste fiable', () => {
  const previousIds = Array.from({ length: 100 }, (_, i) => `exp-${i}`);
  const disjoint = Array.from({ length: 100 }, (_, i) => `other-${i}`);
  const churn = assessCoverage({
    currentCount: 100,
    previousCount: 100,
    extractionStatus: 'complete',
    currentIds: disjoint,
    previousIds,
  });
  assert.equal(churn.reliable, false);
  assert.equal(churn.reason, 'retention_too_low');
  assert.equal(churn.retentionRatio, 0);

  const reordered = assessCoverage({
    currentCount: 100,
    previousCount: 100,
    extractionStatus: 'complete',
    currentIds: [...previousIds].reverse(),
    previousIds,
  });
  assert.equal(reordered.reliable, true);
  assert.equal(reordered.retentionRatio, 1);
});
