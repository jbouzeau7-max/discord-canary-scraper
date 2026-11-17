/**
 * Canary Pulse v11.11 — transactional notify + degraded extract guard + webhook partagé
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, makeRunId } = require('./lib/state');
const { notifyUrgent, notifyNormal } = require('./lib/notify');
const {
  hasMapDiff,
  hasExperimentDiff,
  canAdvanceNotificationState,
} = require('./lib/notification_gate');
const { processDismissibleContent } = require('./lib/dismissible_content');
const { archiveBuildChunks, writeZipHint } = require('./lib/archive_chunks');
const { publishFlatChunks } = require('./lib/flat_chunks');
const { writeJsonAtomic } = require('./lib/atomic');
const experimentState = require('./lib/experiment_state');
const { publishDataGeneration } = require('./lib/publish_data');
const ALREADY_NOTIFIED = require('./lib/already_notified');
const {
  loadRolloutPercentageMaps,
  applyRolloutPercentages,
} = require('./lib/rollout_percentages');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');
const BUILDS = path.join(__dirname, '..', 'builds');
const CACHE = path.join(DATA, 'cache');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const KNOWN_RT = path.join(DATA, 'known_route_keys.json');
const LAST_EXTRACT_STR = path.join(DATA, 'last_extract_strings.json');
const LAST_EXTRACT_RT = path.join(DATA, 'last_extract_routes.json');
const LAST_EXTRACT_EXP = path.join(DATA, 'last_extract_experiments.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');
const LAST_RUN_META = path.join(DATA, 'last_run_meta.json');

// Incrémenter quand la logique d'extraction strings/routes change :
// le run suivant ré-amorce last_extract_* sans spammer de faux diffs.
const STR_RT_EXTRACT_VERSION = 3; // v3 : balises $link/$b conservées, routes ${…} nettoyées
const MIN_STRINGS_FOR_DIFF = 200;
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_FOR_DIFF = 80;

async function loadKnownIds(file, fromAlready) {
  const set = new Set();
  if (fromAlready) for (const id of ALREADY_NOTIFIED) set.add(String(id));
  try {
    if (await fs.pathExists(file)) {
      const d = await fs.readJson(file);
      // Une valeur non-tableau (chaîne "abc" → itération caractère par
      // caractère) polluait la liste des ids connus.
      const list = Array.isArray(d && d.ids)
        ? d.ids
        : Array.isArray(d && d.keys)
          ? d.keys
          : [];
      for (const id of list) {
        if (id != null && String(id).trim() !== '') set.add(String(id));
      }
    }
  } catch (e) {
    console.warn('loadLastSet: failed to read', file, '-', e.message);
  }
  return set;
}

async function loadLastMap(file) {
  try {
    if (!(await fs.pathExists(file))) return {};
    const d = await fs.readJson(file);
    // Un fichier corrompu/legacy en TABLEAU produisait les clés "0","1"…
    // dans la baseline strings/routes → diffs fantômes. On l'ignore.
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const raw =
      d.data && typeof d.data === 'object'
        ? d.data
        : d.strings || d.routes || d.experiments || d || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'buildNumber' || k === 'updatedAt' || k === 'count' || k === 'data')
        continue;
      out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('loadLastMap fail', file, e.message);
    return {};
  }
}

function expFingerprint(e) {
  if (!e || typeof e !== 'object') return '';
  const n = e.fingerprint
    ? e
    : experimentState.normalizeExperiment(e) || e;
  return experimentState.createExperimentFingerprint(n);
}

function expSnapshot(e) {
  return {
    id: e.id,
    type: e.type || e.kind || 'user',
    kind: e.kind || e.type || 'user',
    label: e.label || null,
    variationCount:
      e.variationCount || (e.variations ? Object.keys(e.variations).length : 0) || 0,
    variations: e.variations || null,
    defaultConfig: e.defaultConfig || null,
    system: e.system || null,
    fp: expFingerprint(e),
  };
}

function buildGap(prevBuild, remoteBuild) {
  const a = parseInt(String(prevBuild || ''), 10);
  const b = parseInt(String(remoteBuild || ''), 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}


function computeExpDiff(findingsExps, lastExp, knownExp, opts) {
  // Build next snapshots for last_extract persistence
  const nextExpSnap = {};
  const currentRaw = [];
  for (const e of findingsExps || []) {
    if (!e || !e.id || String(e.id).startsWith('hash:')) continue;
    const id = String(e.id);
    nextExpSnap[id] = expSnapshot(e);
    currentRaw.push(e);
  }

  const previousList = [];
  for (const [id, e] of Object.entries(lastExp || {})) {
    if (!e) continue;
    previousList.push(
      experimentState.normalizeExperiment({
        ...(typeof e === 'object' ? e : {}),
        id: (e && e.id) || id,
      }),
    );
  }
  const previous = previousList.filter(Boolean);
  const current = currentRaw
    .map((e) => experimentState.normalizeExperiment(e))
    .filter(Boolean);

  const lastExpCount = previous.length;
  const extractedExpCount = current.length;

  // Guard: not enough data for a reliable diff (same thresholds as before)
  if (extractedExpCount < MIN_EXP_FOR_DIFF || lastExpCount < 40) {
    // Ne pas acquitter non plus les ids présents dans un extract incomplet :
    // leurs modifications/ajouts seraient sinon perdus avant le prochain diff fiable.
    const preserved = { ...(lastExp || {}) };
    return {
      expDiff: {
        added: [],
        modified: [],
        removed: [],
        categoryChanged: [],
      },
      nextExpSnap: preserved,
      coverage: experimentState.assessCoverage({
        currentCount: extractedExpCount,
        previousCount: lastExpCount,
        extractionStatus: 'incomplete',
        currentIds: current.map((e) => e.id),
        previousIds: previous.map((e) => e.id),
      }),
    };
  }

  const coverage = experimentState.assessCoverage({
    currentCount: extractedExpCount,
    previousCount: lastExpCount,
    extractionStatus: 'complete',
    currentIds: current.map((e) => e.id),
    previousIds: previous.map((e) => e.id),
  });
  if (!coverage.reliable) {
    return {
      expDiff: { added: [], modified: [], removed: [], categoryChanged: [] },
      nextExpSnap: { ...(lastExp || {}) },
      coverage,
      rawDiff: null,
    };
  }

  // Unique source of truth
  const rawDiff = experimentState.diffExperiments(
    previous,
    current,
    coverage.reliable,
    {
      knownIds: knownExp,
      // annoncées supprimées puis revenues → ré-annoncées (avant : silence)
      removedIds: opts && opts.removedIds,
    },
  );

  const expDiff = experimentState.toNotifyExpDiff(rawDiff);
  return { expDiff, nextExpSnap, coverage, rawDiff };
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v11.11 ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);
  await fs.ensureDir(BUILDS);
  await fs.ensureDir(CACHE);

  // fetchBuild ne dépend pas du state : on le lance en parallèle
  // avec le chargement du state pour gagner ~1-2s.
  const buildPromise = fetchBuild();

  // Load known-removed experiment IDs to prevent re-notifying the same removed experiments
  // across builds (dedupe by build number in notify_dedupe.json is not sufficient when the
  // state commit fails or a new build comes out with the same experiments still missing).
  let knownRemoved = new Set();
  try {
    const removedData = await experimentState.loadRemovedExperiments(DATA);
    for (const e of removedData) {
      const id = String(typeof e === 'string' ? e : e && e.id || '');
      if (id) knownRemoved.add(id);
    }
  } catch (e) {
    console.warn('loadKnownRemoved: failed -', e.message);
  }

  const [prev, knownExp, knownStr, knownRt, lastStr, lastRt, lastExp] =
    await Promise.all([
      loadState(DATA),
      loadKnownIds(KNOWN_EXP, true),
      loadKnownIds(KNOWN_STR, false),
      loadKnownIds(KNOWN_RT, false),
      loadLastMap(LAST_EXTRACT_STR),
      loadLastMap(LAST_EXTRACT_RT),
      loadLastMap(LAST_EXTRACT_EXP),
    ]);

  // Une expérience présente dans le dernier extract n'est plus « supprimée » :
  // sans cette purge, sa suppression suivante n'était JAMAIS annoncée.
  for (const id of Object.keys(lastExp)) knownRemoved.delete(id);

  console.log('Known / last', {
    knownExp: knownExp.size,
    knownRemoved: knownRemoved.size,
    lastExp: Object.keys(lastExp).length,
    lastStr: Object.keys(lastStr).length,
    lastRt: Object.keys(lastRt).length,
  });

  let build;
  try {
    build = await buildPromise;
  } catch (e) {
    console.error('fetchBuild failed', e.message);
    process.exit(1);
  }

  const prevBuildNum = prev.build && prev.build.buildNumber;
  const gap = buildGap(prevBuildNum, build.buildNumber);
  const isCatchUp = gap > 1;

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prevBuildNum,
      gap,
      catchUp: isCatchUp,
      t_html: Date.now() - t0 + 'ms',
    }),
  );

  if (!build.buildNumber || build.buildNumber === 'unknown') {
    console.error('No BUILD_NUMBER');
    process.exit(1);
  }

  // Garde anti-régression : un edge en retard peut resservir un build PLUS
  // ANCIEN que celui traité il y a quelques minutes. Le diff partait alors à
  // l'envers (fausses « supprimées », puis réapparitions au run suivant).
  // Limité à 30 min : au-delà, c'est un vrai retour arrière de Discord → traité.
  {
    const a = parseInt(String(prevBuildNum || ''), 10);
    const b = parseInt(String(build.buildNumber), 10);
    if (Number.isFinite(a) && Number.isFinite(b) && b < a && process.env.ALLOW_BUILD_REGRESSION !== '1') {
      let age = Infinity;
      try {
        const m = await fs.readJson(LAST_RUN_META);
        if (m && m.ok && String(m.buildNumber) === String(prevBuildNum)) age = Date.now() - Number(m.ts || 0);
      } catch {}
      if (age >= 0 && age < 30 * 60 * 1000) {
        console.log('BUILD REGRESSION SKIP', { remote: b, prev: a, ageSec: Math.round(age / 1000) });
        process.exit(0);
      }
    }
  }

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  let strRtVersionOk = false;
  try {
    const [a, b] = await Promise.all([
      fs.readJson(LAST_EXTRACT_STR).catch(() => ({})),
      fs.readJson(LAST_EXTRACT_RT).catch(() => ({})),
    ]);
    strRtVersionOk =
      Number(a.extractVersion) === STR_RT_EXTRACT_VERSION &&
      Number(b.extractVersion) === STR_RT_EXTRACT_VERSION;
  } catch {}
  if (!strRtVersionOk) {
    console.log('STR/RT extractor changed — reseed last_extract strings/routes (no notify this run)');
  }

  const needsExtractSeed =
    Object.keys(lastStr).length < 50 ||
    Object.keys(lastRt).length < 20 ||
    Object.keys(lastExp).length < 40;

  try {
    if (await fs.pathExists(LAST_RUN_META)) {
      const meta = await fs.readJson(LAST_RUN_META);
      const same = String(meta.buildNumber || '') === String(build.buildNumber);
      const age = Date.now() - Number(meta.ts || 0);
      if (same && age >= 0 && age < 3 * 60 * 1000 && meta.ok && !needsExtractSeed && strRtVersionOk) {
        console.log('COOLDOWN SKIP', build.buildNumber, Math.round(age / 1000) + 's since last success');
        process.exit(0);
      }
    }
  } catch (e) {
    console.warn('last_run_meta read', e.message);
  }

  if (
    !isNewBuild &&
    prev.initialized &&
    !needsExtractSeed &&
    strRtVersionOk &&
    Object.keys(lastExp).length > 40
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  let alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  if (isNewBuild && alreadyBuild) {
    console.log('BUILD already announced', build.buildNumber);
  }

  let findings;
  let urgentSent = false;
  // ids réellement annoncés par le chemin CORE (web.* seul)
  const coreSentIds = new Set();
  try {
    findings = await analyzeAssets(build, {
      forceRefresh: isNewBuild || needsExtractSeed,
      assetsDir: ASSETS,
      cacheDir: CACHE,
      onCore: async ({ experiments }) => {
        if (needsExtractSeed && !isNewBuild) return;
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        const coreCount = (experiments || []).length;
        const lastCount = Object.keys(lastExp || {}).length;
        // CORE is web.* only — never treat incomplete CORE as a full diff.
        // Only pure ADDS (id absent from lastExp) are safe here.
        // Modified/removed wait for the full chunk extract.
        const { expDiff } = computeExpDiff(experiments, lastExp, knownExp, {
          removedIds: knownRemoved,
        });
        const pureAdded = (expDiff.added || []).filter((e) => {
          const id = String(e && e.id != null ? e.id : e);
          return id && !(id in (lastExp || {}));
        });
        if (lastCount >= 40 && coreCount < lastCount * 0.85) {
          console.log('URGENT: CORE incomplete vs lastExp — adds only', {
            coreCount,
            lastCount,
            ratio: Math.round((coreCount / Math.max(lastCount, 1)) * 1000) / 1000,
            pureAdded: pureAdded.length,
            strippedModified: (expDiff.modified || []).length,
            strippedRemoved: (expDiff.removed || []).length,
          });
        }
        const urgentDiff = {
          added: pureAdded,
          modified: [],
          removed: [],
          categoryChanged: [],
        };
        if (!urgentDiff.added.length) {
          console.log('URGENT: no safe pure-add delta', Date.now() - t0 + 'ms');
          return;
        }
        console.log('URGENT experiments', {
          added: urgentDiff.added.length,
          modified: 0,
          removed: 0,
          coreOnly: true,
          t: Date.now() - t0 + 'ms',
        });
        const ok = await notifyUrgent({
          build,
          expDiff: urgentDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (ok) {
          urgentSent = true;
          // In-memory only until publishDataGeneration — no early disk write
          for (const e of urgentDiff.added) {
            knownExp.add(String(e.id || e));
            coreSentIds.add(String(e.id || e));
          }
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }
      },
    });
  } catch (e) {
    console.error('analyzeAssets failed', e);
    process.exit(1);
  }
  console.log('Extract done', Date.now() - t0 + 'ms');

  {
    const expN = (findings.experiments || []).length;
    const strN = Object.keys(findings.strings || {}).length;
    const rtN = Object.keys(findings.routes || {}).length;
    const ds = findings.downloadStats || {};
    const baseExp = Object.keys(lastExp).length;
    const baseStr = Object.keys(lastStr).length;
    const baseRt = Object.keys(lastRt).length;
    console.log('Integrity check', {
      expN,
      strN,
      rtN,
      baseExp,
      baseStr,
      baseRt,
      downloadStats: ds,
    });

    if (expN === 0 && strN < 50 && baseExp > 40) {
      try {
        await writeJsonAtomic(LAST_RUN_META, {
          schemaVersion: 1,
          buildNumber: String(build.buildNumber),
          ts: Date.now(),
          status: 'failed',
          ok: false,
          reason: 'EXTRACTION_EMPTY',
          downloadStats: ds,
        });
      } catch {}
      console.error(
        'EXTRACTION_ERROR: empty extract vs non-empty baseline — refuse state update',
      );
      process.exit(1);
    }

    const solidBaseline = baseExp >= 80 && baseStr >= 200;
    if (solidBaseline) {
      const ratioExp = expN / Math.max(baseExp, 1);
      const ratioStr = strN / Math.max(baseStr, 1);
      const ratioRt = baseRt >= 50 ? rtN / Math.max(baseRt, 1) : 1;
      const degraded =
        (ratioExp < 0.6 && ratioStr < 0.7) ||
        (ratioStr < 0.6 && ratioExp < 0.7) ||
        ratioExp < 0.5 ||
        ratioStr < 0.5;
      if (degraded) {
        try {
          await writeJsonAtomic(LAST_RUN_META, {
            schemaVersion: 1,
            buildNumber: String(build.buildNumber),
            ts: Date.now(),
            status: 'failed',
            ok: false,
            reason: 'EXTRACTION_DEGRADED',
            ratios: {
              exp: Math.round(ratioExp * 1000) / 1000,
              str: Math.round(ratioStr * 1000) / 1000,
              rt: Math.round(ratioRt * 1000) / 1000,
            },
            counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
            downloadStats: ds,
            coverage: findings.coverage || null,
          });
        } catch {}
        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',
          { ratioExp, ratioStr, ratioRt, expN, strN, baseExp, baseStr },
        );
        process.exit(1);
      }
    }

    // Chunk coverage from extract.js — incomplete scan must not look like a valid diff.
    const cov = findings.coverage || null;
    if (cov && cov.degraded) {
      try {
        await writeJsonAtomic(LAST_RUN_META, {
          schemaVersion: 1,
          buildNumber: String(build.buildNumber),
          ts: Date.now(),
          status: 'failed',
          ok: false,
          reason: 'EXTRACTION_COVERAGE_DEGRADED',
          coverage: cov,
          downloadStats: ds,
          counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
        });
      } catch {}
      console.error(
        'EXTRACTION_ERROR: chunk coverage degraded — refuse state update',
        cov.degradedReasons || [],
        {
          scanRatio: cov.scanRatio,
          oversize: cov.skippedOversize,
          readErrors: cov.readErrors,
          jsOnDisk: cov.jsOnDisk,
          mapped: cov.chunkUrlsMapped,
        },
      );
      process.exit(1);
    }
  }

  // Archive + chunks plats : I/O disque lourde (~10 s, 160 Mo) sans lien avec
  // le diff ni les notifications → lancés en parallèle, en arrière-plan, et
  // attendus seulement avant la publication de l'état (les messages Discord
  // partent ~10 s plus tôt). Les erreurs restent non bloquantes comme avant.
  const archiveTask = Promise.all([
    (async () => {
      const manifest = await archiveBuildChunks({
        build,
        assetsDir: ASSETS,
        buildsDir: BUILDS,
      });
      if (manifest) await writeZipHint(BUILDS, build.buildNumber, manifest);
    })().catch((e) => console.warn('archive chunks failed', e.message)),
    publishFlatChunks({
      assetsDir: ASSETS,
      repoRoot: path.join(__dirname, '..'),
      build,
    }).catch((e) => console.warn('flat chunks failed', e.message)),
  ]);

  const extractedStrings = { ...(findings.strings || {}) };
  const nextRt = { ...(findings.routes || {}) };
  const extractedStrCount = Object.keys(extractedStrings).length;
  const extractedRtCount = Object.keys(nextRt).length;
  const nextStringsSnap = selectNextMapBaseline(lastStr, extractedStrings, MIN_STRINGS_FOR_DIFF);
  const nextRoutesSnap = selectNextMapBaseline(lastRt, nextRt, MIN_ROUTES_FOR_DIFF);
  const extractedExpCount = (findings.experiments || []).length;

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: extractedExpCount,
      strings: extractedStrCount,
      routes: extractedRtCount,
    }),
  );

  if (extractedExpCount < 20 && extractedStrCount < 100) {
    console.warn('empty extract — abort without state advance');
    await archiveTask;
    process.exit(1);
  }

  const {
    expDiff,
    nextExpSnap,
    rawDiff,
  } = computeExpDiff(
    findings.experiments,
    lastExp,
    knownExp,
    { removedIds: knownRemoved },
  );

  // Filter out experiments already known as removed to prevent re-notification
  // across builds. This is the cross-build dedupe that notify_dedupe.json (per-build)
  // cannot provide.
  if (knownRemoved.size && expDiff.removed.length) {
    const before = expDiff.removed.length;
    expDiff.removed = expDiff.removed.filter((e) => {
      const id = String(typeof e === 'string' ? e : e && e.id || '');
      return id && !knownRemoved.has(id);
    });
    if (rawDiff && rawDiff.removed) {
      rawDiff.removed = rawDiff.removed.filter((e) => {
        const id = String(e && e.id || '');
        return id && !knownRemoved.has(id);
      });
    }
    if (rawDiff && rawDiff.removedAll) {
      rawDiff.removedAll = rawDiff.removedAll.filter((e) => {
        const id = String(e && e.id || '');
        return id && !knownRemoved.has(id);
      });
    }
    const skipped = before - expDiff.removed.length;
    if (skipped > 0) {
      console.log(`REMOVED_DEDUPE: filtered ${skipped} already-known removed experiment(s)`);
    }
  }

  let strDiff = { added: {}, modified: {}, removed: {} };
  const lastStrCount = Object.keys(lastStr).length;
  if (extractedStrCount >= MIN_STRINGS_FOR_DIFF && lastStrCount >= 50) {
    strDiff = computeMapDiff(lastStr, extractedStrings, {
      known: knownStr,
      isCatchUp,
    });
  }

  let rtDiff = { added: {}, modified: {}, removed: {} };
  const lastRtCount = Object.keys(lastRt).length;
  if (extractedRtCount >= MIN_ROUTES_FOR_DIFF && lastRtCount >= 20) {
    rtDiff = computeMapDiff(lastRt, nextRt, {
      known: knownRt,
      isCatchUp,
    });
  }

  if (!strRtVersionOk) {
    strDiff.added = {};
    strDiff.modified = {};
    strDiff.removed = {};
    rtDiff.added = {};
    rtDiff.modified = {};
    rtDiff.removed = {};
    // Seul un snapshot assez complet peut servir de seed et être marqué connu.
    for (const k of Object.keys(nextStringsSnap)) knownStr.add(k);
    for (const k of Object.keys(nextRoutesSnap)) knownRt.add(k);
  }

  if (!isNewBuild && needsExtractSeed) {
    expDiff.added = [];
    expDiff.modified = [];
    expDiff.removed = [];
    expDiff.categoryChanged = [];
    strDiff.added = {};
    strDiff.modified = {};
    strDiff.removed = {};
    rtDiff.added = {};
    rtDiff.modified = {};
    rtDiff.removed = {};
  }

  console.log('TRUE DIFF', {
    urgentSent,
    exp: {
      added: expDiff.added.length,
      modified: expDiff.modified.length,
      removed: expDiff.removed.length,
      categoryChanged: (expDiff.categoryChanged || []).length,
    },
    str: {
      added: Object.keys(strDiff.added).length,
      modified: Object.keys(strDiff.modified).length,
      removed: Object.keys(strDiff.removed).length,
    },
    rt: {
      added: Object.keys(rtDiff.added).length,
      modified: Object.keys(rtDiff.modified).length,
      removed: Object.keys(rtDiff.removed).length,
    },
  });

  const hadNormalDiff = hasMapDiff(strDiff) || hasMapDiff(rtDiff);
  const hadExpDiff = hasExperimentDiff(expDiff);

  alreadyBuild =
    (typeof alreadyBuild !== 'undefined' && alreadyBuild) ||
    (await wasBuildAnnounced(build.buildNumber));

  let okN = true;
  let okExp = true;
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      if (!urgentSent) {
        const okU = await notifyUrgent({
          build,
          expDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (okU) {
          for (const e of expDiff.added) knownExp.add(String(e.id || e));
        } else {
          okExp = false;
          console.warn('URGENT retry path failed — NOT marking known exp');
        }
      } else {
        // CORE already announced pure adds — still send full-extract residual
        // (modified / removed / category) without re-sending added.
        // Avant : added: [] → les expériences trouvées UNIQUEMENT dans les
        // chunks (pas dans web.*) n'étaient jamais envoyées.
        const residual = {
          added: (expDiff.added || []).filter(
            (e) => !coreSentIds.has(String((e && e.id) || e)),
          ),
          modified: expDiff.modified || [],
          removed: expDiff.removed || [],
          categoryChanged: expDiff.categoryChanged || [],
        };
        const nRes =
          residual.added.length +
          residual.modified.length +
          residual.removed.length +
          residual.categoryChanged.length;
        if (nRes) {
          console.log('URGENT residual after CORE', {
            added: residual.added.length,
            modified: residual.modified.length,
            removed: residual.removed.length,
            categoryChanged: residual.categoryChanged.length,
          });
          const okR = await notifyUrgent({
            build,
            expDiff: residual,
            webhookUrl: process.env.DISCORD_WEBHOOK_URL,
            isNewBuild,
            catchUp: isCatchUp,
            prevBuild: prevBuildNum,
          });
          if (okR) {
            for (const e of residual.added) knownExp.add(String(e.id || e));
          } else {
            okExp = false;
            console.warn('URGENT residual webhook failed');
          }
        } else {
          console.log('URGENT already sent — no residual mod/removed');
        }
      }

      okN = await notifyNormal({
        build,
        isNewBuild: false,
        strDiff,
        rtDiff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
      if (okN) {
        for (const k of Object.keys(strDiff.added)) knownStr.add(k);
        for (const k of Object.keys(rtDiff.added)) knownRt.add(k);
        // Annoncé « supprimé » → sa réapparition doit être ré-annoncée
        for (const k of Object.keys(strDiff.removed)) knownStr.delete(k);
        for (const k of Object.keys(rtDiff.removed)) knownRt.delete(k);
      } else {
        console.warn('NORMAL webhook failed — NOT marking known str/rt');
      }
      if (isNewBuild && !alreadyBuild && okN) {
        await markBuild(build.buildNumber);
        alreadyBuild = true;
        console.log('BUILD marked after successful notifies', build.buildNumber);
      } else if (isNewBuild && !alreadyBuild && !okN) {
        console.warn('BUILD NOT marked — normal webhook failed (will retry)');
      }
    } catch (e) {
      okN = false;
      okExp = false;
      console.warn('notify failed', e.message);
    }
  } else if (hadNormalDiff || hadExpDiff) {
    okN = !hadNormalDiff;
    okExp = !hadExpDiff;
    console.error(
      'NOTIFY_CONFIG_ERROR: changes detected but DISCORD_WEBHOOK_URL is missing; state will not advance',
    );
  } else {
    if (isNewBuild && !alreadyBuild) {
      await markBuild(build.buildNumber);
      alreadyBuild = true;
    }
  }
  console.log('Notify done', Date.now() - t0 + 'ms');

  // --- Dismissible Content enum (added / removed) ---
  try {
    const dismissible = findings.dismissibleContent || {};
    const dcCount = Object.keys(dismissible).length;
    const isDcSeed = !(await fs.pathExists(path.join(DATA, 'dismissible_content.json')));
    await processDismissibleContent({
      dataDir: DATA,
      current: dismissible,
      buildNumber: build.buildNumber || build.number || null,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL || null,
      // Avant : « || isCatchUp » — or l'écart entre deux builds Canary est
      // presque toujours > 1 → la plupart des changements n'étaient jamais envoyés.
      isSeed: isDcSeed,
    });
    console.log('Dismissible Content done', dcCount);
  } catch (e) {
    console.warn('Dismissible Content failed:', String(e.message || e).slice(0, 160));
  }


  // Full transactional gate: nothing durable advances if normal notify failed
  // when there was something to announce (strings/routes). Experiments last_extract
  // and saveState are also gated so the next run can retry webhooks.
  const strRtOk = okN === true;
  // Avant : un échec d'envoi des EXPÉRIENCES n'empêchait pas d'avancer
  // last_extract_experiments → elles étaient perdues définitivement.
  const notifyCriticalOk = canAdvanceNotificationState({
    webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
    hasNormalDiff: hadNormalDiff,
    hasExpDiff: hadExpDiff,
    normalNotifyOk: strRtOk,
    experimentNotifyOk: okExp,
  });

  if (!notifyCriticalOk) {
    console.warn(
      'NOTIFY_FAIL: skipping ALL state advance (last_extract + saveState) — will retry next run',
    );
    try {
      await writeJsonAtomic(LAST_RUN_META, {
        schemaVersion: 1,
        buildNumber: String(build.buildNumber),
        ts: Date.now(),
        status: 'notify_failed',
        ok: false,
        reason: !process.env.DISCORD_WEBHOOK_URL
          ? 'WEBHOOK_MISSING'
          : okExp
            ? 'WEBHOOK_NORMAL_FAILED'
            : 'WEBHOOK_EXPERIMENTS_FAILED',
        durationMs: Date.now() - t0,
        experiments: (findings.experiments || []).length,
        strings: Object.keys(extractedStrings || {}).length,
        routes: Object.keys(nextRt || {}).length,
        downloadStats: findings.downloadStats || null,
      });
    } catch {}
    // Do not advance known_* on notify failure — next run must still see new items
    await archiveTask;
    process.exit(2);
  }

  // --- Atomic data generation (all-or-nothing after successful notify) ---
  await archiveTask;
  const runId = makeRunId(build.buildNumber);
  const bn = String(build.buildNumber);
  const tsIso = new Date().toISOString();

  const knownExpIds = [...knownExp]
    .filter((id) => id && !String(id).startsWith('hash:'))
    .sort();
  const knownStrIds = [...knownStr].filter(Boolean).sort();
  const knownRtIds = [...knownRt].filter(Boolean).sort();
  // knownExp is append-only — never truncate
  if (knownStrIds.length > 50000) knownStrIds.splice(0, knownStrIds.length - 50000);
  if (knownRtIds.length > 10000) knownRtIds.splice(0, knownRtIds.length - 10000);

  // Les trackers (apex guild / gist user) calculent les deux pourcentages ;
  // on les rattache ici aux expériences publiées (sinon 100 % unknown).
  const rolloutPcts = await loadRolloutPercentageMaps(DATA);
  const normalized = (findings.experiments || [])
    .map(experimentState.normalizeExperiment)
    .filter(Boolean)
    .map((e) => applyRolloutPercentages(e, rolloutPcts));
  const previousCurrent = await experimentState.loadCurrentExperiments(DATA);
  const previousRemoved = await experimentState.loadRemovedExperiments(DATA);
  const cov = experimentState.assessCoverage({
    currentCount: normalized.length,
    previousCount: previousCurrent.length,
    extractionStatus: 'complete',
    currentIds: normalized.map((e) => e.id),
    previousIds: previousCurrent.map((e) => e.id),
  });
  console.log('EXP_STATE coverage', cov);
  const stateCurrent = cov.reliable ? normalized : previousCurrent;
  const nextKnown = experimentState.mergeKnownIds(knownExpIds, normalized);
  const nextRemoved = cov.reliable
    ? experimentState.updateRemovedExperiments({
        previousCurrent,
        current: normalized,
        existingRemoved: previousRemoved,
        allowRemovals: true,
        buildNumber: bn,
        confirmedRemovedIds: (() => {
          const candidates =
            (rawDiff && (rawDiff.removedAll || rawDiff.removed)) ||
            expDiff.removed ||
            [];
          const out = [];
          const seen = new Set();
          for (const e of candidates) {
            const id = String(typeof e === 'string' ? e : (e && e.id) || '');
            if (!id || seen.has(id) || knownRemoved.has(id)) continue;
            seen.add(id);
            out.push(id);
          }
          return out;
        })(),
      })
    : previousRemoved;

  const allExps = findings.experiments || [];
  const apexList = allExps
    .filter((e) => e.system !== 'legacy')
    .map((e) => ({
      kind: e.kind || e.type || 'user',
      name: e.id,
      defaultConfig: e.defaultConfig || null,
      variations: e.variations || null,
      label: e.label || null,
    }));
  const legacyList = allExps.filter((e) => e.system === 'legacy');

  let mergedExps = mergeExp(prev.experiments, findings.experiments);
  if (expDiff.removed.length) {
    const drop = new Set(expDiff.removed.map((e) => String(e.id || e)));
    mergedExps = mergedExps.filter((e) => !drop.has(String(e.id)));
  }
  mergedExps = mergedExps.map((e) => applyRolloutPercentages(e, rolloutPcts));
  // Reseed : on repart de l'extract propre (purge des faux strings/routes accumulés)
  const mergedStrings = strRtVersionOk
    ? { ...(prev.strings || {}), ...extractedStrings }
    : { ...extractedStrings };
  for (const k of Object.keys(strDiff.removed)) delete mergedStrings[k];
  const mergedRoutes = strRtVersionOk ? { ...(prev.routes || {}), ...nextRt } : { ...nextRt };
  for (const k of Object.keys(rtDiff.removed)) delete mergedRoutes[k];

  const stamp = { runId, buildNumber: bn };
  const files = {
    'known_experiment_ids.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextKnown.length,
      ids: nextKnown,
    },
    'known_string_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownStrIds.length,
      ids: knownStrIds,
    },
    'known_route_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownRtIds.length,
      ids: knownRtIds,
    },
    'last_extract_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(nextExpSnap || {}).length,
      data: nextExpSnap || {},
    },
    'last_extract_strings.json': {
      ...stamp,
      extractVersion: STR_RT_EXTRACT_VERSION,
      updatedAt: tsIso,
      count: Object.keys(nextStringsSnap || {}).length,
      data: nextStringsSnap || {},
    },
    'last_extract_routes.json': {
      ...stamp,
      extractVersion: STR_RT_EXTRACT_VERSION,
      updatedAt: tsIso,
      count: Object.keys(nextRoutesSnap || {}).length,
      data: nextRoutesSnap || {},
    },
    'current_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: stateCurrent.length,
      experiments: stateCurrent,
    },
    'removed_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextRemoved.length,
      experiments: nextRemoved,
    },
    'apex_experiments.json': apexList,
    'experiments.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: {
        all: mergedExps.length,
        legacy: legacyList.length,
        apex: apexList.length,
      },
      // Always full merge — legacy-only broke baseline load (6 vs 360)
      experiments: mergedExps,
      legacyExperiments: legacyList,
    },
    'build.json': {
      ...stamp,
      versionHash: build.versionHash || null,
      releaseChannel: build.releaseChannel || 'canary',
      scrapedAt: build.scrapedAt || tsIso,
      assetCount: Array.isArray(build.assets) ? build.assets.length : null,
      cssCount: Array.isArray(build.cssAssets) ? build.cssAssets.length : null,
    },
    'findings.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: { all: mergedExps.length },
      experiments: mergedExps,
    },
    'strings.json': mergedStrings,
    'routes.json': mergedRoutes,
    'meta.json': {
      ...stamp,
      initialized: true,
      updatedAt: tsIso,
      experimentCount: mergedExps.length,
      stringCount: Object.keys(mergedStrings).length,
      routeCount: Object.keys(mergedRoutes).length,
      lastBuild: bn,
    },
    'last_run_meta.json': {
      schemaVersion: 1,
      runId,
      buildNumber: bn,
      ts: Date.now(),
      status: 'success',
      ok: true,
      versionHash: build.versionHash || null,
      durationMs: Date.now() - t0,
      experiments: (findings.experiments || []).length,
      strings: Object.keys(extractedStrings || {}).length,
      routes: Object.keys(nextRt || {}).length,
      downloadStats: findings.downloadStats || null,
    },
  };

  try {
    await publishDataGeneration(DATA, {
      runId,
      buildNumber: bn,
      files,
    });
    console.log('EXP_STATE published', {
      current: normalized.length,
      known: nextKnown.length,
      removed: nextRemoved.length,
      reliable: cov.reliable,
    });
  } catch (e) {
    console.error('DATA_PUBLISH failed — baseline not advanced', e.message);
    try {
      await writeJsonAtomic(LAST_RUN_META, {
        schemaVersion: 1,
        runId,
        buildNumber: bn,
        ts: Date.now(),
        status: 'publish_failed',
        ok: false,
        reason: String(e.message || e).slice(0, 500),
        durationMs: Date.now() - t0,
      });
    } catch {}
    process.exit(1);
  }

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}

function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    if (e == null) continue;
    if (typeof e === 'object') {
      if (!e.id) continue;
      map.set(String(e.id), e);
    } else if (e !== '') {
      map.set(String(e), { id: String(e) });
    }
  }
  for (const e of next || []) {
    if (!e || typeof e !== 'object' || !e.id) continue;
    map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * Diff pur d'une map clé→valeur (strings ou routes).
 *
 * `k in obj` consultait la chaîne de prototypes : une clé extraite comme
 * "constructor" ou "toString" était considérée comme DÉJÀ connue → jamais
 * annoncée, et sa modification pouvait être perdue. On teste désormais
 * uniquement les propriétés propres.
 *
 * @param {object} last - map de référence (run précédent)
 * @param {object} extracted - map extraite de ce build
 * @param {{known?:Set<string>, isCatchUp?:boolean, maxAdded?:number,
 *          maxRemoved?:number}} opts
 * @returns {{added:object, modified:object, removed:object}}
 */
function computeMapDiff(last, extracted, opts = {}) {
  const prev = last && typeof last === 'object' ? last : {};
  const cur = extracted && typeof extracted === 'object' ? extracted : {};
  const known = opts.known instanceof Set ? opts.known : new Set(opts.known || []);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const added = {};
  const modified = {};
  const removed = {};

  for (const [k, v] of Object.entries(cur)) {
    if (!hasOwn(prev, k)) {
      if (opts.isCatchUp || !known.has(k)) added[k] = v;
    } else if (String(prev[k]) !== String(v)) {
      modified[k] = v;
    }
  }

  const curCount = Object.keys(cur).length;
  const prevCount = Object.keys(prev).length;
  const ratio = curCount / Math.max(prevCount, 1);
  if (ratio >= 0.75 && ratio <= 1.35) {
    for (const [k, v] of Object.entries(prev)) {
      if (!hasOwn(cur, k)) removed[k] = v;
    }
    const maxRemoved = opts.maxRemoved != null ? opts.maxRemoved : Infinity;
    if (Object.keys(removed).length > maxRemoved) {
      for (const k of Object.keys(removed)) delete removed[k];
    }
  }

  const maxAdded = opts.maxAdded != null ? opts.maxAdded : Infinity;
  const addedKeys = Object.keys(added);
  if (addedKeys.length > maxAdded) {
    for (const k of addedKeys.slice(maxAdded)) delete added[k];
  }
  return { added, modified, removed };
}

/**
 * Keep the last trusted baseline when a map extraction is below its minimum
 * coverage. Promoting a partial map would silently consume unseen changes.
 */
function selectNextMapBaseline(last, extracted, minCurrentCount) {
  const previous =
    last && typeof last === 'object' && !Array.isArray(last) ? last : {};
  const current =
    extracted && typeof extracted === 'object' && !Array.isArray(extracted)
      ? extracted
      : {};
  const required =
    typeof minCurrentCount === 'number' &&
    Number.isFinite(minCurrentCount) &&
    minCurrentCount >= 0
      ? Math.floor(minCurrentCount)
      : Infinity;
  return Object.keys(current).length >= required ? current : previous;
}

async function markBuild(buildNumber, file = ANNOUNCED) {
  let data = { builds: [] };
  try {
    if (await fs.pathExists(file)) data = await fs.readJson(file);
  } catch (e) {
    console.warn('markBuild: failed to read', file, '-', e.message);
  }
  // `builds` corrompu (chaîne, objet) faisait lever markBuild APRÈS les
  // notifications → aucune avancée d'état, run en échec à chaque fois.
  const builds = data && Array.isArray(data.builds) ? data.builds : [];
  const set = new Set(builds.map(String));
  set.add(String(buildNumber));
  await writeJsonAtomic(file, {
    builds: [...set].slice(-300),
    updatedAt: new Date().toISOString(),
  });
}

async function wasBuildAnnounced(buildNumber, file = ANNOUNCED) {
  try {
    if (!(await fs.pathExists(file))) return false;
    const data = await fs.readJson(file);
    const builds = data && Array.isArray(data.builds) ? data.builds : [];
    return builds.map(String).includes(String(buildNumber));
  } catch {
    return false;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  main,
  buildGap,
  computeExpDiff,
  mergeExp,
  computeMapDiff,
  selectNextMapBaseline,
  expSnapshot,
  loadLastMap,
  loadKnownIds,
  markBuild,
  wasBuildAnnounced,
  MIN_EXP_FOR_DIFF,
};
