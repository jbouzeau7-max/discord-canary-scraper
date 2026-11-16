/**
 * Mobile experiments / strings from real client JS dumps.
 * Source : MOBILE_DATAMINE_REPO (git URL avec discord_app / discord_common/js),
 * par défaut le dépôt public Wumpus-Central/discord-mobile-datamining.
 * Annonce comme le scraper Canary : expériences ajoutées / modifiées /
 * supprimées / catégorie changée, strings ajoutées / supprimées, routes
 * ajoutées / modifiées / supprimées (même rendu, titres « Mobile … »).
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { inferType } = require('./lib/infer_type');
const { writeJsonAtomic } = require('./lib/atomic');
const mobileExtract = require('./lib/mobile_extract');
const experimentState = require('./lib/experiment_state');
const { notifyUrgent, notifyNormal } = require('./lib/notify');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORK_DIR = path.join(__dirname, '..', '.mobile_datamine');
const STATE_FILE = path.join(DATA_DIR, 'mobile_experiments.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known_mobile_experiment_ids.json');
const WEBHOOK_URL =
  (process.env.MOBILE_FILES_WEBHOOK_URL || '').trim() || (process.env.DISCORD_WEBHOOK_URL || '').trim() || null;

// Source par défaut : dépôt public déjà utilisé pour les versions Android.
// Avant : sans le secret MOBILE_DATAMINE_REPO, toute l'étape était ignorée.
const DEFAULT_SOURCE_REPO = 'https://github.com/Wumpus-Central/discord-mobile-datamining.git';
const SOURCE_REPO = (process.env.MOBILE_DATAMINE_REPO || '').trim() || DEFAULT_SOURCE_REPO;
const STATE_FORMAT = 2;
const CANARY_STRINGS_FILE = path.join(DATA_DIR, 'strings.json');

function isExpId(id) {
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 80 * 1024 * 1024,
  });
}

async function syncSourceRepo() {
  if (!SOURCE_REPO) {
    throw new Error(
      'Set MOBILE_DATAMINE_REPO to a git URL with mobile client JS (discord_app / discord_common/js)',
    );
  }
  await fs.ensureDir(path.dirname(WORK_DIR));
  if (!(await fs.pathExists(path.join(WORK_DIR, '.git')))) {
    await fs.remove(WORK_DIR);
    await fs.ensureDir(WORK_DIR);
    run(
      `git clone --depth 1 --filter=blob:none --sparse "${SOURCE_REPO}" "${WORK_DIR}"`,
      path.dirname(WORK_DIR),
    );
    run(
      'git sparse-checkout set discord_app discord_common/js _runtime',
      WORK_DIR,
    );
  } else {
    try {
      run('git fetch --depth 1 origin', WORK_DIR);
      run('git reset --hard origin/HEAD', WORK_DIR);
      run(
        'git sparse-checkout set discord_app discord_common/js _runtime',
        WORK_DIR,
      );
    } catch (e) {
      console.warn('git update failed, reclone…', e.message);
      await fs.remove(WORK_DIR);
      return syncSourceRepo();
    }
  }

  let head = 'unknown';
  try {
    head = run('git rev-parse --short HEAD', WORK_DIR).trim();
  } catch (e) {
    console.warn('getRepoInfo: git rev-parse failed -', e.message);
  }
  let msg = '';
  try {
    msg = run('git log -1 --pretty=%s', WORK_DIR).trim();
  } catch (e) {
    console.warn('getRepoInfo: git log failed -', e.message);
  }
  let full = null;
  try {
    full = run('git rev-parse HEAD', WORK_DIR).trim();
  } catch {}
  return { dir: WORK_DIR, commit: head, full, message: msg };
}

/** SHA du HEAD distant via `git ls-remote` (null si indisponible). */
function remoteHeadSha(repo) {
  try {
    const out = execSync(`git ls-remote "${repo}" HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    const m = out.match(/^([0-9a-f]{40})\s+HEAD/m);
    return m ? m[1] : null;
  } catch (e) {
    console.warn('ls-remote failed:', e.message.split('\n')[0]);
    return null;
  }
}

async function collectJsFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === '__tests__'
        )
          continue;
        await walk(p);
      } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(ent.name)) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

function extractFromContent(content, expMap, strings) {
  const reNK =
    /\{\s*name\s*:\s*["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']\s*,\s*kind\s*:\s*["'](user|guild)["']/gi;
  let m;
  while ((m = reNK.exec(content)) !== null) {
    const id = m[1];
    const type = m[2].toLowerCase();
    if (!isExpId(id) || expMap.has(id)) continue;
    expMap.set(id, { id, type, kind: type, source: 'mobile_files' });
  }
  const reKN =
    /\{\s*kind\s*:\s*["'](user|guild)["']\s*,\s*name\s*:\s*["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reKN.exec(content)) !== null) {
    const type = m[1].toLowerCase();
    const id = m[2];
    if (!isExpId(id) || expMap.has(id)) continue;
    expMap.set(id, { id, type, kind: type, source: 'mobile_files' });
  }

  const reExp = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reExp.exec(content)) !== null) {
    const id = m[1];
    if (!isExpId(id) || expMap.has(id)) continue;
    expMap.set(id, {
      id,
      type: inferType(id),
      kind: inferType(id),
      source: 'mobile_files',
    });
  }

  const reStr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  while ((m = reStr.exec(content)) !== null) {
    if (m[1].length !== 6) continue;
    if (/^[0-9a-f]{6}$/i.test(m[1])) continue;
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (typeof val === 'string' && val.length >= 2 && val.length <= 400) {
      strings[m[1]] = val;
    }
  }
}

async function loadKnown() {
  const set = new Set();
  try {
    if (await fs.pathExists(KNOWN_FILE)) {
      const d = await fs.readJson(KNOWN_FILE);
      for (const id of d.ids || []) set.add(String(id));
    }
  } catch (e) {
    console.warn('loadKnown: failed to read', KNOWN_FILE, '-', e.message);
  }
  return set;
}

async function saveKnown(set) {
  const ids = [...set].sort();
  await writeJsonAtomic(
    KNOWN_FILE,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    2,
  );
}

const TYPE_EMOJI = { user: '👤', guild: '🏠' };

/** Embed groupé des nouvelles expériences mobiles (triées user → guild). */
function experimentsEmbed(newExps, meta) {
  const sorted = [...newExps].sort((a, b) =>
    String(a.type || 'user').localeCompare(String(b.type || 'user')) || a.id.localeCompare(b.id));
  const shown = sorted.slice(0, 25);
  const lines = shown.map((e) => `${TYPE_EMOJI[e.type] || '🧪'} \`${e.id}\` · ${e.type || 'user'}`);
  if (sorted.length > shown.length) lines.push(`_…and ${sorted.length - shown.length} more_`);
  const counts = sorted.reduce((acc, e) => { const k = e.type || 'user'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const fields = Object.entries(counts).map(([k, n]) => ({ name: `${TYPE_EMOJI[k] || '🧪'} ${k}`, value: String(n), inline: true }));
  if (meta.message) fields.push({ name: 'Source revision', value: meta.message.slice(0, 100), inline: false });
  return {
    title: `🧪 Mobile Experiments · ${sorted.length} new`,
    description: lines.join('\n').slice(0, 4000),
    color: 0xeb459e,
    fields,
    footer: { text: `Datamining · Mobile files · ${meta.commit}` },
    timestamp: new Date().toISOString(),
  };
}

/** Embed des nouvelles strings mobiles (bloc diff). */
function stringsEmbed(added, meta) {
  const entries = Object.entries(added || {});
  const shown = entries.slice(0, 35);
  const body = shown.map(([k, v]) => `+ ${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 90)}`).join('\n');
  const more = entries.length > shown.length ? `\n_…and ${entries.length - shown.length} more_` : '';
  return {
    title: `📝 Mobile Strings · ${entries.length} added`,
    description: ('```diff\n' + body.slice(0, 3700) + '\n```' + more),
    color: 0x57f287,
    footer: { text: `Datamining · Mobile files · ${meta.commit}` },
    timestamp: new Date().toISOString(),
  };
}

/** Lit tous les fichiers source (ordre trié : résultat déterministe). */
async function readSources(root) {
  const files = (await collectJsFiles(root)).sort();
  const items = [];
  const READ_BATCH = 32;
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = files.slice(i, i + READ_BATCH);
    const read = await Promise.all(
      batch.map(async (fp) => {
        try {
          const st = await fs.stat(fp);
          if (st.size > 8_000_000) return null;
          return { file: path.relative(root, fp), content: await fs.readFile(fp, 'utf8') };
        } catch (e) {
          console.warn('readSources: failed', fp, '-', e.message);
          return null;
        }
      }),
    );
    for (const it of read) if (it) items.push(it);
  }
  return items;
}

/** « 355.5 (355205) runtime » → « 355.5 (355205) ». */
function buildLabel(meta) {
  const m = String(meta?.message || '').match(/^(\d{3}\.\d{1,2}\s*\(\d{5,}\))/);
  if (m) return m[1];
  return String(meta?.commit || '?');
}

/** Snapshot compact persistant (sans le texte brut des fichiers). */
function expSnapshot(e) {
  const out = { id: e.id, kind: e.kind, type: e.kind, system: e.system || null };
  if (e.label) out.label = e.label;
  if (e.defaultConfig) out.defaultConfig = e.defaultConfig;
  if (e.variations) out.variations = e.variations;
  if (e.treatments) out.treatments = e.treatments;
  if (e.file) out.file = e.file;
  if (e.source) out.source = e.source;
  return out;
}

/**
 * Diff map clé→valeur (strings / routes). Les suppressions ne sont comptées
 * que si la couverture est comparable (pas d'extraction partielle).
 */
function diffMap(prev, cur, { compareValues = true } = {}) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const c = cur && typeof cur === 'object' ? cur : {};
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const added = {};
  const modified = {};
  const removed = {};
  for (const [k, v] of Object.entries(c)) {
    if (!own(p, k)) added[k] = v;
    else if (compareValues && String(p[k]) !== String(v)) modified[k] = v;
  }
  const pc = Object.keys(p).length;
  const ratio = Object.keys(c).length / Math.max(pc, 1);
  if (pc && ratio >= 0.75 && ratio <= 1.35) {
    for (const [k, v] of Object.entries(p)) if (!own(c, k)) removed[k] = v;
  }
  return { added, modified, removed };
}

const countMap = (d) =>
  Object.keys(d.added).length + Object.keys(d.modified).length + Object.keys(d.removed).length;

/**
 * Calcule le diff complet mobile (pur, testable).
 * @returns {{expDiff, strDiff, rtDiff, seeded:boolean, degraded:string|null}}
 */
function computeMobileDiff(previous, findings, opts = {}) {
  const known = opts.knownIds instanceof Set ? opts.knownIds : new Set(opts.knownIds || []);
  const prevFormat = previous && previous.format === STATE_FORMAT;
  const prevExps = (previous && previous.experiments) || [];
  const curExps = findings.experiments || [];
  const prevStr = (prevFormat && previous.strings) || {};
  const prevRt = (prevFormat && previous.routes) || {};
  const empty = { added: {}, modified: {}, removed: {} };

  // Garde de dégradation (dépôt source tronqué, mauvaise branche...).
  const pE = prevExps.length;
  const cE = curExps.length;
  if (pE >= 30 && cE < Math.max(5, pE * 0.5)) return { degraded: `experiments ${pE} → ${cE}` };
  const pS = Object.keys(prevStr).length;
  const cS = Object.keys(findings.strings || {}).length;
  if (pS >= 100 && cS < Math.max(20, pS * 0.5)) return { degraded: `strings ${pS} → ${cS}` };
  const pR = Object.keys(prevRt).length;
  const cR = Object.keys(findings.routes || {}).length;
  if (pR >= 50 && cR < Math.max(20, pR * 0.5)) return { degraded: `routes ${pR} → ${cR}` };

  if (!prevFormat) {
    // Migration / premier run : seules les expériences inédites (ids jamais
    // vus) sont annoncées, le reste sert de base.
    const added = curExps.filter((e) => !known.has(String(e.id)));
    const hadAny = known.size > 0 || pE > 0;
    return {
      expDiff: { added: hadAny ? added : [], modified: [], removed: [], categoryChanged: [] },
      strDiff: empty,
      rtDiff: empty,
      seeded: true,
      degraded: null,
    };
  }

  const reliable = pE > 0 && cE >= pE * 0.85;
  const removedIds = new Set((previous.removedIds || []).map(String));
  const raw = experimentState.diffExperiments(prevExps, curExps, reliable, {
    knownIds: known,
    removedIds,
  });
  const expDiff = experimentState.toNotifyExpDiff(raw);
  // Le texte des strings vient du dictionnaire Canary : une valeur qui change
  // reflète Canary, pas le client mobile → seuls ajouts / suppressions.
  const strDiff = diffMap(prevStr, findings.strings, { compareValues: false });
  const rtDiff = diffMap(prevRt, findings.routes, { compareValues: true });
  return { expDiff, strDiff, rtDiff, seeded: false, degraded: null, rawDiff: raw };
}

async function loadCanaryStrings() {
  try {
    if (await fs.pathExists(CANARY_STRINGS_FILE)) return await fs.readJson(CANARY_STRINGS_FILE);
  } catch (e) {
    console.warn('loadCanaryStrings:', e.message);
  }
  return {};
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('=== Mobile files datamine ===');
  if (/^(1|true)$/i.test(process.env.MOBILE_FILES_PAUSED || '')) {
    console.log('MOBILE_FILES_PAUSED — skip');
    return;
  }
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {
      console.warn('loadPrevious: failed to read', STATE_FILE, '-', e.message);
    }
  }
  const force = process.env.MOBILE_FILES_FORCE === '1';
  const upToDate = (sha) =>
    !force && previous && previous.format === STATE_FORMAT && previous.notifyOk !== false &&
    sha && (previous.sourceCommitFull === sha || previous.sourceCommit === sha);

  // Contrôle rapide (quelques Ko) avant de cloner ~240 Mo : rien à faire si
  // le dépôt source n'a pas bougé depuis le dernier run réussi.
  const remoteHead = remoteHeadSha(SOURCE_REPO);
  if (upToDate(remoteHead)) {
    console.log('Source unchanged since last run (' + remoteHead.slice(0, 8) + ') — nothing to do');
    return;
  }

  const meta = await syncSourceRepo();
  console.log('Source commit:', meta.commit, meta.message);
  if (upToDate(meta.full) || upToDate(meta.commit)) {
    console.log('Source unchanged since last run — nothing to do');
    return;
  }

  const t0 = Date.now();
  const items = await readSources(meta.dir);
  const scan = mobileExtract.scanContents(items);
  const dict = await loadCanaryStrings();
  const strings = mobileExtract.resolveStrings(scan.stringKeys, dict);
  const findings = { experiments: scan.experiments.map(expSnapshot), strings, routes: scan.routes };
  console.log(
    `Scanned ${items.length} files in ${Date.now() - t0} ms →`,
    'experiments', findings.experiments.length,
    '| strings', Object.keys(strings).length,
    '| routes', Object.keys(scan.routes).length,
  );

  const known = await loadKnown();
  for (const e of previous?.experiments || []) if (e?.id) known.add(String(e.id));

  const diff = computeMobileDiff(previous, findings, { knownIds: known });
  if (diff.degraded) {
    console.error('MOBILE_FILES_DEGRADED:', diff.degraded, '- state NOT updated');
    process.exit(1);
  }
  const { expDiff, strDiff, rtDiff } = diff;
  const nExp =
    expDiff.added.length + expDiff.modified.length + expDiff.removed.length + expDiff.categoryChanged.length;
  console.log(
    diff.seeded ? 'Seed/migration run —' : 'Diff —',
    `experiments +${expDiff.added.length} ~${expDiff.modified.length} -${expDiff.removed.length} cat${expDiff.categoryChanged.length}`,
    `| strings +${Object.keys(strDiff.added).length} -${Object.keys(strDiff.removed).length}`,
    `| routes +${Object.keys(rtDiff.added).length} ~${Object.keys(rtDiff.modified).length} -${Object.keys(rtDiff.removed).length}`,
  );

  let notifyOk = true;
  if ((nExp || countMap(strDiff) || countMap(rtDiff)) && WEBHOOK_URL) {
    const build = { buildNumber: buildLabel(meta) };
    const scope = { titlePrefix: 'Mobile', footerLabel: 'Mobile', keyPrefix: 'mobile:' };
    try {
      const [okE, okN] = await Promise.all([
        notifyUrgent({ build, expDiff, webhookUrl: WEBHOOK_URL, scope }),
        notifyNormal({ build, strDiff, rtDiff, webhookUrl: WEBHOOK_URL, scope }),
      ]);
      notifyOk = okE && okN;
    } catch (e) {
      console.warn('NOTIFY_FAIL:', e.message);
      notifyOk = false;
    }
    if (!notifyOk) {
      console.warn('NOTIFY_FAIL - state NOT advanced (retry next run)');
      process.exit(2);
    }
  } else if (!WEBHOOK_URL) {
    console.log('No webhook - seed state without notify');
  }

  for (const e of findings.experiments) known.add(String(e.id));
  const removedIds = new Set((previous?.removedIds || []).map(String));
  for (const e of expDiff.removed) removedIds.add(String(e.id || e));
  for (const e of findings.experiments) removedIds.delete(String(e.id));

  const state = {
    format: STATE_FORMAT,
    scrapedAt: new Date().toISOString(),
    sourceRepo: SOURCE_REPO.replace(/\/\/[^@/]+@/, '//'),
    sourceCommit: meta.commit,
    sourceCommitFull: meta.full || null,
    sourceMessage: meta.message,
    build: buildLabel(meta),
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(strings).length,
    routeCount: Object.keys(scan.routes).length,
    lastDiff: {
      experiments: {
        added: expDiff.added.length,
        modified: expDiff.modified.length,
        removed: expDiff.removed.length,
        categoryChanged: expDiff.categoryChanged.length,
      },
      strings: { added: Object.keys(strDiff.added).length, removed: Object.keys(strDiff.removed).length },
      routes: {
        added: Object.keys(rtDiff.added).length,
        modified: Object.keys(rtDiff.modified).length,
        removed: Object.keys(rtDiff.removed).length,
      },
    },
    notifyOk,
    removedIds: [...removedIds].sort().slice(-2000),
    experiments: findings.experiments,
    strings,
    routes: scan.routes,
  };
  await writeJsonAtomic(STATE_FILE, state, 2);
  await saveKnown(known);
  console.log('=== Mobile files done ===');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  experimentsEmbed,
  stringsEmbed,
  isExpId,
  extractFromContent,
  computeMobileDiff,
  diffMap,
  buildLabel,
  expSnapshot,
  STATE_FORMAT,
};
