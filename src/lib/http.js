/**
 * Helper réseau partagé — fetch robuste avec retry, timeout et validation JSON.
 *
 * Problèmes résolus :
 * - .json() qui plante quand l'API renvoie du HTML (Cloudflare 429, page d'erreur)
 * - fetch sans timeout (peut bloquer indéfiniment)
 * - pas de retry sur 429 / 5xx / erreurs réseau
 * - duplication de la logique de retry dans chaque script
 *
 * Usage :
 *   const { fetchJsonWithRetry, fetchTextWithRetry } = require('./lib/http');
 *   const data = await fetchJsonWithRetry(url, { headers, timeout: 15000 });
 */
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const { sleep, redactSecrets } = require('./utils');

const KEEP_ALIVE = process.env.HTTP_KEEP_ALIVE !== '0';
const httpsAgent = new https.Agent({ keepAlive: KEEP_ALIVE, maxSockets: 16 });
const httpAgent = new http.Agent({ keepAlive: KEEP_ALIVE, maxSockets: 16 });
const pickAgent = (u) => (String(u).startsWith('http:') ? httpAgent : httpsAgent);

const DEFAULTS = {
  maxAttempts: 3,
  timeoutMs: 20000,
  baseDelayMs: 500,
  maxDelayMs: 15000,
  maxRetryAfterMs: 120000,
};

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function extractRetryAfterMs(res, bodyJson) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    if (v == null || v === '') return NaN;
    const n = Number(v);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
    return NaN;
  };
  let ms = h('retry-after');
  if (!Number.isFinite(ms) && bodyJson && bodyJson.retry_after != null) {
    ms = Number(bodyJson.retry_after) * 1000;
  }
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchWithRetry(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const maxAttempts = opts.maxAttempts || DEFAULTS.maxAttempts;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => controller && controller.abort(), opts.timeoutMs || DEFAULTS.timeoutMs);
      const res = await fetch(url, {
        ...opts,
        agent: opts.agent || pickAgent(url),
        signal: controller ? controller.signal : undefined,
      });
      clearTimeout(timeout);

      if (isRetryableStatus(res.status)) {
        const bodyJson = await res.clone().json().catch(() => null);
        const ra = extractRetryAfterMs(res, bodyJson);
        const delay = ra > 0 && ra < opts.maxRetryAfterMs ? ra : backoffMs(attempt, opts);
        console.warn(`HTTP ${res.status} — retry in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const delay = backoffMs(attempt, opts);
      console.warn(`fetch error: ${redactSecrets(e.message)} — retry in ${delay}ms`);
      if (attempt < maxAttempts - 1) await sleep(delay);
    }
  }
  throw lastErr || new Error('fetchWithRetry failed');
}

async function fetchJsonWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct && !/[/+]json\b/i.test(ct) && !ct.includes('text/plain')) {
    const text = await res.text().catch(() => '');
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}content-type inattendu: "${ct}" — body: ${String(text).slice(0, 100)}`);
    return null;
  }
  const text = stripBom(await res.text().catch(() => ''));
  try {
    return JSON.parse(text);
  } catch {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}JSON invalide — body: ${String(text).slice(0, 100)}`);
    return null;
  }
}

async function fetchTextWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }
  return await res.text();
}

async function safeJson(res) {
  const text = stripBom(await res.text().catch(() => ''));
  try {
    return JSON.parse(text);
  } catch {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    console.warn(`JSON invalide (content-type: "${ct}") — body: ${String(text).slice(0, 100)}`);
    return null;
  }
}

function stripBom(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '');
}

module.exports = {
  fetchWithRetry,
  fetchJsonWithRetry,
  fetchTextWithRetry,
  safeJson,
  isRetryableStatus,
  extractRetryAfterMs,
  backoffMs,
  stripBom,
};
