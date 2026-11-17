const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, writeFileAtomic } = require('../src/lib/atomic');

for (const [name, write] of [['json', writeJsonAtomic], ['file', writeFileAtomic]]) {
  test(`${name}: concurrent readers always see a complete version`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-reader-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'state');
    await write(file, 'old');
    let running = true;
    const reader = async () => {
      do {
        const raw = await fs.readFile(file, 'utf8');
        const value = name === 'json' ? JSON.parse(raw) : raw;
        assert.ok(value === 'old' || value === 'new');
      } while (running);
    };
    const writer = async () => {
      try {
        for (let i = 0; i < 80; i++) await write(file, i % 2 ? 'old' : 'new');
      } finally { running = false; }
    };
    for (const result of await Promise.allSettled([reader(), writer()])) {
      if (result.status === 'rejected') throw result.reason;
    }
  });
}
