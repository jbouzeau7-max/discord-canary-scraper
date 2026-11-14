'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  guildPctFromApex,
  userPctFromGist,
  buildRolloutPercentageMaps,
  applyRolloutPercentages,
  loadRolloutPercentageMaps,
} = require('../src/lib/rollout_percentages');
const { normalizeExperiment } = require('../src/lib/experiment_state');

// --- Guild (apex) ---

test('guildPctFromApex : contrôle exclu, traitements sommés', () => {
  const e = {
    treatments: [
      { bucket: 0, pct: 4 },
      { bucket: 1, pct: 4 },
      { bucket: 2, pct: 4 },
      { bucket: 3, pct: 4 },
      { bucket: 4, pct: 4 },
    ],
  };
  assert.equal(guildPctFromApex(e), 16);
});

test('guildPctFromApex : 0 %, 100 %, bucket -1 et plafond', () => {
  assert.equal(guildPctFromApex({ treatments: [{ bucket: 1, pct: 0 }] }), 0);
  assert.equal(guildPctFromApex({ treatments: [{ bucket: 1, pct: 100 }] }), 100);
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: -1, pct: 50 }, { bucket: 1, pct: 50 }] }),
    50,
  );
  assert.equal(
    guildPctFromApex({ treatments: [{ bucket: 1, pct: 80 }, { bucket: 2, pct: 80 }] }),
    100,
  );
});

test('guildPctFromApex : aucune donnée exploitable → null', () => {
  assert.equal(guildPctFromApex(null), null);
  assert.equal(guildPctFromApex({}), null);
  assert.equal(guildPctFromApex({ treatments: [] }), null);
  assert.equal(guildPctFromApex({ treatments: [{ bucket: 0, pct: 50 }] }), null);
  assert.equal(guildPctFromApex({ treatments: [{ bucket: 1, pct: 'x' }] }), null);
});

// --- User (gist) ---

test('userPctFromGist : treatment.pct prioritaire', () => {
  assert.equal(userPctFromGist({ hasData: true, treatment: { pct: 10 } }), 10);
  assert.equal(userPctFromGist({ treatment: { pct: 0 } }), 0);
});

test('userPctFromGist : repli sur la somme des variantes treatment', () => {
  const e = {
    hasData: true,
    treatment: { pct: null },
    byVariant: {
      0: { pct: 4, role: 'control' },
      1: { pct: 3, role: 'treatment' },
      2: { pct: 3, role: 'treatment' },
    },
  };
  assert.equal(userPctFromGist(e), 6);
});

test('userPctFromGist : hasData false ou variantes non mesurées → null', () => {
  assert.equal(userPctFromGist({ hasData: false, treatment: { pct: 10 } }), null);
  assert.equal(userPctFromGist({ treatment: { pct: null }, byVariant: {} }), null);
  assert.equal(userPctFromGist({ byVariant: { 1: { pct: null, role: 'treatment' } } }), null);
  assert.equal(userPctFromGist(null), null);
});

// --- Maps ---

test('buildRolloutPercentageMaps : états apex/gist et entrées invalides', () => {
  const maps = buildRolloutPercentageMaps(
    {
      experiments: [
        { id: 'g1', treatments: [{ bucket: 1, pct: 25 }] },
        { id: 'g2', treatments: [{ bucket: 0, pct: 100 }] },
        null,
        { id: '' },
      ],
    },
    {
      acknowledged: {
        u1: { treatment: { pct: 12.5 } },
        u2: { hasData: false },
        u3: { byVariant: { 1: { pct: 7, role: 'treatment' } } },
      },
    },
  );
  assert.equal(maps.guild.get('g1'), 25);
  assert.equal(maps.guild.has('g2'), false);
  assert.equal(maps.user.get('u1'), 12.5);
  assert.equal(maps.user.has('u2'), false);
  assert.equal(maps.user.get('u3'), 7);
});

test('buildRolloutPercentageMaps : états absents → maps vides', () => {
  const maps = buildRolloutPercentageMaps(null, null);
  assert.equal(maps.guild.size, 0);
  assert.equal(maps.user.size, 0);
  const arr = buildRolloutPercentageMaps([{ id: 'x', treatments: [{ bucket: 1, pct: 5 }] }], {});
  assert.equal(arr.guild.get('x'), 5);
});

// --- Application ---

test('applyRolloutPercentages : remplit les deux champs d\'une expérience guild', () => {
  const e = normalizeExperiment({ id: 'g1', kind: 'guild', variations: [{}, {}] });
  const maps = { guild: new Map([['g1', 16]]), user: new Map([['g1', 50]]) };
  const out = applyRolloutPercentages(e, maps);
  assert.equal(out.guildPercentage.status, 'provided');
  assert.equal(out.guildPercentage.value, 16);
  assert.equal(out.guildPercentage.source, 'apex_rollouts');
  // Isolation : un % user ne va jamais sur une expérience guild.
  assert.equal(out.userPercentage.status, 'unknown');
  assert.notEqual(out.fingerprint, e.fingerprint);
});

test('applyRolloutPercentages : remplit le % user d\'une expérience user', () => {
  const e = normalizeExperiment({ id: 'u1', kind: 'user', variations: [{}, {}] });
  const out = applyRolloutPercentages(e, { guild: new Map(), user: new Map([['u1', 12.5]]) });
  assert.equal(out.userPercentage.value, 12.5);
  assert.equal(out.userPercentage.source, 'gist_user_rollouts');
  assert.equal(out.guildPercentage.status, 'unknown');
});

test('applyRolloutPercentages : un % fourni par le payload n\'est jamais écrasé', () => {
  const e = normalizeExperiment({ id: 'g1', kind: 'guild', percentage: 42, variations: [{}] });
  const out = applyRolloutPercentages(e, { guild: new Map([['g1', 16]]), user: new Map() });
  assert.equal(out.guildPercentage.value, 42);
  assert.equal(out.guildPercentage.source, 'payload');
});

test('applyRolloutPercentages : aucune donnée → objet inchangé', () => {
  const e = normalizeExperiment({ id: 'g1', kind: 'guild', variations: [{}] });
  assert.equal(applyRolloutPercentages(e, { guild: new Map(), user: new Map() }), e);
  assert.equal(applyRolloutPercentages(e, null), e);
  assert.equal(applyRolloutPercentages(null, null), null);
});

test('applyRolloutPercentages : expérience brute (mergedExps) enrichie', () => {
  const raw = { id: 'g9', kind: 'guild', variations: { 0: {}, 1: {} } };
  const out = applyRolloutPercentages(raw, { guild: new Map([['g9', 0]]), user: new Map() });
  assert.equal(out.guildPercentage.status, 'provided');
  assert.equal(out.guildPercentage.value, 0);
});

// --- Chargement disque ---

test('loadRolloutPercentageMaps : lit les deux fichiers data/', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rollpct-'));
  await fs.writeJson(path.join(dir, 'apex_rollouts.json'), {
    experiments: [{ id: 'g1', treatments: [{ bucket: 1, pct: 30 }] }],
  });
  await fs.writeJson(path.join(dir, 'gist_user_rollouts.json'), {
    acknowledged: { u1: { treatment: { pct: 8 } } },
  });
  const maps = await loadRolloutPercentageMaps(dir);
  assert.equal(maps.guild.get('g1'), 30);
  assert.equal(maps.user.get('u1'), 8);
});

test('loadRolloutPercentageMaps : fichiers absents ou corrompus → maps vides', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rollpct-'));
  assert.equal((await loadRolloutPercentageMaps(dir)).guild.size, 0);
  await fs.writeFile(path.join(dir, 'apex_rollouts.json'), '{oops');
  await fs.writeFile(path.join(dir, 'gist_user_rollouts.json'), '[]');
  const maps = await loadRolloutPercentageMaps(dir);
  assert.equal(maps.guild.size, 0);
  assert.equal(maps.user.size, 0);
});
