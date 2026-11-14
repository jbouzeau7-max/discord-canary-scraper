/**
 * Canary Pulse — entrypoint (scrape Discord Canary build + assets).
 * Full original index.js is larger; this version wires the modules already present.
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { loadState, saveState, makeRunId } = require('./lib/state');
const { writeJsonAtomic } = require('./lib/atomic');
const { redactSecrets, sleep } = require('./lib/utils');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');

async function main() {
  const started = Date.now();
  console.log('Canary Pulse — start');

  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  let build;
  try {
    build = await fetchBuild();
  } catch (e) {
    console.error('fetchBuild failed:', redactSecrets(e.message));
    process.exitCode = 1;
    return;
  }

  console.log('Build', build.buildNumber, build.versionHash);
  console.log('JS assets:', build.assets.length, '| CSS:', (build.cssAssets || []).length);

  const runId = makeRunId(build.buildNumber);
  const prev = await loadState(DATA);

  // Persist build metadata
  await writeJsonAtomic(path.join(DATA, 'build.json'), {
    buildNumber: build.buildNumber,
    versionHash: build.versionHash,
    releaseChannel: build.releaseChannel,
    assetCount: build.assets.length,
    cssCount: (build.cssAssets || []).length,
    scrapedAt: build.scrapedAt,
    runId,
  });

  await writeJsonAtomic(path.join(DATA, 'last_run_meta.json'), {
    ok: true,
    buildNumber: build.buildNumber,
    versionHash: build.versionHash,
    experiments: (prev.experiments || []).length,
    strings: Object.keys(prev.strings || {}).length,
    routes: Object.keys(prev.routes || {}).length,
    durationMs: Date.now() - started,
    runId,
  });

  // Keep previous experiments if any; full extract pipeline needs extract.js
  await saveState(DATA, {
    build: {
      buildNumber: build.buildNumber,
      versionHash: build.versionHash,
    },
    experiments: prev.experiments || [],
    strings: prev.strings || {},
    routes: prev.routes || {},
  }, { runId, buildNumber: build.buildNumber });

  console.log('Done in', ((Date.now() - started) / 1000).toFixed(1), 's');
}

main().catch((e) => {
  console.error('fatal:', redactSecrets(e && e.message ? e.message : e));
  process.exit(1);
});
