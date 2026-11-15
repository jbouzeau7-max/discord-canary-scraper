'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGuildExperiment, describeFilters } = require('../src/experiment_rollouts');
const { fetchRawGist } = require('../src/user_rollout_comparison');

test('parseGuildExperiment : plages demi-ouvertes exactes [0, 10000) sans off-by-one', () => {
  const full = parseGuildExperiment([100, '2026-01_full', 1, [[[[1, [{ s: 0, e: 10000 }]]], []]]]);
  assert.equal(full.percentage, 100);
  assert.equal(full.coverage, 10000);
  assert.equal(full.status, 'full_rollout');

  const onePos = parseGuildExperiment([101, '2026-01_min', 1, [[[[1, [{ s: 0, e: 1 }]]], []]]]);
  assert.equal(onePos.percentage, 0.01, '1 position / 10000 = 0,01 % (pas 0,02 %)');
  assert.equal(onePos.coverage, 1);
  assert.equal(onePos.status, 'partial');

  const gapped = parseGuildExperiment([
    102,
    '2026-01_gap',
    1,
    [[[[1, [{ s: 0, e: 1 }, { s: 2, e: 3 }]]], []]],
  ]);
  assert.equal(gapped.percentage, 0.02, 'le trou [1,2) n’est pas fusionné');
  assert.deepEqual(gapped.treatmentRanges, [[0, 1], [2, 3]]);
});

test('parseGuildExperiment : 0 %, bucket None (-1) / Control (0), données vides et hors bornes', () => {
  const zero = parseGuildExperiment([200, '2026-01_none', 0, [[[[-1, [{ s: 0, e: 10000 }]], [0, [{ s: 0, e: 5000 }]]], []]]]);
  assert.equal(zero.percentage, 0);
  assert.equal(zero.coverage, 0);
  assert.equal(zero.status, 'not_started');

  const empty = parseGuildExperiment([201, '2026-01_empty', 0, []]);
  assert.equal(empty.percentage, 0);
  assert.equal(empty.status, 'not_started');

  const clamped = parseGuildExperiment([
    202,
    '2026-01_clamp',
    2,
    [[[[1, [{ s: -500, e: 2500 }, [2000, 5000], { start: 9500, end: 25000 }, { s: 500, e: 100 }, null, 'bad']]], []]],
  ]);
  // Les positions valides restent visibles pour le diagnostic, mais les plages
  // hors bornes / malformées interdisent de publier un pourcentage incomplet.
  assert.equal(clamped.percentage, null);
  assert.equal(clamped.coverage, 5500);
  assert.equal(clamped.status, 'unknown');
  assert.equal(clamped.dataStatus, 'malformed');

  assert.equal(parseGuildExperiment(null), null);
  assert.equal(parseGuildExperiment([1, 2]), null);
});

test('describeFilters : résume les filtres connus et tolère les entrées malformées', () => {
  assert.equal(describeFilters([]), 'all');
  assert.equal(describeFilters(null), 'all');
  assert.equal(describeFilters([[1604612045, [[1, 'COMMUNITY']]]]), 'feature:COMMUNITY');
  assert.equal(describeFilters([null, 'bad', []]), 'all');
});

test('fetchRawGist : repli anonyme automatique si le jeton GitHub renvoie 403', async () => {
  const authHeaders = [];
  const fakeFetch = async (url, opts = {}) => {
    if (url.includes('api.github.com/gists/')) {
      authHeaders.push(opts.headers && opts.headers.Authorization);
      if (opts.headers && opts.headers.Authorization) {
        return { ok: false, status: 403 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          updated_at: '2026-11-11T00:00:00Z',
          html_url: 'https://gist.github.com/x/g1',
          history: [{ version: 'rev123' }],
          files: { 'rollouts.json': { filename: 'rollouts.json', raw_url: 'https://gist.example/raw' } },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: '2026-10_exp', variants: [] }],
    };
  };
  const res = await fetchRawGist('g1', 'ghs_installation_token', fakeFetch);
  assert.equal(authHeaders.length, 2);
  assert.equal(authHeaders[0], 'Bearer ghs_installation_token');
  assert.equal(authHeaders[1], undefined);
  assert.equal(res.revision, 'rev123');
  assert.equal(res.data.length, 1);
});

test('require(experiment_rollouts) : ne lance pas main() automatiquement (import sûr)', () => {
  const mod = require('../src/experiment_rollouts');
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.parseGuildExperiment, 'function');
  assert.equal(typeof mod.describeFilters, 'function');
});

test('fetchRawGist : repli anonyme sur 401 également et tolère files absent', async () => {
  let calls = 0;
  const fakeFetch = async (url, opts = {}) => {
    calls++;
    if (url.includes('api.github.com/gists/')) {
      if (opts.headers && opts.headers.Authorization) return { ok: false, status: 401 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: null }),
      };
    }
    return { ok: false, status: 500 };
  };
  await assert.rejects(() => fetchRawGist('g2', 'bad_tok', fakeFetch), /gist sans fichier/);
  assert.equal(calls, 2);
});
