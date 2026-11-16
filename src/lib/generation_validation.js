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

async function readCurrentGeneration(dataDir) {
  try {
    const raw = await fs.readFile(path.join(dataDir, POINTER_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Ensure the fixed data files match the current atomic-generation pointer. */
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
  if (![1, 2].includes(Number(pointer.schemaVersion))) {
    throw new Error('unsupported generation schemaVersion: ' + pointer.schemaVersion);
  }
  if (!String(pointer.runId || '').trim() || !String(pointer.buildNumber || '').trim()) {
    throw new Error('invalid generation pointer: missing runId or buildNumber');
  }

  const root = path.resolve(dataDir);
  const checksums = isPlainObject(pointer.checksums) ? pointer.checksums : {};
  for (const rel of pointer.files) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) {
      throw new Error('invalid generation file path');
    }
    const target = path.resolve(root, rel);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('invalid generation file path: ' + rel);
    }

    let raw;
    try {
      raw = await fs.readFile(target);
    } catch (error) {
      throw new Error(`generation file missing: ${rel}: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new Error(`generation file is invalid JSON: ${rel}: ${error.message}`);
    }

    const expected = checksums[rel];
    if (expected && sha256(raw) !== expected) {
      throw new Error('generation checksum mismatch: ' + rel);
    }
    if (Number(pointer.schemaVersion) >= 2 && !expected) {
      throw new Error('generation checksum missing: ' + rel);
    }
    if (isPlainObject(parsed) && parsed.buildNumber != null &&
        String(parsed.buildNumber) !== String(pointer.buildNumber)) {
      throw new Error('generation buildNumber mismatch: ' + rel);
    }
    if (isPlainObject(parsed) && parsed.runId != null &&
        String(parsed.runId) !== String(pointer.runId)) {
      throw new Error('generation runId mismatch: ' + rel);
    }
  }

  return {
    ok: true,
    legacy: Number(pointer.schemaVersion) < 2,
    checked: pointer.files.length,
    runId: pointer.runId,
    buildNumber: pointer.buildNumber,
  };
}

module.exports = { sha256, isPlainObject, readCurrentGeneration, validateCurrentGeneration, POINTER_FILE };
