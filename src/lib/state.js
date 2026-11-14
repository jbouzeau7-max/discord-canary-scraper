/** Load / save Canary scraper state with shared runId + buildNumber stamps. */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const SCHEMA_VERSION = 2;

function normalizeExperiments(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.experiments)) list = raw.experiments;
  else if (raw && typeof raw === 'object') {
    list = Object.values(raw).filter((x) => x && typeof x === 'object' && x.id);
  }
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || !e.id) continue;
    const id = String(e.id);
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

  const explicitInit = Boolean(meta && typeof meta === 'object' && meta.initialized === true && Number(meta.schemaVersion || 0) >= 2);
  const legacyInit =
    Boolean(meta && typeof meta === 'object' && meta.initialized) ||
    experiments.length > 0 ||
    (build && build.buildNumber);

  return {
    build,
    experiments,
    strings: strings || {},
    routes: routes || {},
    meta: meta || {},
    initialized: explicitInit || legacyInit,
  };
}

async function saveState(dataDir, state, opts = {}) {
  await fs.ensureDir(dataDir);
  const buildNumber = opts.buildNumber != null ? opts.buildNumber : (state.build && state.build.buildNumber);
  const runId = opts.runId || makeRunId(buildNumber);
  const stampCtx = { runId, buildNumber };

  const staging = path.join(dataDir, `.staging-${process.pid}-${Date.now()}`);
  await fs.ensureDir(staging);

  const buildOut = stamp(state.build || { buildNumber }, stampCtx);
  const expPayload = stamp({ experiments: state.experiments || [] }, stampCtx);

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

  await writeJsonAtomic(path.join(staging, 'build.json'), buildOut);
  await writeJsonAtomic(path.join(staging, 'experiments.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'findings.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'strings.json'), state.strings || {}, null);
  await writeJsonAtomic(path.join(staging, 'routes.json'), state.routes || {}, null);
  await writeJsonAtomic(path.join(staging, 'meta.json'), metaOut);
  await writeJsonAtomic(path.join(staging, 'state_generation.json'), genMarker);

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

  try {
    await fs.remove(staging);
  } catch {}

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
  SCHEMA_VERSION,
};
