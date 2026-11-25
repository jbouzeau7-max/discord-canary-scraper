'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldScrape } = require('../src/scrape_watch');

test('watch: un ancien numéro prime sur un hash divergent, sans masquer un hotfix', () => {
  const local = { buildNumber: '12000', versionHash: 'aaaaaaa' };
  const remote = { versionHash: 'bbbbbbb' };
  assert.equal(shouldScrape(local, { ...remote, buildNumber: '11999' }), false);
  assert.equal(shouldScrape(local, { ...remote, buildNumber: '12000' }), true);
  assert.equal(shouldScrape(local, remote), true);
  assert.equal(shouldScrape(local, { ...local, buildNumber: '12001' }), true);
});
