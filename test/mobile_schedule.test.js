'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'mobile-versions.yml');

test('workflow mobile : vérifie les versions deux fois par heure, aux minutes 15 et 45', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const cronEntries = [...workflow.matchAll(/^\s*- cron:\s*['"]([^'"]+)['"]\s*$/gm)].map((match) => match[1]);

  assert.deepEqual(cronEntries, ['15,45 * * * *']);
  const minutes = cronEntries[0].split(' ')[0].split(',').map(Number);
  assert.equal(minutes.length, 2);
  assert.equal(minutes[1] - minutes[0], 30);
});
