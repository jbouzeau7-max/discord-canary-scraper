'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRoutes } = require('../src/lib/extract');

test('extractRoutes ignore les commentaires et littéraux tout en gardant les routes réelles', () => {
  const input = [
    'const example = `FAKE_ROUTE:"/from-template"`;',
    'const pattern = /FAKE_REGEX_ROUTE:"\\/from-regex"/;',
    '// COMMENT_ROUTE:"/from-comment"',
    '/* BLOCK_ROUTE:"/from-block-comment" */',
    'const Routes = { REAL_ROUTE:"/channels/${id}/messages", "QUOTED_ROUTE":"/users/${id}" };',
  ].join('\n');
  const out = {};
  extractRoutes(input, out);
  assert.equal(out.FAKE_ROUTE, undefined);
  assert.equal(out.FAKE_REGEX_ROUTE, undefined);
  assert.equal(out.COMMENT_ROUTE, undefined);
  assert.equal(out.BLOCK_ROUTE, undefined);
  assert.equal(out.REAL_ROUTE, '/channels/:param/messages');
  assert.equal(out.QUOTED_ROUTE, '/users/:param');
});
