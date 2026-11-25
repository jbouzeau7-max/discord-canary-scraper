'use strict';
/**
 * Régressions : durabilité des écritures atomiques.
 *
 * Un rename sans fsync peut exposer un fichier vide/tronqué après coupure
 * (runner interrompu, machine qui redémarre) : build.json ou
 * notify_dedupe.json repartent alors d'une base corrompue. On vérifie ici que
 * le contenu est synchronisé AVANT le rename, que le répertoire l'est après,
 * et qu'un échec de fsync ne laisse ni destination modifiée ni temporaire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fsMod = require('fs');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { writeJsonAtomic, writeFileAtomic } = require('../src/lib/atomic');

const tmpDirs = [];
async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-dura-'));
  tmpDirs.push(dir);
  return dir;
}
test.after(async () => {
  for (const d of tmpDirs) await fs.remove(d).catch(() => {});
});

/** Instrumente fs.promises.open pour tracer les sync() par chemin. */
function trackSyncs() {
  const realOpen = fsMod.promises.open;
  const events = [];
  fsMod.promises.open = async (target, flags, mode) => {
    const handle = await realOpen.call(fsMod.promises, target, flags, mode);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push(String(target));
      return realSync();
    };
    return handle;
  };
  return {
    events,
    restore() {
      fsMod.promises.open = realOpen;
    },
  };
}

test('writeJsonAtomic : fsync du fichier AVANT rename puis du répertoire', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'state.json');
  const tracer = trackSyncs();
  try {
    await writeJsonAtomic(file, { buildNumber: '123456' });
  } finally {
    tracer.restore();
  }
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "buildNumber": "123456"\n}\n');
  const fileSyncs = tracer.events.filter((p) => p.includes('.tmp-'));
  assert.ok(fileSyncs.length >= 1, `le fichier temporaire doit être synchronisé (reçu ${JSON.stringify(tracer.events)})`);
  assert.ok(tracer.events.includes(dir), 'le répertoire doit être synchronisé après le rename');
});

test('writeFileAtomic : fsync du binaire temporaire', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'blob.bin');
  const tracer = trackSyncs();
  try {
    await writeFileAtomic(file, Buffer.from([0, 1, 2, 255]));
  } finally {
    tracer.restore();
  }
  assert.deepEqual([...await fs.readFile(file)], [0, 1, 2, 255]);
  assert.ok(tracer.events.some((p) => p.includes('.tmp-')), 'binaire synchronisé avant rename');
});

test('échec de fsync fichier : destination intacte, aucun temporaire', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'keep.json');
  await writeJsonAtomic(file, { original: true });
  const realOpen = fsMod.promises.open;
  fsMod.promises.open = async (target, flags, mode) => {
    const handle = await realOpen.call(fsMod.promises, target, flags, mode);
    handle.sync = async () => {
      throw Object.assign(new Error('EIO sync'), { code: 'EIO' });
    };
    return handle;
  };
  try {
    await assert.rejects(() => writeJsonAtomic(file, { replaced: true }), /EIO/);
  } finally {
    fsMod.promises.open = realOpen;
  }
  assert.deepEqual(await fs.readJson(file), { original: true });
  const leftovers = (await fs.readdir(dir)).filter((x) => x.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('fsync de répertoire non supporté : écriture acceptée (best-effort)', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'nofsync.json');
  const realOpen = fsMod.promises.open;
  fsMod.promises.open = async (target, flags, mode) => {
    if (target === dir) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    return realOpen.call(fsMod.promises, target, flags, mode);
  };
  try {
    await writeJsonAtomic(file, { ok: 1 });
  } finally {
    fsMod.promises.open = realOpen;
  }
  assert.deepEqual(await fs.readJson(file), { ok: 1 });
});

test('spaces null → compact, spaces 2 → indenté (contrat inchangé)', async () => {
  const dir = await tmpDir();
  const compact = path.join(dir, 'compact.json');
  const pretty = path.join(dir, 'pretty.json');
  await writeJsonAtomic(compact, { a: 1 }, null);
  await writeJsonAtomic(pretty, { a: 1 });
  assert.equal(await fs.readFile(compact, 'utf8'), '{"a":1}\n');
  assert.equal(await fs.readFile(pretty, 'utf8'), '{\n  "a": 1\n}\n');
});
