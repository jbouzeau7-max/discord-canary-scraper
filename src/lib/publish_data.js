/**
 * Atomic multi-file publication for data/.
 *
 * Model:
 *  1) Write a complete generation under data/.generations/<runId>/
 *  2) Validate every JSON file + shared runId/buildNumber
 *  3) Promote each file to fixed paths via atomic rename
 *  4) Write data/generation.json pointer LAST
 *
 * On failure before/during staging validation: published files stay untouched.
 * On failure mid-promote: process exits non-zero so CI does not commit.
 */
'use strict';

const fs = require('fs-extra');
const { envNumber } = require('./utils');
const path = require('path');
const { sha256, isPlainObject, readCurrentGeneration, validateCurrentGeneration } = require('./generation_validation');
const { writeJsonAtomic, writeFileAtomic } = require('./atomic');

const GENERATIONS_DIR = '.generations';
const STAGING_DIR = '.publish_staging';
const POINTER_FILE = 'generation.json';
const MANIFEST_FILE = 'generation-manifest.json';
const KEEP_GENERATIONS = envNumber('DATA_KEEP_GENERATIONS', 5, { min: 1, int: true });

async function publishDataGeneration(dataDir, opts) {
  const runId = String(opts.runId || '').trim();
  const buildNumber = String(opts.buildNumber || '').trim();
  const files = opts.files || {};

  if (!runId) throw new Error('publishDataGeneration: missing runId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('publishDataGeneration: invalid runId');
  }
  if (!buildNumber || buildNumber === 'unknown') {
    throw new Error('publishDataGeneration: missing or unknown buildNumber');
  }
  const names = Object.keys(files);
  if (!names.length) throw new Error('publishDataGeneration: no files');
  if (names.includes(POINTER_FILE) || names.includes(MANIFEST_FILE)) {
    throw new Error('publishDataGeneration: input uses a reserved generation metadata path');
  }

  await fs.ensureDir(dataDir);

  const stagingRoot = path.join(dataDir, STAGING_DIR);
  const staging = path.join(stagingRoot, runId);
  await fs.emptyDir(staging);

  const checksums = {};
  const written = [];

  for (const rel of names.sort()) {
    if (rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error('publishDataGeneration: invalid path ' + rel);
    }
    const value = files[rel];
    const target = path.join(staging, rel);
    await fs.ensureDir(path.dirname(target));
    let outBuf = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    if (
      (rel === 'strings.json' ||
        rel === 'routes.json' ||
        rel === 'last_extract_strings.json') &&
      outBuf.length > 2_000_000
    ) {
      outBuf = Buffer.from(JSON.stringify(value), 'utf8');
    }
    await writeFileAtomic(target, outBuf);
    checksums[rel] = sha256(outBuf);
    written.push(rel);
  }

  for (const rel of written) {
    const target = path.join(staging, rel);
    const raw = await fs.readFile(target);
    if (sha256(raw) !== checksums[rel]) {
      throw new Error(
        'publishDataGeneration: checksum mismatch after write ' + rel,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new Error(
        'publishDataGeneration: invalid JSON ' + rel + ': ' + e.message,
      );
    }
    if (isPlainObject(parsed)) {
      if (parsed.runId != null && String(parsed.runId) !== runId) {
        throw new Error(
          `publishDataGeneration: runId mismatch in ${rel}: ${parsed.runId} !== ${runId}`,
        );
      }
      if (
        parsed.buildNumber != null &&
        String(parsed.buildNumber) !== buildNumber
      ) {
        throw new Error(
          `publishDataGeneration: buildNumber mismatch in ${rel}: ${parsed.buildNumber} !== ${buildNumber}`,
        );
      }
    }
  }

  const manifest = {
    schemaVersion: 3,
    runId,
    buildNumber,
    publishedAt: null,
    stagedAt: new Date().toISOString(),
    files: written.map((rel) => ({
      path: rel,
      sha256: checksums[rel],
    })),
  };
  await writeJsonAtomic(path.join(staging, '_manifest.json'), manifest);

  const genRoot = path.join(dataDir, GENERATIONS_DIR);
  const generationDir = path.join(genRoot, runId);
  const currentPointer = await readCurrentGeneration(dataDir);
  if (currentPointer && currentPointer.generationDir &&
      path.resolve(dataDir, currentPointer.generationDir) === path.resolve(generationDir)) {
    throw new Error('publishDataGeneration: runId already identifies the current generation');
  }
  await fs.emptyDir(generationDir);
  await fs.copy(staging, generationDir);

  const publishedAt = new Date().toISOString();
  manifest.publishedAt = publishedAt;
  const generationManifestPath = path.join(generationDir, '_manifest.json');
  await writeJsonAtomic(generationManifestPath, manifest);
  const manifestChecksum = sha256(await fs.readFile(generationManifestPath));
  const pointer = {
    schemaVersion: 3,
    runId,
    buildNumber,
    publishedAt,
    files: written.slice(),
    checksums: { ...checksums },
    generationDir: path.join(GENERATIONS_DIR, runId),
    manifestFile: MANIFEST_FILE,
    manifestSha256: manifestChecksum,
  };
  const promoted = [];
  const rollbackRoot = path.join(staging, '__rollback__');
  try {
    const promotionPlan = written.map((rel) => ({ rel, from: path.join(generationDir, rel) }));
    promotionPlan.push({ rel: MANIFEST_FILE, from: generationManifestPath });
    for (const { rel, from } of promotionPlan) {
      const to = path.join(dataDir, rel);
      await fs.ensureDir(path.dirname(to));
      const existed = await fs.pathExists(to);
      const backup = path.join(rollbackRoot, rel);
      if (existed) {
        await fs.ensureDir(path.dirname(backup));
        await fs.copy(to, backup, { overwrite: true });
      }
      const tmp = `${to}.promote-${process.pid}-${Date.now()}`;
      const record = { rel, to, backup, existed, tmp };
      promoted.push(record);
      await fs.copy(from, tmp, { overwrite: true });
      await fs.move(tmp, to, { overwrite: true });
    }
    await writeJsonAtomic(path.join(dataDir, POINTER_FILE), pointer);
  } catch (e) {
    const rollbackErrors = [];
    for (const item of promoted.reverse()) {
      try {
        await fs.remove(item.tmp);
        if (item.existed) {
          const restore = `${item.to}.restore-${process.pid}-${Date.now()}`;
          await fs.copy(item.backup, restore, { overwrite: true });
          await fs.move(restore, item.to, { overwrite: true });
        } else {
          await fs.remove(item.to);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${item.rel}: ${rollbackError.message}`);
      }
    }
    try {
      await fs.remove(staging);
    } catch (cleanupError) {
      rollbackErrors.push(`staging cleanup: ${cleanupError.message}`);
    }
    const suffix = rollbackErrors.length ? `; rollback failed for ${rollbackErrors.join('; ')}` : '';
    throw new Error(
      `publishDataGeneration: promote failed after [${promoted.map((item) => item.rel).join(', ')}]: ${e.message}${suffix}`,
    );
  }

  try {
    await fs.remove(staging);
  } catch {}
  try {
    await pruneGenerations(genRoot, KEEP_GENERATIONS, runId);
  } catch (e) {
    console.warn('pruneGenerations', e.message);
  }

  console.log('DATA_PUBLISH ok', {
    runId,
    buildNumber,
    files: written.length,
  });

  return { runId, buildNumber, files: written, generationDir };
}

async function pruneGenerations(genRoot, keep, currentRunId) {
  if (!(await fs.pathExists(genRoot))) return;
  const entries = await fs.readdir(genRoot);
  const dirs = [];
  for (const name of entries) {
    const full = path.join(genRoot, name);
    const st = await fs.stat(full);
    if (st.isDirectory()) {
      dirs.push({ name, full, mtime: st.mtimeMs });
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  for (const d of dirs) {
    if (d.name === currentRunId || kept < keep) {
      kept++;
      continue;
    }
    await fs.remove(d.full);
  }
}

module.exports = {
  publishDataGeneration,
  readCurrentGeneration,
  validateCurrentGeneration,
  GENERATIONS_DIR,
  POINTER_FILE,
  MANIFEST_FILE,
};
