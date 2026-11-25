'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { Response } = require('node-fetch');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_RESPONSE_BODY_BYTES } = require('../src/lib/http');
const { main } = require('../src/user_rollout_positions');

test('positions: corps 429 plafonné sans perdre le Retry-After HTTP', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-positions-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0; let failure;
  const result = await main({ out: path.join(dir, 'state.json'), comparison: {}, knownNames: [], samples: 2,
    minOk: 1, maxMs: 5000, fetch: async (_url, options) => {
      calls++;
      const res = new Response(Readable.from([Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 1, 32)]),
        { status: 429, headers: { 'Retry-After': '90' }, size: options.size });
      const readJson = res.json.bind(res);
      res.json = async () => { try { return await readJson(); } catch (e) { failure = e.type; throw e; } };
      return res;
    } });
  assert.equal(failure, 'max-size');
  assert.equal(calls, 1);
  assert.equal(result.lastRun.skipped, true);
});
