'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('CI installe les dépendances depuis un lockfile déterministe', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].version, pkg.version);
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(lock.packages[''].dependencies[name], version, `version verrouillée: ${name}`);
  }
  assert.match(read('.github/workflows/ci.yml'), /npm ci --no-audit --no-fund/);
  assert.match(read('.github/actions/setup/action.yml'), /npm ci --no-audit --no-fund/);
});

test('les contrôles lint, tests et actionlint ne sont pas masqués dans le CI', () => {
  const ci = read('.github/workflows/ci.yml');
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.lint, /--max-warnings=26/);
  assert.match(ci, /run: npm run lint/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /\.\/actionlint -color\s*$/m);
  assert.doesNotMatch(ci, /npm run lint[^\n]*\|\|/);
  assert.doesNotMatch(ci, /npm test[^\n]*\|\|/);
  assert.doesNotMatch(ci, /actionlint -color[^\n]*\|\|/);
});

test('le workflow scrape utilise WEBHOOK_URL si le secret Discord dédié manque', () => {
  const scrape = read('.github/workflows/scrape.yml');
  assert.match(
    scrape,
    /DISCORD_WEBHOOK_URL:\s*\$\{\{\s*secrets\.DISCORD_WEBHOOK_URL\s*\|\|\s*secrets\.WEBHOOK_URL\s*\}\}/,
  );
});
