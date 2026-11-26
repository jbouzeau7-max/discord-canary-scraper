'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../src/user_rollout_positions');

test('un historique de positions illisible reste intact, même après une interruption', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'positions-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'positions.json');
  for (const raw of ['{"experiments":', '{"experiments":[]}', 'null']) {
    await fs.writeFile(file, raw);
    await assert.rejects(main({ out: file, samples: 0, comparison: {}, knownNames: [] }));
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});
