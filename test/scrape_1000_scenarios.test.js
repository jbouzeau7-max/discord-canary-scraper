'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeJsStringLiteral, extractExperiments, extractRoutes } = require('../src/lib/extract');
const { normalizeExperiments } = require('../src/lib/state');
const { assessCoverage } = require('../src/lib/experiment_state');
const { normalizeAssetUrl } = require('../src/lib/asset_url');

const CASES = 200;

// Six bounded deterministic generators × 200 cases = 1,200 reproducible cases.
test('1,200 scénarios déterministes de robustesse du scraper Canary', async (t) => {
  await t.test('200 escapes JavaScript malformés restent non fatals', () => {
    const malformed = ['\\x', '\\xGG', '\\u', '\\u1', '\\u{}', '\\u{110000}', '\\u{FFFFFF}', 'trailing\\'];
    for (let i = 0; i < CASES; i++) {
      const input = malformed[i % malformed.length] + String.fromCharCode(32 + ((i * 37) % 90)) + `_${i}`;
      assert.doesNotThrow(() => decodeJsStringLiteral(input), `escape case ${i}`);
    }
  });

  await t.test('200 configurations d’expérience avec délimiteurs dans les valeurs', () => {
    for (let i = 0; i < CASES; i++) {
      const month = String((i % 12) + 1).padStart(2, '0');
      const id = `2026-${month}_generated_case_${i}_safe`;
      const source = `(0,i.C)({kind:"user",id:"${id}",defaultConfig:{text:"value } ] { ${i}",enabled:!0},variations:{0:{label:"} ] { ${i}",enabled:!0},1:{count:${i}}}});`;
      const result = new Map();
      assert.doesNotThrow(() => extractExperiments(source, result), `experiment case ${i}`);
      const exp = result.get(id);
      assert.ok(exp, `experiment ${i} extracted`);
      assert.equal(exp.defaultConfig.enabled, true);
      assert.equal(exp.defaultConfig.text, `value } ] { ${i}`);
      assert.deepEqual(Object.keys(exp.variations), ['0', '1']);
      assert.equal(exp.variations['0'].label, `} ] { ${i}`);
    }
  });

  await t.test('200 routes restent normalisées sans sortir de l’objet de résultats', () => {
    for (let i = 0; i < CASES; i++) {
      const key = `ROUTE_${i}`;
      const input = `Routes={${key}:"/guilds/\${id}/members",OTHER_${i}:"/channels/\${id}/messages"};`;
      const out = {};
      assert.doesNotThrow(() => extractRoutes(input, out), `route case ${i}`);
      assert.equal(out[key], '/guilds/:param/members');
      assert.equal(out[`OTHER_${i}`], '/channels/:param/messages');
      assert.ok(Object.values(out).every((value) => typeof value === 'string' && value.startsWith('/')));
    }
  });

  await t.test('200 états hétérogènes ne produisent que des IDs scalaires uniques', () => {
    for (let i = 0; i < CASES; i++) {
      const input = [
        { id: ` id-${i} ` },
        { id: `id-${i}` },
        { id: i },
        { id: 0 },
        { id: { nested: i } },
        { id: [i] },
        { id: true },
        { id: Infinity },
        { title: 'missing' },
        null,
      ];
      const out = normalizeExperiments(input);
      const ids = out.map((item) => item.id);
      assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
      assert.equal(new Set(ids).size, ids.length, `unique normalized IDs at case ${i}`);
      assert.ok(ids.includes(`id-${i}`));
      assert.ok(ids.includes(String(i)));
    }
  });

  await t.test('200 comparaisons de couverture tolèrent l’ordre et rejettent le churn complet', () => {
    for (let i = 0; i < CASES; i++) {
      const previousIds = Array.from({ length: 100 }, (_, n) => `exp-${n}`);
      const offset = i % previousIds.length;
      const reordered = previousIds.slice(offset).concat(previousIds.slice(0, offset));
      const stable = assessCoverage({
        currentCount: 100,
        previousCount: 100,
        extractionStatus: 'complete',
        currentIds: reordered,
        previousIds,
      });
      assert.equal(stable.reliable, true, `same IDs in another order at case ${i}`);
      assert.equal(stable.retentionRatio, 1);

      const churned = assessCoverage({
        currentCount: 100,
        previousCount: 100,
        extractionStatus: 'complete',
        currentIds: previousIds.map((_, n) => `new-${i}-${n}`),
        previousIds,
      });
      assert.equal(churned.reliable, false, `full ID churn rejected at case ${i}`);
      assert.equal(churned.reason, 'retention_too_low');
    }
  });

  await t.test('200 URL candidates cannot escape the official asset allowlist', () => {
    for (let i = 0; i < CASES; i++) {
      assert.equal(
        normalizeAssetUrl(`http://127.0.0.1:${8000 + i}/assets/chunk.js`),
        null,
        `localhost candidate ${i}`,
      );
      assert.equal(
        normalizeAssetUrl(`https://canary.discord.com.attacker-${i}.test/assets/chunk.js`),
        null,
        `lookalike host candidate ${i}`,
      );
    }
  });
});
