'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TARGET_REPO = 'jbouzeau7-max/discord-canary-scraper';

test('le déclencheur Canary vise le dépôt actuel par défaut', () => {
  const repo = execFileSync(
    'python3',
    ['-c', 'from scripts._canary_common import DEFAULT_REPO; print(DEFAULT_REPO)'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  assert.equal(repo, TARGET_REPO);
  const help = fs.readFileSync(path.join(ROOT, 'scripts/canary_trigger.py'), 'utf8');
  assert.ok(help.includes(`GITHUB_REPO=${TARGET_REPO}`));
  assert.ok(!help.includes('kmljkjj/discord-canary-scraper'));
});
