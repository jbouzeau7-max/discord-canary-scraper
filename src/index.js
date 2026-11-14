/**
 * Canary Pulse — entrypoint
 * Scrape Discord Canary build, download assets, extract experiments/routes/strings, save state.
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState, makeRunId } = require('./lib/state');
const { writeJsonAtomic } = require('./lib/atomic');
const { archiveBuildChunks } = require('./lib/archive_chunks');
const { publishFlatChunks } = require('./lib/flat_chunks');
const { processDismissibleContent } = require('./lib/dismissible_content');
const { redactSecrets } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ASSETS = path.join(ROOT, 'assets');
const BUILDS = path.join(ROOT, 'builds');
const CHUNKS = path.join(ROOT, 'chunks');
const CSS = path.join(ROOT, 'css');

async function main() {
  const started = Date.now();
  console.log('Canary Pulse — start');

  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);
  await fs.ensureDir(BUILDS);

  let build;
  try {
    build = await fetchBuild();
  } catch (e) {
    console.error('fetchBuild failed:', redactSecrets(e.message));
    process.exitCode = 1;
    return;
  }

  console.log('Build', build.buildNumber, build.versionHash);
  console.log('JS assets:', build.assets.length);

  const runId = makeRunId(build.buildNumber);
  const prev = await loadState(DATA);

  const extracted = await analyzeAssets(build, {
    assetsDir: ASSETS,
    forceRefresh: true,
  });

  console.log(
    'Extracted experiments:',
    extracted.experiments.length,
    '| routes:',
    Object.keys(extracted.routes).length,
    '| strings:',
    Object.keys(extracted.strings).length,
  );

  await writeJsonAtomic(path.join(DATA, 'build.json'), {
    buildNumber: build.buildNumber,
    versionHash: build.versionHash,
    releaseChannel: build.releaseChannel,
    assetCount: build.assets.length,
    scrapedAt: build.scrapedAt,
    runId,
  });

  await saveState(
    DATA,
    {
      build: {
        buildNumber: build.buildNumber,
        versionHash: build.versionHash,
      },
      experiments: extracted.experiments,
      strings: extracted.strings,
      routes: extracted.routes,
    },
    { runId, buildNumber: build.buildNumber },
  );

  try {
    await archiveBuildChunks({ build, assetsDir: ASSETS, buildsDir: BUILDS });
  } catch (e) {
    console.warn('archive failed:', e.message);
  }

  try {
    await publishFlatChunks({
      assetsDir: ASSETS,
      chunksDir: CHUNKS,
      cssDir: CSS,
      infoPath: path.join(ROOT, 'info.json'),
      build,
    });
  } catch (e) {
    console.warn('flat_chunks failed:', e.message);
  }

  try {
    const disc = await processDismissibleContent({
      assetsDir: ASSETS,
      dataDir: DATA,
    });
    console.log('Dismissible content:', disc.count, 'added', disc.added.length);
  } catch (e) {
    console.warn('dismissible failed:', e.message);
  }

  await writeJsonAtomic(path.join(DATA, 'last_run_meta.json'), {
    ok: true,
    buildNumber: build.buildNumber,
    versionHash: build.versionHash,
    experiments: extracted.experiments.length,
    strings: Object.keys(extracted.strings).length,
    routes: Object.keys(extracted.routes).length,
    durationMs: Date.now() - started,
    downloadStats: extracted.downloadStats,
    runId,
  });

  console.log('Done in', ((Date.now() - started) / 1000).toFixed(1), 's');
}

main().catch((e) => {
  console.error('fatal:', redactSecrets(e && e.message ? e.message : e));
  process.exit(1);
});
