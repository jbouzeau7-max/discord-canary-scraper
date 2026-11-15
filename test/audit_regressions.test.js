'use strict';

/**
 * Régressions issues de l'audit : bornes hors espace, hashes de filtres,
 * entrées malformées, clés __proto__, clusters isolés et perte de baseline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const {
  intervalsToPct,
  decodeGuildExperiment,
} = require('../src/lib/guild_decode');
const {
  describeFilters,
  fallbackGuildRollouts,
} = require('../src/experiment_rollouts');
const { decodeGuildWire } = require('../src/apex_rollouts');
const {
  coveragePercent,
  intervalsCoverage,
  stableStringify,
  reconstructBucketRanges,
} = require('../src/lib/rollout_math');
const { computeExperiment } = require('../src/lib/gist_rollouts');
const {
  diffDismissible,
  processDismissibleContent,
  loadState,
} = require('../src/lib/dismissible_content');
const { sameOutageMap } = require('../src/user_rollouts');

test('guild_decode : les plages hors [0,10000) sont ramenées dans l’espace', () => {
  assert.equal(intervalsToPct([[9500, 20000]]), 5);
  assert.equal(intervalsToPct([[-500, 500]]), 5);
  // [0,500) ∪ [400,600) = [0,600) → 6 %, et non 16 %.
  assert.equal(intervalsToPct([[-1000, 500], [400, 600]]), 6);
  assert.equal(intervalsToPct([null, {}, [NaN, 1], ['x', 2]]), 0);
});

test('guild_decode : populations/overrides malformés ne font pas lever', () => {
  for (const tuple of [
    [1, 'x', 1, { a: 1 }, []],
    [1, 'x', 1, [], {}],
    [1, 'x', 1, [null], [null]],
  ]) {
    assert.doesNotThrow(() => decodeGuildExperiment(tuple, new Map()));
  }
  assert.equal(
    decodeGuildExperiment([1, '', 1, [], []], { 1: 'nom-local' }).id,
    'nom-local',
  );
});

test('describeFilters : hashes Discord corrects et features imbriquées', () => {
  // murmur3('guild_id_range') = 2404720969
  // murmur3('guild_member_count_range') = 2918402255
  assert.equal(
    describeFilters([[2404720969, [10, 100]]]),
    'id_range:[10,100]',
  );
  assert.equal(
    describeFilters([[2918402255, { min: 1000, max: 2000 }]]),
    'member_count:{"min":1000,"max":2000}',
  );
  assert.equal(
    describeFilters([
      [1604612045, [[1183251248, ['GUILD_ROLE_SUBSCRIPTIONS']]]],
    ]),
    'feature:GUILD_ROLE_SUBSCRIPTIONS',
  );
});

test('apex decodeGuildWire : compte les overrides au format tableau', () => {
  const e = decodeGuildWire(
    [1, 'x', 1, [], [[1, ['a', 'b']]]],
    new Map(),
  );
  assert.equal(e.overrideIdCount, 2);
});

test('fallbackGuildRollouts : une entrée malformée sans baseline est retirée', () => {
  const r = fallbackGuildRollouts(
    { guildExperiments: [] },
    [
      {
        id: 'exp',
        hash: 1,
        percentage: null,
        dataStatus: 'malformed',
      },
    ],
  );
  assert.deepEqual(r, { list: [], stale: false });
});

test('rollout_math : couverture clamps les bornes négatives', () => {
  assert.equal(intervalsCoverage([[-100, 100]]), 101);
  assert.equal(coveragePercent([[-100, 100]]), 1.01);
  assert.equal(coveragePercent([[0, 10000]]), 100);
});

test('rollout_math : les clusters d’un point ne disparaissent plus', () => {
  const rec = reconstructBucketRanges([0, 1, 2, 3, 4, 5, 6, 1000]);
  assert.ok(rec);
  assert.equal(rec.clusters, 2);
  assert.equal(rec.ranges.length, 2);
  assert.ok(rec.pct > 0);
});

test('stableStringify : une clé __proto__ reste une propriété propre', () => {
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}');
  const withoutProto = JSON.parse('{"a":1}');
  assert.notEqual(stableStringify(withProto), stableStringify(withoutProto));
});

test('gist_rollouts : les rôles sont normalisés (casse/espaces)', () => {
  const c = computeExperiment({
    id: 'exp',
    variants: [{ variant: 1, role: ' Treatment ', ranges: ['0 - 5000'] }],
  });
  assert.equal(c.treatment.pct, 50);
  assert.ok(!c.flags.includes('unknown_role'));
});

test('dismissible : une clé __proto__ ne disparaît pas du diff', () => {
  const cur = JSON.parse('{"__proto__":1}');
  const diff = diffDismissible(cur, {});
  assert.equal(
    Object.prototype.hasOwnProperty.call(diff.added, '__proto__'),
    true,
  );
});

test('dismissible : sans webhook, la baseline n’avance pas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissible-audit-'));
  const base = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => ['ITEM_' + i, i]),
  );
  const seed = await processDismissibleContent({
    dataDir: dir,
    current: base,
    buildNumber: 1,
    webhookUrl: null,
    isSeed: true,
  });
  assert.equal(seed.notified, false);
  const next = { ...base, NEW_ONE: 99 };
  const r = await processDismissibleContent({
    dataDir: dir,
    current: next,
    buildNumber: 2,
    webhookUrl: null,
    isSeed: false,
  });
  assert.equal(r.notified, false);
  assert.ok(!Object.prototype.hasOwnProperty.call((await loadState(dir)).data, 'NEW_ONE'));
});

test('sameOutageMap : même taille mais indices différents → non identiques', () => {
  assert.equal(
    sameOutageMap(
      new Map([['a', new Set([1, 2])]]),
      new Map([['a', new Set([1, 3])]]),
    ),
    false,
  );
  assert.equal(
    sameOutageMap(
      new Map([['a', new Set([1, 2])]]),
      new Map([['a', new Set([1, 2])]]),
    ),
    true,
  );
});

test('Pages : chaque JSON chargé par docs/*.js est copié dans docs/data', () => {
  const root = path.join(__dirname, '..');
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'pages.yml'),
    'utf8',
  );
  const referenced = new Set();
  for (const file of fs.readdirSync(path.join(root, 'docs'))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(root, 'docs', file), 'utf8');
    for (const m of src.matchAll(/\.\/data\/([A-Za-z0-9_-]+\.json)/g)) {
      referenced.add(m[1]);
    }
  }
  for (const name of referenced) {
    const stem = name.replace(/\.json$/, '');
    assert.ok(
      new RegExp(`(^|\\s)${stem}(\\s|;)`).test(workflow),
      `data/${name} chargé par docs mais absent de pages.yml`,
    );
  }
});
