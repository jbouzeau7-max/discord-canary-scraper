/**
 * Extract from Discord Canary assets.
 *
 * Pipeline:
 *  1) Clear assetsDir (no stale web.* from previous build)
 *  2) Download web.* (robust: atomic, retry, 429)
 *  3) Parallel core extract → onCore (URGENT experiments)
 *  4) Parse webpack chunk map → download ALL chunks
 *  5) en-US locales → strings
 *  6) Scan every JS for routes + experiments enrichment
 */
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const {
  downloadList,
  assertWebBundle,
  clearAssetsDir,
  getDownloadStats,
  resetDownloadStats,
  DOWNLOAD_CONCURRENCY,
} = require('./download');
const { inferType } = require('./infer_type');
const { envNumber } = require('./utils');
const { extractDismissibleContent } = require('./dismissible_content');

// Priority path still starts with web.*; full chunks after unless disabled
const FULL_CHUNKS = process.env.SCRAPE_FULL_CHUNKS !== '0';
const DOWNLOAD_CSS = process.env.SCRAPE_CSS === '1';
// 16 Mo : un chunk de 6,15 Mo était ignoré avec l'ancienne limite (6 Mo)
const MAX_CHUNK_SCAN_BYTES = envNumber('MAX_CHUNK_SCAN_BYTES', 16_000_000, { min: 1024 });
// Scan des chunks en parallèle (0 = auto). Le scan séquentiel de ~150 Mo coûtait
// ~6,6 s juste avant la notification ; réparti sur 4 workers il tombe à ~2 s.
const CHUNK_SCAN_WORKERS = envNumber('CHUNK_SCAN_WORKERS', 0, { min: 0, int: true });
const CHUNK_SCAN_MIN_FILES = envNumber('CHUNK_SCAN_MIN_FILES', 200, { min: 1, int: true });
// Condition nécessaire (et suffisamment large) pour qu'une route soit trouvée :
// une quote, un slash, puis au moins deux caractères de chemin.
const ROUTE_HINT_RE = /["'`]\/[a-zA-Z0-9_\-./{}@:$]{2,}/;
const ASSET_BASE = 'https://canary.discord.com/assets/';

function matchEnd(m) {
  return m.index + m[0].length;
}

/** Nombre de workers pour le scan des chunks (1 = séquentiel). */
function chunkScanWorkerCount(fileCount) {
  if (CHUNK_SCAN_WORKERS > 0) return Math.max(1, Math.min(CHUNK_SCAN_WORKERS, fileCount));
  if (fileCount < CHUNK_SCAN_MIN_FILES) return 1;
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus() || []).length;
  // 2 cœurs : le surcoût des workers dépasse le gain (mesuré 4,9 s vs 4,1 s) —
  // le runner GitHub en a 4, c'est là que le parallélisme paie.
  if ((cpus || 1) < 4) return 1;
  return Math.max(1, Math.min(4, cpus, fileCount));
}

/** Scanne une tranche de fichiers dans un worker ; renvoie la moisson + couverture. */
function scanSliceInWorker(dir, files, maxScanBytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'chunk_scan_worker.js'), {
      workerData: { dir, files, maxScanBytes },
    });
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.once('message', (msg) => done(resolve, msg));
    worker.once('error', (err) => done(reject, err));
    worker.once('exit', (code) => {
      if (code !== 0) done(reject, new Error('chunk scan worker exit ' + code));
    });
  });
}

/**
 * Scan parallèle des chunks téléchargés. Chaque worker traite une tranche
 * (fichiers entrelacés pour équilibrer les tailles) ; la fusion se fait ici,
 * dans l'ordre des tranches, puis les compteurs de couverture sont additionnés
 * pour garder exactement les mêmes gardes de dégradation qu'en séquentiel.
 * @returns {Promise<{routes:object, dismissible:object, experiments:Map, coverage:object}|null>}
 *   null si un worker échoue : l'appelant retombe sur le scan séquentiel.
 */
async function scanChunksParallel(dir, files) {
  const count = chunkScanWorkerCount(files.length);
  if (count <= 1) return null;
  const slices = Array.from({ length: count }, () => []);
  files.forEach((f, i) => slices[i % count].push(f));
  let parts;
  try {
    parts = await Promise.all(
      slices.map((slice) => scanSliceInWorker(dir, slice, MAX_CHUNK_SCAN_BYTES)),
    );
  } catch (e) {
    console.warn('chunk scan worker failed, fallback séquentiel:', e.message);
    return null;
  }
  const routes = {};
  const dismissible = {};
  const experiments = new Map();
  const coverage = {
    scanned: 0,
    skippedEmpty: 0,
    skippedOversize: 0,
    readErrors: 0,
    bytesScanned: 0,
    bytesSkippedOversize: 0,
  };
  for (const part of parts) {
    if (!part) continue;
    Object.assign(routes, part.routes || {});
    Object.assign(dismissible, part.dismissible || {});
    for (const e of part.experiments || []) {
      if (e && e.id != null && !experiments.has(String(e.id))) experiments.set(String(e.id), e);
    }
    const c = part.coverage || {};
    for (const k of Object.keys(coverage)) coverage[k] += Number(c[k]) || 0;
  }
  return { routes, dismissible, experiments, coverage, workers: count };
}

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir, onCore }) {
  await fs.ensureDir(assetsDir);
  if (cacheDir) await fs.ensureDir(cacheDir);
  await clearAssetsDir(assetsDir);
  resetDownloadStats();

  const htmlAssets = [...(build.assets || [])];
  const cssAssets = [...(build.cssAssets || [])];

  const cssInventory = {};
  for (const url of cssAssets) {
    const name = path.basename(String(url).split('?')[0]);
    const m = name.match(/^(.+)\.([a-f0-9]{8,})\.css$/i);
    if (m) cssInventory[m[1]] = m[2];
    else cssInventory[name] = name;
  }
  console.log('CSS listed from HTML:', Object.keys(cssInventory).length);

  let webAssets = htmlAssets.filter((u) => /\/web\./i.test(u));
  if (!webAssets.length) {
    // Guessing random HTML assets produces partial extracts and false "removed".
    throw new Error(
      'WEB_BUNDLE_NOT_FOUND: no web.* in HTML assets — refuse extract (was: silent first-5 fallback)',
    );
  }
  console.log('PRIORITY: download web.* (' + webAssets.length + ')');
  await downloadList(webAssets, assetsDir, !!forceRefresh);
  await assertWebBundle(assetsDir);

  const webFiles = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  let webContent = '';
  for (const f of webFiles) {
    webContent += await fs.readFile(path.join(assetsDir, f), 'utf8');
  }

  const strings = {};
  const routes = {};
  const expSet = new Map();
  const dismissibleContent = {};

  const chunkUrls = resolveAllChunkUrls(webContent);
  const htmlRest = htmlAssets.filter((u) => !/\/web\./i.test(u));
  const localeUrls = resolveEnUsLocaleUrls(webContent);
  // Les chunks de locale figurent aussi dans le map webpack : on les retire du
  // lot massif pour ne jamais écrire le même .part depuis deux téléchargements
  // concurrents (ils sont récupérés en force, plus frais).
  const localeNames = new Set(localeUrls.map((u) => path.basename(String(u).split('?')[0])));
  const allUrls = dedupeUrls([...chunkUrls, ...htmlRest]).filter(
    (u) => !localeNames.has(path.basename(String(u).split('?')[0])),
  );
  console.log('Webpack chunks mapped:', chunkUrls.length, '| HTML extras:', htmlRest.length, '| total unique:', allUrls.length);

  // Téléchargements lancés AVANT l'extraction CORE : les notifications
  // urgentes (web.*) partent pendant que les chunks arrivent, au lieu
  // d'attendre la grosse étape réseau. Locale et chunks en PARALLÈLE.
  // Les erreurs sont capturées immédiatement (pas de rejet non géré pendant
  // l'attente de onCore) puis re-levées après.
  let chunksError = null;
  let localeError = null;
  const chunksPromise =
    FULL_CHUNKS && allUrls.length
      ? downloadList(allUrls, assetsDir, false).catch((e) => {
          chunksError = e;
        })
      : Promise.resolve();
  if (FULL_CHUNKS && allUrls.length) {
    console.log('FULL DOWNLOAD: all chunks (concurrency', DOWNLOAD_CONCURRENCY + ')');
  } else if (!FULL_CHUNKS) {
    console.log('SCRAPE_FULL_CHUNKS=0 — skip mass chunk download');
  }
  const localePromise = localeUrls.length
    ? downloadList(localeUrls, assetsDir, true).catch((e) => {
        localeError = e;
      })
    : Promise.resolve();
  console.log('en-US locale chunks:', localeUrls.length);

  // CORE (web.*) + notifications urgentes PENDANT les téléchargements.
  if (webContent) {
    try {
      await extractCoreParallel(webContent, { routes, expSet, strings });
      extractDismissibleContent(webContent, dismissibleContent);
    } catch (e) {
      console.error('web extract error', e.message);
      throw e;
    }
  }

  if (typeof onCore === 'function') {
    const experiments = [...expSet.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    console.log('CORE ready', {
      experiments: experiments.length,
      routes: Object.keys(routes).length,
      stringsWeb: Object.keys(strings).length,
    });
    await onCore({
      experiments,
      routes: { ...routes },
      stringsWeb: { ...strings },
    });
  }

  await Promise.all([chunksPromise, localePromise]);
  if (chunksError) throw chunksError;
  if (localeError) throw localeError;

  if (localeUrls.length) {
    let fromLocale = 0;
    for (const url of localeUrls) {
      const name = path.basename(url.split('?')[0]);
      const fp = path.join(assetsDir, name);
      try {
        if (!(await fs.pathExists(fp))) continue;
        const content = await fs.readFile(fp, 'utf8');
        const before = Object.keys(strings).length;
        extractLocaleStrings(content, strings);
        fromLocale += Object.keys(strings).length - before;
      } catch (e) {
        console.warn('locale', name, e.message);
      }
    }
    console.log('Strings from en-US locales +', fromLocale, 'total', Object.keys(strings).length);
  }

  const jsFiles = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', jsFiles.length, 'JS files for routes/experiments');

  // Coverage: distinguish downloaded vs actually parsed (false "removed" risk).
  const coverage = {
    jsOnDisk: jsFiles.length,
    webFiles: 0,
    scanned: 0,
    skippedEmpty: 0,
    skippedOversize: 0,
    skippedWeb: 0,
    readErrors: 0,
    bytesScanned: 0,
    bytesSkippedOversize: 0,
    maxScanBytes: MAX_CHUNK_SCAN_BYTES,
    chunkUrlsMapped: chunkUrls.length,
    localeUrlsMapped: localeUrls.length,
    fullChunks: !!FULL_CHUNKS,
  };

  // Phase 1: stat tous les fichiers en parallèle (I/O bound)
  const toScan = [];
  for (const f of jsFiles) {
    if (/^web\./i.test(f)) {
      coverage.webFiles++;
      coverage.skippedWeb++;
      continue; // already extracted in core path
    }
    toScan.push({ f, fp: path.join(assetsDir, f) });
  }

  // Scan des chunks : plusieurs workers (le scan séquentiel de ~150 Mo coûtait
  // ~6,6 s juste avant la notification) avec repli séquentiel si un worker casse.
  const parallelScan = await scanChunksParallel(assetsDir, toScan.map((s) => s.f));
  if (parallelScan) {
    Object.assign(routes, parallelScan.routes);
    Object.assign(dismissibleContent, parallelScan.dismissible);
    for (const [id, e] of parallelScan.experiments) {
      if (!expSet.has(id)) expSet.set(id, e);
    }
    for (const k of Object.keys(parallelScan.coverage)) coverage[k] += parallelScan.coverage[k];
    coverage.scanWorkers = parallelScan.workers;
    console.log(
      `Chunk scan parallel: ${parallelScan.workers} workers, ${parallelScan.coverage.scanned} fichiers, ${(parallelScan.coverage.bytesScanned / 1048576).toFixed(0)} MB`,
    );
  } else {
    // Stat + read en parallèle (batch de 16 pour limiter la mémoire)
    const READ_BATCH = 16;
    for (let i = 0; i < toScan.length; i += READ_BATCH) {
      const batch = toScan.slice(i, i + READ_BATCH);
      const stats = await Promise.all(
        batch.map(async ({ f, fp }) => {
          try {
            const st = await fs.stat(fp);
            if (st.size === 0) { coverage.skippedEmpty++; return null; }
            if (st.size > MAX_CHUNK_SCAN_BYTES) {
              coverage.skippedOversize++;
              coverage.bytesSkippedOversize += st.size;
              return null;
            }
            const content = await fs.readFile(fp, 'utf8');
            return { f, fp, content, size: st.size };
          } catch (e) {
            coverage.readErrors++;
            if (coverage.readErrors <= 8) {
              console.warn('chunk read error', f, e && e.message ? e.message : e);
            }
            return null;
          }
        }),
      );
      // Phase 2: extraction séquentielle (CPU bound, évite les race conditions sur routes/expSet/strings)
      for (const item of stats) {
        if (!item) continue;
        extractRoutes(item.content, routes);
        extractExperiments(item.content, expSet);
        extractDismissibleContent(item.content, dismissibleContent);
        coverage.scanned++;
        coverage.bytesScanned += item.size;
      }
    }
  }

  const secondaryCandidates =
    coverage.jsOnDisk - coverage.webFiles - coverage.skippedEmpty;
  const scannedDenom = Math.max(secondaryCandidates, 1);
  coverage.scanRatio =
    Math.round((coverage.scanned / scannedDenom) * 1000) / 1000;
  coverage.oversizeRatio =
    Math.round(
      (coverage.skippedOversize / Math.max(coverage.jsOnDisk - coverage.webFiles, 1)) *
        1000,
    ) / 1000;

  coverage.degraded = false;
  coverage.degradedReasons = [];
  if (FULL_CHUNKS && coverage.chunkUrlsMapped >= 40) {
    if (coverage.jsOnDisk < coverage.chunkUrlsMapped * 0.5) {
      coverage.degraded = true;
      coverage.degradedReasons.push('JS_ON_DISK_LT_HALF_MAPPED_CHUNKS');
    }
  }
  if (coverage.oversizeRatio > 0.15 && coverage.skippedOversize >= 3) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_OVERSIZE_SKIPPED');
  }
  if (coverage.readErrors >= 10) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_READ_ERRORS');
  }
  if (
    secondaryCandidates >= 20 &&
    coverage.scanRatio < 0.7 &&
    coverage.skippedOversize + coverage.readErrors > 0
  ) {
    coverage.degraded = true;
    coverage.degradedReasons.push('LOW_SCAN_RATIO');
  }

  console.log('Scanned extra chunks:', coverage.scanned, '| coverage', coverage);

  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    dismissible: Object.keys(dismissibleContent).length,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
    coverage,
  });

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS:', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  console.log('Download integrity summary', getDownloadStats());
  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    dismissibleContent,
    css: cssInventory,
    downloadStats: getDownloadStats(),
    coverage,
  };
}

async function extractCoreParallel(webContent, { routes, expSet, strings }) {
  await Promise.all([
    Promise.resolve().then(() => extractRoutes(webContent, routes)),
    Promise.resolve().then(() => extractExperiments(webContent, expSet)),
  ]);
  // Strings : PAS depuis web.* (faux positifs type "bottom":"top").
  // Ils viennent uniquement des chunks de locale en-US (extractLocaleStrings).
  void strings;
}

function resolveAllChunkUrls(webContent) {
  if (!webContent) return [];
  const hashById = new Map();
  const re1 = /(\d{1,7}):["']([a-f0-9]{16,22})["']/g;
  let m;
  while ((m = re1.exec(webContent)) !== null) {
    if (/^\d+$/.test(m[2])) continue;
    hashById.set(m[1], m[2]);
  }
  const reSci = /(\d+e\d+):["']([a-f0-9]{16,22})["']/gi;
  while ((m = reSci.exec(webContent)) !== null) {
    const id = String(Number(m[1]));
    if (Number.isFinite(Number(id))) hashById.set(id, m[2]);
  }
  const reFile = /["']([a-f0-9]{16,22})\.js["']/g;
  const looseHashes = new Set();
  while ((m = reFile.exec(webContent)) !== null) {
    // 100 % chiffres = ID Discord (snowflake), pas un hash de chunk → 404 garanti
    if (/^\d+$/.test(m[1])) continue;
    looseHashes.add(m[1]);
  }
  const urls = [];
  const seen = new Set();
  for (const hash of hashById.values()) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  for (const hash of looseHashes) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  return urls;
}

function resolveEnUsLocaleUrls(webContent) {
  if (!webContent) return [];
  const chunkMap = {};
  const reMap = /(\d{3,6}):["']([a-f0-9]{16,22})["']/g;
  let m;
  while ((m = reMap.exec(webContent)) !== null) chunkMap[m[1]] = m[2];
  const chunkIds = new Set();
  const reEn = /["']en-US["']\s*:\s*\(\)\s*=>\s*n\.e\(["']?(\d+)["']?\)/g;
  while ((m = reEn.exec(webContent)) !== null) chunkIds.add(m[1]);
  const reJson = /\.\/en-US\.json["']\s*:\s*["']?(\d+)["']?/g;
  while ((m = reJson.exec(webContent)) !== null) chunkIds.add(m[1]);
  const urls = [];
  const seen = new Set();
  for (const id of chunkIds) {
    const hash = chunkMap[id];
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  return urls;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Décode le contenu d'un littéral JS entre quotes simples ('...').
 * Gère \\ \' \" \n \t \r \b \f \v \0 \xHH \uHHHH \u{H..} et les continuations de ligne.
 */
function decodeJsStringLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) {
      out += '\\';
      break;
    }
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x': {
        const hex = s.slice(i + 1, i + 3);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += '\\x';
        }
        break;
      }
      case 'u': {
        if (s[i + 1] === '{') {
          const close = s.indexOf('}', i);
          const hex = close < 0 ? '' : s.slice(i + 2, close);
          const point = /^[0-9a-f]{1,6}$/i.test(hex) ? parseInt(hex, 16) : NaN;
          if (Number.isInteger(point) && point <= 0x10ffff) {
            out += String.fromCodePoint(point);
            i = close;
          } else if (close >= 0) {
            out += s.slice(i - 1, close + 1);
            i = close;
          } else {
            out += '\\u';
          }
        } else {
          const hex = s.slice(i + 1, i + 5);
          if (/^[0-9a-f]{4}$/i.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            out += '\\u';
          }
        }
        break;
      }
      case '\r':
        if (s[i + 1] === '\n') i++;
        break;
      case '\n':
        break;
      default:
        out += n;
    }
  }
  return out;
}

function extractLocaleStrings(content, out) {
  // Littéral JS '...' complet (gère correctement \\ et \')
  const reParse = /JSON\.parse\('((?:[^'\\]|\\[\s\S])*)'\)/g;
  let m;
  let parsedAny = false;
  while ((m = reParse.exec(content)) !== null) {
    let raw = m[1];
    try {
      const obj = JSON.parse(decodeJsStringLiteral(raw));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      parsedAny = true;
      for (const [k, v] of Object.entries(obj)) {
        if (!isGoodStringKey(k)) continue;
        const text = flattenIcu(v);
        if (isGoodStringVal(text)) out[k] = text;
      }
    } catch {
      // JSON invalide : fallback regex uniquement sur ce bloc
      extractStringsFromLocaleBlob(raw, out);
    }
  }
  // Fallback global UNIQUEMENT si aucun JSON.parse exploitable
  // (avant : appliqué en plus → écrasait les vraies valeurs par des fragments
  // comme "percent", "userName", "countone"…)
  if (!parsedAny) extractStringsFromLocaleBlob(content, out);
}

/**
 * Aplatis le format de message compilé de Discord (AST FormatJS compact).
 *  "texte"                                  → texte
 *  [1,"name"]                               → {name}
 *  [2,"n","style"] / [3,..] / [4,..]        → {n, number|date|time, style}
 *  [5,"v",{a:[...],other:[...]}]            → {v, select, a {…} other {…}}
 *  [6,"count",{one:[...],...},offset,"cardinal"|"ordinal"] → {count, plural|selectordinal, …}
 *  [7]                                      → #
 *  [8,"$b",[...]]                           → **…**   ($i → *…*, $del → ~~…~~, $p → …)
 *  [8,"$link",[...],[[1,"url"]]]            → [… ](url)
 *  [8,"usernameHook",[...]]                 → $[…](usernameHook)
 * Avant : les balises (type 8) perdaient leur texte → "{$link} about age groups"
 * au lieu de "[Learn more](…) about age groups".
 */
function flattenIcu(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const node = (part) => {
    if (typeof part === 'string') return part;
    if (typeof part === 'number') return String(part);
    if (!Array.isArray(part) || !part.length) return '';
    const t = part[0];
    if (typeof t !== 'number') return seq(part);
    if (t === 7) return '#';
    if (t === 0) return typeof part[1] === 'string' ? part[1] : '';
    const name = typeof part[1] === 'string' ? part[1] : '';
    if (t === 1) return '{' + name + '}';
    if (t === 2 || t === 3 || t === 4) {
      const kind = t === 2 ? 'number' : t === 3 ? 'date' : 'time';
      const style = typeof part[2] === 'string' && part[2] ? ', ' + part[2] : '';
      return '{' + name + ', ' + kind + style + '}';
    }
    if (t === 5 || t === 6) {
      const opts = part[2] && typeof part[2] === 'object' && !Array.isArray(part[2]) ? part[2] : {};
      const kind = t === 5 ? 'select' : part[4] === 'ordinal' ? 'selectordinal' : 'plural';
      const offset = t === 6 && Number(part[3]) ? ` offset:${Number(part[3])}` : '';
      const branches = Object.entries(opts)
        .map(([k, b]) => `${k} {${seq(b)}}`)
        .join(' ');
      return `{${name}, ${kind},${offset} ${branches}}`;
    }
    if (t === 8) {
      const inner = seq(part[2]);
      const arg = Array.isArray(part[3]) && part[3].length ? seq(part[3]) : '';
      switch (name) {
        case '$b': return `**${inner}**`;
        case '$i': return `*${inner}*`;
        case '$del': return `~~${inner}~~`;
        case '$code': return '`' + inner + '`';
        case '$p': return inner;
        case '$link': return arg ? `[${inner}](${arg})` : `[${inner}]`;
        default: return `$[${inner}](${name.replace(/^\$/, '')})`;
      }
    }
    // type inconnu : on garde au moins le nom de variable
    return name ? '{' + name + '}' : '';
  };
  const seq = (arr) => (Array.isArray(arr) && (arr.length === 0 || typeof arr[0] !== 'number') ? arr.map(node).join('') : node(arr));
  const s = seq(v);
  return typeof s === 'string' ? s : null;
}

function extractStringsFromLocaleBlob(content, out) {
  const reArr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*\[\s*([\s\S]*?)\s*\]/g;
  let m;
  while ((m = reArr.exec(content)) !== null) {
    if (!isGoodStringKey(m[1])) continue;
    const inner = m[2];
    const parts = [];
    const rePart =
      /["']([^"'\\]*(?:\\.[^"'\\]*)*)["']|\[\s*\d+\s*,\s*["']([^"']+)["']\s*\]/g;
    let p;
    while ((p = rePart.exec(inner)) !== null) {
      if (p[1] != null) {
        try {
          parts.push(JSON.parse('"' + p[1] + '"'));
        } catch {
          parts.push(p[1]);
        }
      } else if (p[2] != null) {
        parts.push('{' + p[2] + '}');
      }
    }
    if (!parts.length) continue;
    // fallback approximatif : ne jamais écraser une valeur issue du vrai JSON
    if (m[1] in out) continue;
    // [[1,"var"], ...] coupé au premier « ] » → fragment ("percent", "userName"…)
    if (/^\s*\[/.test(inner)) continue;
    const text = parts.join('');
    if (isGoodStringVal(text)) out[m[1]] = text;
  }
}

function isGoodStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  if (!/^[A-Za-z0-9+/_-]{6}$/.test(k)) return false;
  if (/^[0-9a-f]{6}$/i.test(k)) return false;
  return true;
}

function isGoodStringVal(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 1 || s.length > 800) return false;
  if (/^discord_web-/i.test(s) || /^release:/i.test(s)) return false;
  if (s === '[object Object]' || s.includes('[object Object]')) return false;
  if (!/[\p{L}\p{N}]/u.test(s)) return false;
  return true;
}

function isValidRouteKey(key) {
  if (typeof key !== 'string') return false;
  if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(key)) return false;
  if (/^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS|TRUE|FALSE|NULL)$/.test(key))
    return false;
  return true;
}

function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p.startsWith('/')) return null;
  if (p.length < 2 || p.length > 300) return null;
  p = p.replace(/\$\{[^{}]+\}/g, ':param');
  // template conditionnel non fermé : `/settings/${e}${null!=t?`/${t}`:""}` → coupe
  const open = p.indexOf('${');
  if (open >= 0) p = p.slice(0, open);
  p = p.replace(/[?&]+$/, '');
  if (/[\s\\]/.test(p)) return null;
  if (p.length < 2) return null;
  if (/\.(js|css|map|png|jpg|webp|svg|woff2?)$/i.test(p)) return null;
  if (p.startsWith('//')) return null; // URL protocol-relative, pas une route
  if (p.startsWith('/assets/')) return null;
  return p;
}

/**
 * Même clé vue dans plusieurs chunks avec des chemins différents : le résultat
 * ne doit PAS dépendre de l'ordre de scan (sinon « modified » fantômes d'un run à l'autre).
 */
function setRoute(out, key, p) {
  if (!isValidRouteKey(key) || !p) return;
  const cur = out[key];
  if (cur === undefined || cur === p) {
    out[key] = p;
    return;
  }
  const score = (x) => (x.match(/:param/g) || []).length * 1000 + x.length;
  const a = score(p);
  const b = score(cur);
  if (a > b || (a === b && p > cur)) out[key] = p;
}

function createCodePositionMask(content) {
  const mask = new Uint8Array(content.length);
  const prefixKeywords = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do', 'new', 'extends']);
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let regexEscaped = false;
  let canStartRegex = true;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (regex) {
      if (regexEscaped) { regexEscaped = false; continue; }
      if (ch === '\\') { regexEscaped = true; continue; }
      if (ch === '[') { regexClass = true; continue; }
      if (ch === ']') { regexClass = false; continue; }
      if (ch === '/' && !regexClass) { regex = false; canStartRegex = false; }
      continue;
    }
    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      else continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    mask[i] = 1;
    if (ch === '/' && next === '/') { lineComment = true; mask[i] = 0; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; mask[i] = 0; i++; continue; }
    if (ch === '/' && canStartRegex) { regex = true; regexClass = false; regexEscaped = false; mask[i] = 0; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; canStartRegex = false; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < content.length && /[A-Za-z0-9_$]/.test(content[end])) end++;
      const word = content.slice(i, end);
      canStartRegex = prefixKeywords.has(word);
      i = end - 1;
      continue;
    }
    if (/\d/.test(ch)) {
      while (i + 1 < content.length && /[\w.]/.test(content[i + 1])) i++;
      canStartRegex = false;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}' || ch === '.') canStartRegex = false;
    else if (!/\s/.test(ch)) canStartRegex = true;
  }
  return mask;
}

function extractRoutes(content, out) {
  // Pré-filtre : les six motifs ci-dessous exigent tous une quote suivie d'un
  // slash puis d'au moins deux caractères de chemin. Tester ça d'abord évite de
  // construire le masque de code — coûteux — sur les chunks qui ne peuvent
  // contenir aucune route. Vérifié sur le corpus réel (6703 chunks du build
  // 675544) : 229 routes avant comme après, aucune perte, ~2 s de gagnées.
  if (!ROUTE_HINT_RE.test(content)) return;
  const codePositions = createCodePositionMask(content);
  const re =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*["'`](\/[a-zA-Z0-9_\-./{}@:$]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[2]);
    setRoute(out, m[1], p);
  }
  const re2 =
    /["']([A-Z][A-Z0-9_]{2,100})["']\s*:\s*["'](\/[^"']{1,250})["']/g;
  while ((m = re2.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[2]);
    setRoute(out, m[1], p);
  }
  const re3 =
    /\.([A-Z][A-Z0-9_]{2,100})\s*=\s*["'](\/[a-zA-Z0-9_\-./{}@:$]+)["']/g;
  while ((m = re3.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[2]);
    setRoute(out, m[1], p);
  }
  const re4 =
    /(?:Endpoints|Routes|API_ENDPOINTS|APIRoutes)\s*(?:\.|\[)\s*["']?([A-Z][A-Z0-9_]{2,100})["']?\s*(?:\])?\s*=\s*["'`](\/[^"'`]{1,250})["'`]/g;
  while ((m = re4.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[2]);
    setRoute(out, m[1], p);
  }
  // Routes dynamiques (forme minifiée actuelle de Discord) :
  //   USER:e=>`/users/${e}`  ·  USER_BADGE:(e,t)=>`/users/${e}/badges/${t}`
  //   VOICE_PUBLIC_KEYS:()=>"/voice/public-keys"  ·  X:function(e){return`/x/${e}`}
  const re5 =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\(\s*)?(?:[\w$.!=<>\s]{1,60}\?\s*)?(["'`])(\/[^"'`\n]{0,250}?)\2/g;
  while ((m = re5.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[3]);
    setRoute(out, m[1], p);
  }
  const re6 =
    /\b([A-Z][A-Z0-9_]{2,100})\s*(?::\s*function\s*\([^)]*\)|\([^)]*\))\s*\{(?:[^{}`]{0,300}?;)?\s*return\s*(["'`])(\/[^"'`\n]{0,250}?)\2/g;
  while ((m = re6.exec(content)) !== null) {
    if (!codePositions[m.index]) continue;
    const p = normalizePath(m[3]);
    setRoute(out, m[1], p);
  }
}

function extractExperiments(content, map) {
  const reNK =
    /\{\s*name\s*:\s*["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']\s*,\s*kind\s*:\s*["'](user|guild)["']/gi;
  let m;
  while ((m = reNK.exec(content)) !== null) {
    upsertExp(map, m[1], m[2].toLowerCase(), content, matchEnd(m));
  }
  const reKN =
    /\{\s*kind\s*:\s*["'](user|guild)["']\s*,\s*name\s*:\s*["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reKN.exec(content)) !== null) {
    upsertExp(map, m[2], m[1].toLowerCase(), content, matchEnd(m));
  }

  const reId = /["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reId.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    const start = Math.max(0, m.index - 180);
    const end = Math.min(content.length, m.index + id.length + 280);
    const ctx = content.slice(start, end);
    const looksExp =
      /kind\s*:\s*["'](user|guild)["']/i.test(ctx) ||
      /\b(experiment|experiments|getExperiment|useExperiment|Exposure)\b/i.test(ctx) ||
      /variations\s*:/i.test(ctx) ||
      /treatments\s*:/i.test(ctx);
    if (!looksExp) continue;
    // kind : uniquement dans l'objet courant (pas celui de la voisine)
    let back = content.slice(start, m.index);
    const lastClose = back.lastIndexOf('}');
    if (lastClose >= 0) back = back.slice(lastClose + 1);
    const own = back + expWindow(content, m.index, 280);
    let type = null;
    if (/kind\s*:\s*["']guild["']/i.test(own)) type = 'guild';
    else if (/kind\s*:\s*["']user["']/i.test(own)) type = 'user';
    else type = inferType(id);
    upsertExp(map, id, type, content, m.index);
  }
}

function extractDefaultConfigNear(content, from) {
  const window = expWindow(content, from, 2800);
  const m = window.match(/defaultConfig\s*:\s*\{/);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = findMatchingDelimiter(window, open, '{', '}');
  if (close < 0) return null;
  const body = window.slice(open + 1, close);
  const out = {};
  // accepte aussi la forme minifiée !0 (true) / !1 (false)
  const re = /([A-Za-z_][\w]*)\s*:\s*(true|false|!0|!1|null|\d+|["'][^"']*["'])/g;
  let x;
  while ((x = re.exec(body)) !== null) {
    let v = x[2];
    if (v === 'true' || v === '!0') v = true;
    else if (v === 'false' || v === '!1') v = false;
    else if (v === 'null') v = null;
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, '');
    out[x[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Id d'expérience (ex. "2026-09_feature") — sert à borner la fenêtre de recherche
const EXP_ID_RE_G = /["']20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90}["']/gi;

/**
 * Fenêtre de `len` caractères à partir de `from`, coupée à l'expérience suivante
 * (l'id courant peut être en tête). Évite d'attribuer à une expérience les
 * variations / defaultConfig / label de sa voisine.
 */
function expWindow(content, from, len) {
  let w = content.slice(from, from + len);
  EXP_ID_RE_G.lastIndex = 0;
  let m;
  while ((m = EXP_ID_RE_G.exec(w)) !== null) {
    if (m.index > 1) {
      w = w.slice(0, m.index);
      break;
    }
  }
  return w;
}

function extractLabelNear(content, from) {
  // Arrière : seulement l'objet courant (après le dernier « } »), pour ne pas
  // voler le label de l'expérience précédente.
  let back = content.slice(Math.max(0, from - 200), from);
  const lastClose = back.lastIndexOf('}');
  if (lastClose >= 0) back = back.slice(lastClose + 1);
  // Avant : s'arrêter à l'expérience suivante.
  const fwd = expWindow(content, from, 1200);
  const window = back + fwd;
  const found =
    window.match(/label\s*:\s*["']([^"']{3,120})["']/) ||
    window.match(/title\s*:\s*["']([^"']{3,120})["']/);
  return found ? found[1] : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function upsertExp(map, id, kind, content, posAfter) {
  if (!id || /^20\d{2}-\d{2}$/.test(id)) return;
  const variations = countVariationsNear(content, posAfter);
  const defaultConfig = extractDefaultConfigNear(content, posAfter);
  const label = extractLabelNear(content, posAfter);
  const hasTreatmentsArray = /treatments\s*:\s*\[/.test(
    expWindow(content, posAfter, 2800),
  );
  const system = hasTreatmentsArray ? 'legacy' : 'apex';
  const existing = map.get(id);
  if (existing) {
    if (kind === 'guild') {
      existing.type = 'guild';
      existing.kind = 'guild';
    }
    const newVariationCount = variations ? Object.keys(variations).length : -1;
    const oldVariationCount = existing.variations ? Object.keys(existing.variations).length : -1;
    if (variations && (newVariationCount > oldVariationCount ||
      (newVariationCount === oldVariationCount && stableJson(variations) < stableJson(existing.variations)))) {
      existing.variations = variations;
      existing.variationCount = Object.keys(variations).length;
    }
    if (defaultConfig && (!existing.defaultConfig || stableJson(defaultConfig) < stableJson(existing.defaultConfig))) {
      existing.defaultConfig = defaultConfig;
    }
    if (label && (!existing.label || label < existing.label)) existing.label = label;
    if (system === 'legacy' || !existing.system) existing.system = system;
    return;
  }
  map.set(id, {
    id,
    type: kind,
    kind,
    label: label || null,
    system,
    defaultConfig: defaultConfig || null,
    variations,
    variationCount: variations ? Object.keys(variations).length : 0,
    source: 'discord',
  });
}

function countVariationsNear(content, from) {
  const window = expWindow(content, from, 2800);
  // la PREMIÈRE occurrence gagne (avant : « variations » prioritaire même s'il
  // appartenait à une expérience plus loin)
  const m = [
    window.match(/variations\s*:\s*\{/),
    window.match(/treatments\s*:\s*\[/),
    window.match(/treatments\s*:\s*\{/),
  ]
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)[0];
  if (!m) return null;

  const isArray = /treatments\s*:\s*\[/.test(m[0]);
  const start = m.index + m[0].length;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const end = findMatchingDelimiter(window, start - 1, open, close);
  if (end < 0) return null;
  const body = window.slice(start, end);
  const out = {};
  if (isArray) {
    // Tableau treatments: [{...}, {...}] — chaque objet est une variation
    // On parse chaque bloc { ... } individuellement pour extraire toutes les paires clé:valeur
    const blocks = parseTopLevelBlocks(body, '{', '}');
    if (blocks.length) {
      blocks.forEach((block, idx) => {
        // Extraire l'id du bloc, sinon utiliser l'index
        const idMatch = block.match(/\bid\s*:\s*(\d+)/);
        const k = idMatch ? idMatch[1] : String(idx);
        const pairs = extractObjectLiteralPairs(block);
        out[k] = Object.keys(pairs).length ? pairs : { id: Number(k) };
      });
    } else {
      // Fallback : compter les objets
      let n = 0;
      let d = 0;
      for (const ch of body) {
        if (ch === '{') {
          if (d === 0) n++;
          d++;
        } else if (ch === '}') d = Math.max(0, d - 1);
      }
      if (n <= 0) return null;
      for (let k = 0; k < n && k < 40; k++) out[String(k)] = { id: k };
    }
  } else {
    // Objet variations: { "0": {...}, "1": {...} } — extraire toutes les paires de chaque variation
    const keys = [...body.matchAll(/(?:^|[,{}])\s*(\d+)\s*:/g)].map((x) => x[1]);
    if (!keys.length) return null;
    for (const k of keys) {
      // Extraire le bloc { ... } de cette variation avec un scanner d'accolades
      const block = extractVariationBlock(body, k);
      if (block) {
        const pairs = extractObjectLiteralPairs(block);
        out[k] = Object.keys(pairs).length ? pairs : { id: Number(k) };
      } else {
        out[k] = { id: Number(k) };
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Extrait toutes les paires clé:valeur simples d'un bloc d'objet JavaScript.
 * Gère true/false/!0/!1/null/nombres/strings.
 * Similaire à extractDefaultConfigNear mais réutilisable.
 */
function extractObjectLiteralPairs(body) {
  const out = {};
  const re = /([A-Za-z_][\w]*)\s*:\s*(true|false|!0|!1|null|\d+(?:\.\d+)?|["'][^"']*["'])/g;
  let x;
  while ((x = re.exec(body)) !== null) {
    let v = x[2];
    if (v === 'true' || v === '!0') v = true;
    else if (v === 'false' || v === '!1') v = false;
    else if (v === 'null') v = null;
    else if (/^\d+(?:\.\d+)?$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, '');
    out[x[1]] = v;
  }
  return out;
}

/**
 * Extrait le contenu { ... } d'une variation avec une clé numérique donnée.
 * Utilise un scanner d'accolades pour gérer les objets imbriqués.
 * @param {string} body - le corps de l'objet variations
 * @param {string} key - la clé numérique (ex: "0", "1")
 * @returns {string|null} le contenu entre accolades, ou null
 */
function extractVariationBlock(body, key) {
  // Trouver la position de la clé
  const re = new RegExp('(?:^|[,{}])\\s*' + key + '\\s*:\\s*\\{');
  const m = body.match(re);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = findMatchingDelimiter(body, open, '{', '}');
  if (close < 0) return null;
  return body.slice(open + 1, close);
}

/**
 * Parse les blocs de premier niveau dans un corps (array ou objet).
 * @param {string} body
 * @param {string} open - caractère d'ouverture ('{' ou '[')
 * @param {string} close - caractère de fermeture ('}' ou ']')
 * @returns {string[]} contenu de chaque bloc (sans les délimiteurs)
 */
function parseTopLevelBlocks(body, open, close) {
  const blocks = [];
  let i = 0;
  while (i < body.length) {
    // Trouver le prochain caractère d'ouverture
    while (i < body.length && body[i] !== open) i++;
    if (i >= body.length) break;
    const start = i;
    const end = findMatchingDelimiter(body, start, open, close);
    if (end < 0) break;
    blocks.push(body.slice(start + 1, end));
    i = end + 1;
  }
  return blocks;
}

function findMatchingDelimiter(source, openIndex, open, close) {
  if (source[openIndex] !== open) return -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

module.exports = {
  analyzeAssets,
  scanChunksParallel,
  chunkScanWorkerCount,
  MAX_CHUNK_SCAN_BYTES,
  getDownloadStats,
  isGoodStringKey,
  isGoodStringVal,
  extractRoutes,
  isValidRouteKey,
  normalizePath,
  inferType,
  resolveEnUsLocaleUrls,
  resolveAllChunkUrls,
  extractLocaleStrings,
  decodeJsStringLiteral,
  flattenIcu,
  extractExperiments,
  extractCoreParallel,
  extractObjectLiteralPairs,
  extractVariationBlock,
  parseTopLevelBlocks,
  extractDismissibleContent,
};
