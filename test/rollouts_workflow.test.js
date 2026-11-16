'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowDir = path.join(__dirname, '..', '.github', 'workflows');
const workflow = fs.readFileSync(path.join(workflowDir, 'rollouts.yml'), 'utf8');

test('workflow Rollouts : cadence rapide, dispatch rétrocompatibles et deux modes', () => {
  assert.match(workflow, /cron:\s*["']?\*\/5 \* \* \* \*['"]?/);
  for (const type of ['trigger-rollouts', 'trigger-rollouts-fast', 'trigger-apex-rollouts', 'trigger-gist-user-rollouts', 'trigger-user-rollouts']) {
    assert.match(workflow, new RegExp(`- ${type}\\b`));
  }
  assert.match(workflow, /node src\/rollouts_fast\.js/);
  assert.match(workflow, /node src\/rollouts_watch\.js/);
  assert.match(workflow, /group: rollouts-fast/);
  assert.match(workflow, /^  guard:/m);
  assert.match(workflow, /^  diagnostic:/m);
});

test('les workflows utilisent des sources publiques et n’injectent aucun jeton Discord', () => {
  const workflowFiles = fs.readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
  for (const name of workflowFiles) {
    const content = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    assert.doesNotMatch(content, /^\s*DISCORD_[A-Z_]*TOKEN\s*:/m, `${name} ne doit pas injecter de jeton Discord`);
  }
  for (const name of [
    'GITHUB_TOKEN', 'GIST_TOKEN', 'USER_ROLLOUT_WEBHOOK_URL', 'APEX_WEBHOOK_URL',
    'ROLLOUT_WEBHOOK_URL', 'UR_WEBHOOK', 'DISCORD_WEBHOOK_URL',
  ]) {
    assert.ok(
      workflow.includes(name + ': ${{ secrets.' + name + ' }}'),
      `${name} doit être transmis au workflow`,
    );
  }
  assert.match(fs.readFileSync(path.join(workflowDir, 'shop.yml'), 'utf8'), /data\/shop_itemshop\.json/);
});

test('les workflows ne publient que les données validées', () => {
  const scrape = fs.readFileSync(path.join(workflowDir, 'scrape.yml'), 'utf8');
  const pages = fs.readFileSync(path.join(workflowDir, 'pages.yml'), 'utf8');
  assert.match(scrape, /if: success\(\) && github\.event_name == 'workflow_dispatch' && inputs\.once == true/);
  assert.match(scrape, /COMMIT_RECOVERY_PATCH:/);
  assert.match(pages, /node scripts\/validate-data-generation\.js/);
});

test('le validateur Pages utilise le module natif sans charger publish_data et ses deps npm', () => {
  const validator = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'validate-data-generation.js'), 'utf8');
  assert.match(validator, /generation_validation/);
  assert.doesNotMatch(validator, /publish_data/);
});
