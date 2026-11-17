'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const POINTER_FILE = 'generation.json';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveSafeRelative(root, rel, label) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`invalid generation ${label} path`);
  }
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`invalid generation ${label} path: ${rel}`);
  }
  return target;
}

async function readJsonFile(file, errorLabel) {
  let raw;
  try {
    raw = await fs.readFile(file);
  } catch (error) {
    throw new Error(`${errorLabel}: ${error.message}`);
  }
  try {
    return { raw, parsed: JSON.parse(raw.toString('utf8')) };
  } catch (error) {
    throw new Error(`${errorLabel}: ${error.message}`);
  }
}

async function readCurrentGeneration(dataDir) {
  try {
    const raw = await fs.readFile(path.join(dataDir, POINTER_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validateManifest(manifest, pointer, schemaVersion) {
  if (!isPlainObject(manifest) || Number(manifest.schemaVersion) !== schemaVersion ||
      String(manifest.runId || '') !== String(pointer.runId) ||
      String(manifest.buildNumber || '') !== String(pointer.buildNumber) ||
      !Array.isArray(manifest.files)) {
    throw new Error('generation manifest does not match pointer');
  }
  const files = new Map();
  for (const item of manifest.files) {
    if (!isPlainObject(item) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
      throw new Error('invalid generation manifest file entry');
    }
    if (typeof item.path !== 'string' || files.has(item.path)) {
      throw new Error('invalid or duplicate generation manifest file path');
    }
    files.set(item.path, item.sha256.toLowerCase());
  }
  return files;
}

function validateInventory(pointerFiles, checksums, manifestFiles) {
  const pointerNames = [...pointerFiles].sort();
  const checksumNames = Object.keys(checksums).sort();
  if (checksumNames.length !== pointerNames.length ||
      checksumNames.some((rel, index) => rel !== pointerNames[index])) {
    throw new Error('generation pointer checksum inventory mismatch');
  }
  if (!manifestFiles) return;
  const manifestNames = [...manifestFiles.keys()].sort();
  if (manifestNames.length !== pointerNames.length ||
      manifestNames.some((rel, index) => rel !== pointerNames[index])) {
    throw new Error('generation pointer/manifest file inventory mismatch');
  }
  for (const rel of pointerNames) {
    if (String(checksums[rel]).toLowerCase() !== manifestFiles.get(rel)) {
      throw new Error('generation pointer/manifest checksum mismatch: ' + rel);
    }
  }
}

/** Validate the pointer, versioned manifest when available, and all fixed files. */
async function validateCurrentGeneration(dataDir) {
  const pointerPath = path.join(dataDir, POINTER_FILE);
  let pointerRaw;
  try {
    pointerRaw = await fs.readFile(pointerPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, legacy: true, checked: 0 };
    throw new Error('invalid generation pointer: ' + error.message);
  }

  let pointer;
  try {
    pointer = JSON.parse(pointerRaw.toString('utf8'));
  } catch (error) {
    throw new Error('invalid generation pointer: ' + error.message);
  }
  if (!isPlainObject(pointer) || !Array.isArray(pointer.files) || !pointer.files.length) {
    throw new Error('invalid generation pointer: missing files');
  }
  const schemaVersion = Number(pointer.schemaVersion);
  if (![1, 2, 3].includes(schemaVersion)) {
    throw new Error('unsupported generation schemaVersion: ' + pointer.schemaVersion);
  }
  if (!String(pointer.runId || '').trim() || !String(pointer.buildNumber || '').trim()) {
    throw new Error('invalid generation pointer: missing runId or buildNumber');
  }

  const root = path.resolve(dataDir);
  const checksums = isPlainObject(pointer.checksums) ? pointer.checksums : {};
  const pointerFiles = pointer.files.map((rel) => {
    resolveSafeRelative(root, rel, 'file');
    return rel;
  });
  if (new Set(pointerFiles).size !== pointerFiles.length) {
    throw new Error('invalid generation pointer: duplicate file path');
  }

  let generationRoot = null;
  let manifestFiles = null;
  let immutableGenerationPresent = false;
  if (pointer.generationDir) {
    generationRoot = resolveSafeRelative(root, pointer.generationDir, 'directory');
    try {
      const stat = await fs.stat(generationRoot);
      if (!stat.isDirectory()) throw new Error('generationDir is not a directory');
      immutableGenerationPresent = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (schemaVersion === 3) {
    if (!generationRoot) throw new Error('invalid generation pointer: missing generationDir');
    const manifestPath = resolveSafeRelative(root, pointer.manifestFile, 'manifest');
    const { raw, parsed } = await readJsonFile(manifestPath, 'invalid generation manifest');
    if (!/^[a-f0-9]{64}$/i.test(String(pointer.manifestSha256 || '')) ||
        sha256(raw) !== String(pointer.manifestSha256).toLowerCase()) {
      throw new Error('generation manifest checksum mismatch');
    }
    manifestFiles = validateManifest(parsed, pointer, schemaVersion);
    validateInventory(pointerFiles, checksums, manifestFiles);
  } else {
    if (schemaVersion >= 2) validateInventory(pointerFiles, checksums, null);
    // Existing schemaVersion 2 pointers predate a committed manifest sidecar.
    // When their local immutable copy exists, validate it; in a Git checkout
    // where .generations was ignored, retain checksum validation of fixed files.
    if (schemaVersion === 2 && generationRoot) {
      try {
        const { parsed } = await readJsonFile(path.join(generationRoot, '_manifest.json'), 'invalid generation manifest');
        manifestFiles = validateManifest(parsed, pointer, schemaVersion);
        validateInventory(pointerFiles, checksums, manifestFiles);
      } catch (error) {
        if (!error.message.includes('ENOENT')) throw error;
      }
    }
  }

  let generationChecked = 0;
  for (const rel of pointerFiles) {
    const fixedTarget = resolveSafeRelative(root, rel, 'file');
    const { raw: fixedRaw, parsed: fixedParsed } = await readJsonFile(
      fixedTarget,
      `generation file is invalid or missing: ${rel}`,
    );
    const expected = checksums[rel];
    if (schemaVersion >= 2 && (!expected || sha256(fixedRaw) !== expected)) {
      throw new Error('generation checksum mismatch: ' + rel);
    }
    if (schemaVersion < 2 && expected && sha256(fixedRaw) !== expected) {
      throw new Error('generation checksum mismatch: ' + rel);
    }
    if (isPlainObject(fixedParsed) && fixedParsed.buildNumber != null &&
        String(fixedParsed.buildNumber) !== String(pointer.buildNumber)) {
      throw new Error('generation buildNumber mismatch: ' + rel);
    }
    if (isPlainObject(fixedParsed) && fixedParsed.runId != null &&
        String(fixedParsed.runId) !== String(pointer.runId)) {
      throw new Error('generation runId mismatch: ' + rel);
    }

    if (manifestFiles && generationRoot) {
      try {
        const immutableTarget = resolveSafeRelative(generationRoot, rel, 'manifest file');
        const { raw: immutableRaw, parsed: immutableParsed } = await readJsonFile(
          immutableTarget,
          `generation immutable file is invalid or missing: ${rel}`,
        );
        const manifestChecksum = manifestFiles.get(rel);
        if (sha256(immutableRaw) !== manifestChecksum || sha256(immutableRaw) !== sha256(fixedRaw)) {
          throw new Error('generation immutable checksum mismatch: ' + rel);
        }
        if (isPlainObject(immutableParsed) && immutableParsed.buildNumber != null &&
            String(immutableParsed.buildNumber) !== String(pointer.buildNumber)) {
          throw new Error('generation immutable buildNumber mismatch: ' + rel);
        }
        if (isPlainObject(immutableParsed) && immutableParsed.runId != null &&
            String(immutableParsed.runId) !== String(pointer.runId)) {
          throw new Error('generation immutable runId mismatch: ' + rel);
        }
        generationChecked++;
      } catch (error) {
        if (!(schemaVersion === 3 && !immutableGenerationPresent && error.message.includes('ENOENT'))) throw error;
      }
    }
  }

  return {
    ok: true,
    legacy: schemaVersion < 2,
    checked: pointer.files.length,
    manifestChecked: manifestFiles ? manifestFiles.size : 0,
    generationChecked,
    runId: pointer.runId,
    buildNumber: pointer.buildNumber,
  };
}

module.exports = { sha256, isPlainObject, readCurrentGeneration, validateCurrentGeneration, POINTER_FILE };
