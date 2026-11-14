'use strict';
/**
 * Un embed de section = UN message Components V2 :
 * - champ ≤ maxFieldChars (3750 par défaut)
 * - texte total du message ≤ 3900 (sinon HTTP 400 → message perdu)
 * - tout le contenu présent, aucune ligne coupée
 * - chemin legacy (sans maxFieldChars) inchangé : champs ≤ 1020
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');

process.env.NOTIFY_DEDUPE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fit-')), 'd.json');

const { sectionEmbeds, COMPONENT_FIELD_MAX } = require('../src/lib/notify');
const { embedsToComponents, MESSAGE_MAX_TEXT_CHARS } = require('../src/lib/components_v2');

function lines(n, len = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = `+ ligne ${String(i).padStart(4, '0')} `;
    out.push(base + 'x'.repeat(Math.max(0, len - base.length)));
  }
  return out;
}

function msgChars(msg) {
  let n = 0;
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10) n += String(c.content || '').length;
    for (const x of c.components || []) walk(x);
  };
  for (const c of msg) walk(c);
  return n;
}

test('COMPONENT_FIELD_MAX : 3750 par défaut, dans la marge des 3900', () => {
  assert.equal(COMPONENT_FIELD_MAX, 3750);
  assert.ok(COMPONENT_FIELD_MAX < MESSAGE_MAX_TEXT_CHARS);
});

test('grande section : 1 champ par embed, 1 message par embed, ≤ 3900 car.', () => {
  const all = lines(200);
  const embeds = sectionEmbeds(
    { label: 'Ajoutés · 200', color: 1, count: 200, lines: all },
    { title: 'Strings', bn: '42', ts: new Date().toISOString(), maxFieldChars: COMPONENT_FIELD_MAX },
  );
  assert.ok(embeds.length > 1);
  const seen = [];
  for (const e of embeds) {
    assert.equal(e.fields.length, 1, 'un embed doit porter un seul champ');
    assert.ok(e.fields[0].value.length <= COMPONENT_FIELD_MAX, `champ ${e.fields[0].value.length}`);
    const msgs = embedsToComponents([e]);
    assert.equal(msgs.length, 1, 'un embed doit tenir dans UN message');
    assert.ok(msgChars(msgs[0]) <= MESSAGE_MAX_TEXT_CHARS, `message ${msgChars(msgs[0])}`);
    seen.push(...e.fields[0].value.split('\n'));
  }
  // Toutes les lignes sont présentes, dans l'ordre, sans doublon.
  const body = seen.filter((l) => l.startsWith('+ ligne'));
  assert.deepEqual(body, all);
});

test('petite section (≤ 5 lignes) : 1 embed, 1 message, contenu intact', () => {
  const all = ['+ a', '+ b', '~ c', '- d'];
  const embeds = sectionEmbeds(
    { label: 'Ajoutés · 4', color: 1, count: 4, lines: all },
    { title: 'Strings', bn: '42', ts: new Date().toISOString(), maxFieldChars: COMPONENT_FIELD_MAX },
  );
  assert.equal(embeds.length, 1);
  assert.equal(embedsToComponents([embeds[0]]).length, 1);
  for (const l of all) assert.ok(embeds[0].fields[0].value.includes(l));
});

test('ligne plus longue que le champ : découpée mais jamais perdue', () => {
  const long = '+ ' + 'y'.repeat(9000);
  const embeds = sectionEmbeds(
    { label: 'Ajoutés · 1', color: 1, count: 1, lines: [long] },
    { title: 'Strings', bn: '42', ts: new Date().toISOString(), maxFieldChars: COMPONENT_FIELD_MAX },
  );
  const text = embeds.map((e) => e.fields.map((f) => f.value).join('')).join('');
  assert.equal((text.match(/y/g) || []).length, 9000);
});

test('legacy (sans maxFieldChars) : champs ≤ 1020 comme avant', () => {
  const embeds = sectionEmbeds(
    { label: 'Ajoutés · 200', color: 1, count: 200, lines: lines(200) },
    { title: 'Strings', bn: '42', ts: new Date().toISOString() },
  );
  for (const e of embeds) {
    for (const f of e.fields) assert.ok(f.value.length <= 1020, `champ ${f.value.length}`);
  }
});

test('maxFieldChars invalide → défaut legacy', () => {
  const embeds = sectionEmbeds(
    { label: 'Ajoutés · 200', color: 1, count: 200, lines: lines(200) },
    { title: 'Strings', bn: '42', ts: new Date().toISOString(), maxFieldChars: 'abc' },
  );
  for (const e of embeds) for (const f of e.fields) assert.ok(f.value.length <= 1020);
});

test('NOTIFY_FIELD_MAX_CHARS valide respecté, invalide ignoré', () => {
  const load = (val) => {
    process.env.NOTIFY_FIELD_MAX_CHARS = val;
    const p = require.resolve('../src/lib/notify');
    delete require.cache[p];
    const m = require(p);
    return m.COMPONENT_FIELD_MAX;
  };
  const saved = process.env.NOTIFY_FIELD_MAX_CHARS;
  try {
    assert.equal(load('2000'), 2000);
    assert.equal(load('abc'), 3750);
    assert.equal(load('99999'), 3750);
  } finally {
    if (saved === undefined) delete process.env.NOTIFY_FIELD_MAX_CHARS;
    else process.env.NOTIFY_FIELD_MAX_CHARS = saved;
    delete require.cache[require.resolve('../src/lib/notify')];
  }
});
