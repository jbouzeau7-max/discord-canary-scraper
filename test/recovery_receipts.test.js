'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sentOnly } = require('../scripts/dedupe-sent-only');

test('la reprise ne conserve pas des acquittements sans horodatage exploitable', () => {
  const fps = { broken: null, empty: {}, text: ' ', flag: true, zero: 0, current: { status: 'sent', ts: 120 }, legacy: 120, oldObject: { ts: 120 }, retry: { status: 'pending', ts: 120 } };
  assert.deepEqual(sentOnly({ version: 1, fps }), { version: 1, fps: { current: fps.current, legacy: 120, oldObject: fps.oldObject } });
});
