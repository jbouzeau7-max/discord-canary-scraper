/**
 * Robust asset downloads for Canary scraper.
 * - atomic .part → final
 * - retries + Retry-After on 429
 * - timeouts, integrity summary
 * - hard max body size (memory safety)
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const { sleep, envNumber, DEFAULT_UA } = require('./utils');

const DOWNLOAD_CONCURRENCY = envNumber('DOWNLOAD_CONCURRENCY', 32, { min: 1, max: 256, int: true });
const DOWNLOAD_RETRIES = envNumber('DOWNLOAD_RETRIES', 4, { min: 1, max: 20, int: true });
const DOWNLOAD_TIMEOUT_MS = envNumber('DOWNLOAD_TIMEOUT_MS', 90000, { min: 1000 });
const MIN_WEB_BYTES = envNumber('MIN_WEB_BYTES', 500_000, { min: 0 });
const MIN_DOWNLOAD_SUCCESS_RATIO = envNumber('MIN_DOWNLOAD_SUCCESS_RATIO', 0.85, { min: 0, max: 1 });
const MAX_WEB_BYTES = envNumber('MAX_WEB_BYTES', 30 * 1024 * 1024, { min: 1024 });
const MAX_ASSET_BYTES = envNumber('MAX_ASSET_BYTES', 12 * 1024 * 1024, { min: 1024 });

// Keep-alive : réutilise les connexions TLS vers le CDN au lieu d'ouvrir
// une connexion neuve (DNS + TCP + TLS) pour chacun des ~6500 chunks.
const KEEP_ALIVE = process.env.DOWNLOAD_KEEP_ALIVE !== '0';
const httpsAgent = new https.Agent({ keepAlive: KEEP_ALIVE, maxSockets: Math.max(DOWNLOAD_CONCURRENCY, 8) });
const httpAgent = new http.Agent({ keepAlive: KEEP_ALIVE, maxSockets: Math.max(DOWNLOAD_CONCURRENCY, 8) });
const pickAgent = (u) => (String(u).startsWith('http:') ? httpAgent : httpsAgent);

let stats = emptyStats();

function emptyStats() {
  return {
    jobs: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    http429: 0,
    http5xx: 0,
  };
}

function getDownloadStats() {
  return { ...stats };
}

function resetDownloadStats() {
  stats = emptyStats();
}

async function readBodyWithLimit(res, maxBytes) {
  const cl = Number(res.headers.get('content-length') || 0);
  if (cl > 0 && cl > maxBytes) {
    destroyBody(res);
    throw new Error('content-length too large: ' + cl);
  }
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        destroyBody(res);
        throw new Error('response too large: ' + total + ' > ' + maxBytes);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
  const buf = await res.buffer();
  if (buf && buf.length > maxBytes) {
    throw new Error('response too large: ' + buf.length + ' > ' + maxBytes);
  }
  return buf;
}

/** Libère la socket keep-alive quand on abandonne une réponse non lue. */
function destroyBody(res) {
  try {
    if (res && res.body && typeof res.body.destroy === 'function') res.body.destroy();
  } catch {}
}

/** Vrai si le corps ressemble à une page d'erreur HTML (jamais du JS/CSS). */
function looksLikeHtml(buf) {
  const head = Buffer.isBuffer(buf) ? buf.slice(0, 80).toString('utf8') : String(buf || '').slice(0, 80);
  return /^\s*<(!DOCTYPE|html|HTML)/.test(head);
}

async function clearAssetsDir(assetsDir) {
  await fs.ensureDir(assetsDir);
  await fs.emptyDir(assetsDir);
  console.log('assetsDir cleared');
}

async function assertWebBundle(assetsDir) {
  const files = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  if (!files.length) {
    throw new Error('INVALID_ASSET: No web.*.js after download — abort scrape');
  }
  let best = 0;
  for (const f of files) {
    const st = await fs.stat(path.join(assetsDir, f));
    best = Math.max(best, st.size);
    console.log(
      'web bundle:',
      f,
      Math.round(st.size / 1024) + 'KB',
      st.size < MIN_WEB_BYTES ? 'TOO_SMALL' : 'OK',
    );
  }
  if (best < MIN_WEB_BYTES) {
    throw new Error(
      'INVALID_ASSET: web.*.js too small (' +
        best +
        ' < ' +
        MIN_WEB_BYTES +
        ') — abort scrape',
    );
  }
}

async function downloadList(urls, assetsDir, force, opts = {}) {
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : fetch;
  const jobs = [];
  const seenNames = new Set();
  for (const url of urls) {
    if (!url || !String(url).includes('/assets/')) continue;
    const name = path.basename(String(url).split('?')[0]);
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    // Deux URLs avec le même nom de fichier écrivaient le même .part en
    // parallèle (corruption possible) : on ne garde que la première.
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    jobs.push({ url: String(url), name });
  }

  let n = 0;
  let skip = 0;
  let fail = 0;
  let retried = 0;
  let http429 = 0;
  let http5xx = 0;
  let i = 0;

  async function downloadOne(job) {
    const fp = path.join(assetsDir, job.name);
    // Suffixe unique : deux téléchargements concurrents (locale + chunks,
    // deux appels de downloadList) ne peuvent plus écrire le même .part.
    const part =
      fp + '.part.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);

    if (!force && (await fs.pathExists(fp))) {
      const st = await fs.stat(fp);
      if (st.size > 64) {
        try {
          const fd = await fs.open(fp, 'r');
          const headBuf = Buffer.alloc(80);
          await fd.read(headBuf, 0, 80, 0);
          await fd.close();
          if (looksLikeHtml(headBuf)) {
            // cache HTML corrompu (JS ou CSS) — re-télécharger
          } else {
            skip++;
            return true;
          }
        } catch {
          skip++;
          return true;
        }
      }
    }

    let lastErr = null;
    // Pas d'attente après la dernière tentative (temps perdu pour rien).
    const pause = (attempt, ms) => (attempt < DOWNLOAD_RETRIES - 1 ? sleep(ms) : null);
    for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt++) {
      try {
        if (attempt > 0) retried++;
        const res = await fetchImpl(job.url, {
          headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
          timeout: DOWNLOAD_TIMEOUT_MS,
          agent: pickAgent,
        });
        if (res.status === 429) {
          http429++;
          destroyBody(res);
          const ra = Number(res.headers.get('retry-after') || 0);
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(60_000, ra * 1000) : Math.min(30_000, 500 * 2 ** attempt);
          console.warn('DL 429', job.name, 'wait', wait + 'ms');
          await pause(attempt, wait);
          lastErr = 'HTTP 429';
          continue;
        }
        if (res.status >= 500 || res.status === 408 || res.status === 425) {
          http5xx++;
          destroyBody(res);
          const wait = Math.min(20_000, 400 * 2 ** attempt);
          console.warn('DL 5xx', job.name, res.status, 'wait', wait + 'ms');
          await pause(attempt, wait);
          lastErr = 'HTTP ' + res.status;
          continue;
        }
        if (!res.ok) {
          lastErr = 'HTTP ' + res.status;
          destroyBody(res);
          if (res.status === 404 || res.status === 403) break;
          await pause(attempt, 300 * 2 ** attempt);
          continue;
        }
        const maxBytes = /\bweb\./i.test(job.name)
          ? MAX_WEB_BYTES
          : MAX_ASSET_BYTES;
        const buf = await readBodyWithLimit(res, maxBytes);
        if (!buf || buf.length < 16) {
          lastErr = 'empty body';
          await pause(attempt, 200 * 2 ** attempt);
          continue;
        }
        if (job.name.endsWith('.js') && buf.length < 64) {
          lastErr = 'js too small (' + buf.length + 'B)';
          await pause(attempt, 200 * 2 ** attempt);
          continue;
        }
        // Un CSS remplacé par une page HTML cassait l'extraction en silence.
        if (looksLikeHtml(buf)) {
          lastErr = 'HTML instead of asset';
          break;
        }
        await fs.writeFile(part, buf);
        await fs.move(part, fp, { overwrite: true });
        n++;
        if (n <= 8 || n % 500 === 0) {
          console.log(
            'DL',
            n + '/' + jobs.length,
            job.name,
            Math.round(buf.length / 1024) + 'KB',
          );
        }
        return true;
      } catch (e) {
        lastErr = e.message;
        await pause(attempt, Math.min(15_000, 400 * 2 ** attempt));
      }
    }
    fail++;
    try {
      if (await fs.pathExists(part)) await fs.remove(part);
    } catch {}
    if (fail <= 12) console.warn('DL fail', job.name, lastErr);
    return false;
  }

  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      await downloadOne(job);
    }
  }

  const workers = [];
  const conc = Math.max(1, Math.min(DOWNLOAD_CONCURRENCY, jobs.length || 1));
  for (let w = 0; w < conc; w++) workers.push(worker());
  await Promise.all(workers);

  stats.jobs += jobs.length;
  stats.downloaded += n;
  stats.skipped += skip;
  stats.failed += fail;
  stats.retried += retried;
  stats.http429 += http429;
  stats.http5xx += http5xx;

  console.log(
    'Downloaded',
    n,
    'skipped',
    skip,
    'failed',
    fail,
    'retried',
    retried,
    '429',
    http429,
    '5xx',
    http5xx,
    'jobs',
    jobs.length,
  );

  if (jobs.length >= 5) {
    const okRatio = (n + skip) / jobs.length;
    if (okRatio < MIN_DOWNLOAD_SUCCESS_RATIO) {
      throw new Error(
        'EXTRACTION_ERROR: download success ratio ' +
          okRatio.toFixed(2) +
          ' < ' +
          MIN_DOWNLOAD_SUCCESS_RATIO +
          ' (failed ' +
          fail +
          '/' +
          jobs.length +
          ')',
      );
    }
  }
}

module.exports = {
  downloadList,
  assertWebBundle,
  clearAssetsDir,
  getDownloadStats,
  resetDownloadStats,
  DOWNLOAD_CONCURRENCY,
};
