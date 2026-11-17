const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {
  publishDataGeneration,
  readCurrentGeneration,
  validateCurrentGeneration,
  POINTER_FILE,
  MANIFEST_FILE,
  GENERATIONS_DIR,
} = require('../src/lib/publish_data');
const { sha256 } = require('../src/lib/generation_validation');

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pubdata-'));
}

test('successful publish writes all files + pointer', async () => {
  const dir = await tmpDir();
  const res = await publishDataGeneration(dir, {
    runId: 'run-1',
    buildNumber: '12345',
    files: {
      'build.json': { runId: 'run-1', buildNumber: '12345' },
      'meta.json': { runId: 'run-1', buildNumber: '12345', ok: true },
      'experiments.json': { runId: 'run-1', buildNumber: '12345', experiments: [] },
    },
  });
  assert.equal(res.runId, 'run-1');
  assert.ok(await fs.pathExists(path.join(dir, 'build.json')));
  assert.ok(await fs.pathExists(path.join(dir, POINTER_FILE)));
  assert.ok(await fs.pathExists(path.join(dir, MANIFEST_FILE)));
  const ptr = await readCurrentGeneration(dir);
  assert.equal(ptr.schemaVersion, 3);
  assert.equal(ptr.buildNumber, '12345');
  assert.equal(ptr.files.length, 3);
  assert.ok(ptr.checksums['build.json']);
  assert.equal(ptr.manifestFile, MANIFEST_FILE);
  assert.equal(ptr.manifestSha256, sha256(await fs.readFile(path.join(dir, MANIFEST_FILE))));
  const validation = await validateCurrentGeneration(dir);
  assert.equal(validation.checked, 3);
  assert.equal(validation.manifestChecked, 3);
  assert.equal(validation.generationChecked, 3);
  await fs.remove(dir);
});

test('generation validation detects a mixed or modified top-level file', async () => {
  const dir = await tmpDir();
  await publishDataGeneration(dir, {
    runId: 'run-checksum',
    buildNumber: '42',
    files: {
      'build.json': { runId: 'run-checksum', buildNumber: '42' },
      'meta.json': { runId: 'run-checksum', buildNumber: '42' },
    },
  });
  await fs.writeJson(path.join(dir, 'meta.json'), { runId: 'other', buildNumber: '42' });
  await assert.rejects(() => validateCurrentGeneration(dir), /checksum mismatch: meta\.json/);
  await fs.remove(dir);
});

test('legacy generation validation detects a runId mixed from another scrape', async () => {
  const dir = await tmpDir();
  await fs.writeJson(path.join(dir, 'build.json'), { runId: 'new-run', buildNumber: '42' });
  await fs.writeJson(path.join(dir, POINTER_FILE), {
    schemaVersion: 1,
    runId: 'old-run',
    buildNumber: '42',
    files: ['build.json'],
  });
  await assert.rejects(() => validateCurrentGeneration(dir), /runId mismatch/);
  await fs.remove(dir);
});

test('validation failure leaves published files untouched', async () => {
  const dir = await tmpDir();
  await fs.writeJson(path.join(dir, 'build.json'), { buildNumber: 'old' });
  await fs.writeJson(path.join(dir, POINTER_FILE), {
    runId: 'old-run',
    buildNumber: 'old',
  });
  let failed = false;
  try {
    await publishDataGeneration(dir, {
      runId: 'run-2',
      buildNumber: '999',
      files: {
        'build.json': { runId: 'WRONG', buildNumber: '999' },
      },
    });
  } catch (e) {
    failed = true;
    assert.match(e.message, /runId mismatch/);
  }
  assert.equal(failed, true);
  const build = await fs.readJson(path.join(dir, 'build.json'));
  assert.equal(build.buildNumber, 'old');
  const ptr = await readCurrentGeneration(dir);
  assert.equal(ptr.runId, 'old-run');
  await fs.remove(dir);
});

test('refuses unknown buildNumber', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () =>
      publishDataGeneration(dir, {
        runId: 'r',
        buildNumber: 'unknown',
        files: { 'a.json': {} },
      }),
    /unknown buildNumber/,
  );
  await fs.remove(dir);
});

test('refuses empty file set', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () =>
      publishDataGeneration(dir, {
        runId: 'r',
        buildNumber: '1',
        files: {},
      }),
    /no files/,
  );
  await fs.remove(dir);
});

test('schemaVersion 3 refuse un pointeur dont l’inventaire est incomplet par rapport au manifeste', async () => {
  const dir = await tmpDir();
  await publishDataGeneration(dir, {
    runId: 'run-inventory',
    buildNumber: '43',
    files: {
      'a.json': { runId: 'run-inventory', buildNumber: '43', a: true },
      'b.json': { runId: 'run-inventory', buildNumber: '43', b: true },
    },
  });
  const pointer = await fs.readJson(path.join(dir, POINTER_FILE));
  pointer.files = ['a.json'];
  delete pointer.checksums['b.json'];
  await fs.writeJson(path.join(dir, POINTER_FILE), pointer);
  await assert.rejects(() => validateCurrentGeneration(dir), /pointer\/manifest file inventory mismatch/);
  await fs.remove(dir);
});

test('schemaVersion 3 vérifie aussi les fichiers de la génération immuable', async () => {
  const dir = await tmpDir();
  const result = await publishDataGeneration(dir, {
    runId: 'run-immutable',
    buildNumber: '44',
    files: { 'a.json': { runId: 'run-immutable', buildNumber: '44', value: 1 } },
  });
  await fs.writeJson(path.join(result.generationDir, 'a.json'), { runId: 'run-immutable', buildNumber: '44', value: 2 });
  await assert.rejects(() => validateCurrentGeneration(dir), /immutable checksum mismatch/);
  await fs.remove(dir);
});

test('promotion partiellement échouée restaure les fichiers fixes et ne crée pas de pointeur', async () => {
  const dir = await tmpDir();
  await fs.writeJson(path.join(dir, 'a.json'), { previous: 'a' });
  await fs.writeJson(path.join(dir, 'b.json'), { previous: 'b' });
  const originalMove = fs.move;
  let promotionMoves = 0;
  fs.move = async (from, to, options) => {
    if (String(from).includes('.promote-') && ++promotionMoves === 2) {
      throw new Error('injected promotion failure');
    }
    return originalMove.call(fs, from, to, options);
  };
  try {
    await assert.rejects(
      publishDataGeneration(dir, {
        runId: 'run-rollback',
        buildNumber: '45',
        files: {
          'a.json': { runId: 'run-rollback', buildNumber: '45', value: 'new-a' },
          'b.json': { runId: 'run-rollback', buildNumber: '45', value: 'new-b' },
        },
      }),
      /injected promotion failure/,
    );
  } finally {
    fs.move = originalMove;
  }
  assert.deepEqual(await fs.readJson(path.join(dir, 'a.json')), { previous: 'a' });
  assert.deepEqual(await fs.readJson(path.join(dir, 'b.json')), { previous: 'b' });
  assert.equal(await fs.pathExists(path.join(dir, POINTER_FILE)), false);
  await fs.remove(dir);
});

test('refuse de réutiliser le runId actuellement pointé sans toucher à sa génération', async () => {
  const dir = await tmpDir();
  await publishDataGeneration(dir, {
    runId: 'run-current',
    buildNumber: '46',
    files: { 'a.json': { runId: 'run-current', buildNumber: '46', value: 'original' } },
  });
  const immutablePath = path.join(dir, '.generations', 'run-current', 'a.json');
  const before = await fs.readFile(immutablePath, 'utf8');
  await assert.rejects(() => publishDataGeneration(dir, {
    runId: 'run-current',
    buildNumber: '47',
    files: { 'a.json': { runId: 'run-current', buildNumber: '47', value: 'replacement' } },
  }), /runId already identifies the current generation/);
  assert.equal(await fs.readFile(immutablePath, 'utf8'), before);
  assert.equal((await validateCurrentGeneration(dir)).runId, 'run-current');
  await fs.remove(dir);
});

test('refuse les runId pouvant sortir du répertoire des générations', async () => {
  const dir = await tmpDir();
  await assert.rejects(() => publishDataGeneration(dir, {
    runId: '../escape',
    buildNumber: '48',
    files: { 'a.json': {} },
  }), /invalid runId/);
  assert.equal(await fs.pathExists(path.resolve(dir, '../escape')), false);
  await fs.remove(dir);
});

test('pointeur schemaVersion 2 historique reste validable sans le dossier .generations ignoré par Git', async () => {
  const dir = await tmpDir();
  const payload = { runId: 'old-run', buildNumber: '49', value: true };
  const payloadPath = path.join(dir, 'build.json');
  await fs.writeJson(payloadPath, payload);
  const raw = await fs.readFile(payloadPath);
  await fs.writeJson(path.join(dir, POINTER_FILE), {
    schemaVersion: 2,
    runId: 'old-run',
    buildNumber: '49',
    files: ['build.json'],
    checksums: { 'build.json': sha256(raw) },
    generationDir: '.generations/not-committed',
  });
  const result = await validateCurrentGeneration(dir);
  assert.equal(result.ok, true);
  assert.equal(result.legacy, false);
  assert.equal(result.checked, 1);
  assert.equal(result.manifestChecked, 0);
  assert.equal(result.generationChecked, 0);
  await fs.remove(dir);
});

test('pointeur schemaVersion 3 reste entièrement validable en checkout sans .generations', async () => {
  const dir = await tmpDir();
  await publishDataGeneration(dir, {
    runId: 'run-checkout',
    buildNumber: '50',
    files: {
      'build.json': { runId: 'run-checkout', buildNumber: '50' },
      'routes.json': { runId: 'run-checkout', buildNumber: '50', routes: [] },
    },
  });
  await fs.remove(path.join(dir, GENERATIONS_DIR));
  const result = await validateCurrentGeneration(dir);
  assert.equal(result.ok, true);
  assert.equal(result.manifestChecked, 2);
  assert.equal(result.generationChecked, 0);
  await fs.remove(dir);
});
