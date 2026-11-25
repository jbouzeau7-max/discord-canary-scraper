/** Load / save Canary scraper state with shared runId + buildNumber stamps. */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const SCHEMA_VERSION = 2;

function normalizeExperimentId(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function normalizeExperiments(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.experiments)) list = raw.experiments;
  else if (raw && typeof raw === 'object') {
    list = Object.values(raw).filter((x) => x && typeof x === 'object' && normalizeExperimentId(x.id) !== null);
  }
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const id = normalizeExperimentId(e.id);
    if (id === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: e.type === 'guild' ? 'guild' : e.type === 'user' ? 'user' : e.type || 'unknown',
      title: e.title || e.label || null,
      description: e.description || null,
      defaultConfig: e.defaultConfig || null,
      variations: e.variations || e.treatments || null,
    });
  }
  return out;
}

function makeRunId(buildNumber) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bn = String(buildNumber || 'na');
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}_${bn}_${rnd}`;
}

function stamp(payload, { runId, buildNumber }) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    schemaVersion: SCHEMA_VERSION,
    runId,
    buildNumber: buildNumber != null ? String(buildNumber) : payload.buildNumber || null,
  };
}

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'), null);
  const experimentsRaw = await readJson(path.join(dataDir, 'experiments.json'), null);
  const findings = await readJson(path.join(dataDir, 'findings.json'), null);
  const strings = await readJson(path.join(dataDir, 'strings.json'), {});
  const routes = await readJson(path.join(dataDir, 'routes.json'), {});
  const meta = await readJson(path.join(dataDir, 'meta.json'), {});

  const experiments = normalizeExperiments(experimentsRaw || findings);
  console.log('Loaded baseline experiments:', experiments.length);

  // Explicit initiatives /Legacy heuristics
  const explicitInit = Boolean(meta && typeof meta === 'object' && meta.initialized === true && Number(meta.schemaVersion || 0) >= 2);
  const legacyInit =
    Boolean(meta && typeof meta === 'object' && meta.initialized) ||
    experiments.length > 10 ||
    Object.keys(strings || {}).length > 50 ||
    !!(build && typeof build === 'object' && build.buildNumber && build.buildNumber !== 'unknown');

  // Soft consistency check across stamped files (warn only — do not wipe baseline).
  const stamps = [
    build && typeof build === 'object' && build.runId,
    experimentsRaw && typeof experimentsRaw === 'object' && experimentsRaw.runId,
    meta && typeof meta === 'object' && meta.runId,
  ].filter(Boolean);
  if (stamps.length >= 2 && new Set(stamps).size > 1) {
    console.warn(
      'STATE_STAMP_MISMATCH: state files may come from different runs',
      { stamps: [...new Set(stamps)] },
    );
  }

  return {
    initialized: explicitInit || legacyInit,
    build: build && typeof build === 'object' && !Array.isArray(build) ? build : null,
    experiments,
    strings:
      strings && typeof strings === 'object' && !Array.isArray(strings) ? strings : {},
    routes: routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {},
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
  };
}

/**
 * Purge les générations de staging abandonnées (crash/annulation entre l'étape
 * d'écriture et la promotion). Avant, seul le staging du run courant était
 * supprimé : `data/.state_staging/<runId>/` s'accumulait indéfiniment et les
 * fichiers JSON non suivis finissaient visibles dans `git status`.
 * @returns {Promise<string[]>} noms des dossiers supprimés
 */
async function pruneStaleStaging(stagingRoot, opts = {}) {
  const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : 6 * 3600 * 1000;
  const keep = opts.keep != null ? String(opts.keep) : null;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const removed = [];
  let entries;
  try {
    entries = await fs.readdir(stagingRoot);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (keep != null && name === keep) continue;
    const dir = path.join(stagingRoot, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      // Un staging très récent peut appartenir à un autre process en cours.
      if (now - Number(st.mtimeMs || 0) < maxAgeMs) continue;
      await fs.remove(dir);
      removed.push(name);
    } catch {}
  }
  if (removed.length) console.warn('state staging: générations abandonnées purgées', removed.slice(0, 5));
  return removed;
}

/**
 * Write a coherent generation of state files:
 *  1) write all JSON into .state_staging/<runId>/
 *  2) atomic-move each into dataDir
 * So a crash mid-write cannot leave experiments.json from run A and strings.json from run B.
 */
async function saveState(dataDir, state) {
  await fs.ensureDir(dataDir);

  const buildNumber =
    state.build && state.build.buildNumber != null
      ? String(state.build.buildNumber)
      : null;
  if (!buildNumber || buildNumber === 'unknown') {
    throw new Error('saveState refused: missing or unknown buildNumber');
  }

  const runId = state.runId || makeRunId(buildNumber);
  const stampCtx = { runId, buildNumber };
  const stagingRoot = path.join(dataDir, '.state_staging');
  const staging = path.join(stagingRoot, runId);
  await fs.emptyDir(staging);

  const buildOut = stamp(
    {
      buildNumber,
      versionHash: (state.build && state.build.versionHash) || null,
      releaseChannel: (state.build && state.build.releaseChannel) || 'canary',
      scrapedAt: (state.build && state.build.scrapedAt) || new Date().toISOString(),
      assetCount: Array.isArray(state.build && state.build.assets)
        ? state.build.assets.length
        : (state.build && state.build.assetCount) || null,
      cssCount: Array.isArray(state.build && state.build.cssAssets)
        ? state.build.cssAssets.length
        : (state.build && state.build.cssCount) || null,
    },
    stampCtx,
  );

  const expPayload = stamp(
    {
      scrapedAt: new Date().toISOString(),
      totals: { all: (state.experiments || []).length },
      experiments: state.experiments || [],
    },
    stampCtx,
  );

  // strings/routes: wrap if plain map so we can stamp without breaking consumers that expect a map.
  // Keep flat map on disk for backward compat, but write a companion .meta is heavy —
  // instead embed _meta only in meta.json and stamp buildNumber/runId on exp/build.
  // For strings/routes we write the map as-is AND rely on meta.json + build.json for stamps.
  // Additional stamp files keep a generation marker.
  const genMarker = stamp(
    {
      files: [
        'build.json',
        'experiments.json',
        'findings.json',
        'strings.json',
        'routes.json',
        'meta.json',
      ],
      experimentCount: (state.experiments || []).length,
      stringCount: Object.keys(state.strings || {}).length,
      routeCount: Object.keys(state.routes || {}).length,
    },
    stampCtx,
  );

  const metaOut = stamp(
    {
      initialized: true,
      updatedAt: new Date().toISOString(),
      experimentCount: (state.experiments || []).length,
      stringCount: Object.keys(state.strings || {}).length,
      routeCount: Object.keys(state.routes || {}).length,
      lastBuild: buildNumber,
    },
    stampCtx,
  );

  // Write everything into staging first
  await writeJsonAtomic(path.join(staging, 'build.json'), buildOut);
  await writeJsonAtomic(path.join(staging, 'experiments.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'findings.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'strings.json'), state.strings || {}, null);
  await writeJsonAtomic(path.join(staging, 'routes.json'), state.routes || {}, null);
  await writeJsonAtomic(path.join(staging, 'meta.json'), metaOut);
  await writeJsonAtomic(path.join(staging, 'state_generation.json'), genMarker);

  // Atomic promote: move each staged file into dataDir
  const names = [
    'build.json',
    'experiments.json',
    'findings.json',
    'strings.json',
    'routes.json',
    'meta.json',
    'state_generation.json',
  ];
  for (const name of names) {
    const from = path.join(staging, name);
    const to = path.join(dataDir, name);
    await fs.move(from, to, { overwrite: true });
  }

  // Cleanup staging for this run (best-effort)
  try {
    await fs.remove(staging);
  } catch {}

  // Reprise : purge des générations abandonnées par un run interrompu.
  await pruneStaleStaging(stagingRoot, { keep: runId });

  console.log('State saved', { runId, buildNumber, schemaVersion: SCHEMA_VERSION });
  return { runId, buildNumber };
}

async function readJson(p, fallback = null) {
  try {
    if (await fs.pathExists(p)) return await fs.readJson(p);
  } catch (e) {
    console.warn('readJson fail', p, e.message);
  }
  return fallback;
}

module.exports = {
  loadState,
  saveState,
  normalizeExperiments,
  makeRunId,
  pruneStaleStaging,
  SCHEMA_VERSION,
};
