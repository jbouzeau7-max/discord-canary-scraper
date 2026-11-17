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

// Keep-alive : réutilise les connexions TLS entre requêtes (API Discord, gists,
// blogs…) au lieu de refaire DNS + TCP + TLS à chaque appel.
const KEEP_ALIVE = process.env.HTTP_KEEP_ALIVE !== '0';
const httpsAgent = new https.Agent({ keepAlive: KEEP_ALIVE, maxSockets: 16 });
const httpAgent = new http.Agent({ keepAlive: KEEP_ALIVE, maxSockets: 16 });
const pickAgent = (u) => (String(u).startsWith('http:') ? httpAgent : httpsAgent);

const DEFAULTS = {
  maxAttempts: 3,
  timeoutMs: 20000,
  baseDelayMs: 500,
  maxDelayMs: 15000,
  // Un Retry-After plus long que ça fait échouer vite : mieux vaut un run
  // rouge clair qu'un job qui martèle un endpoint rate-limité.
  maxRetryAfterMs: 120000,
};

// Les helpers qui matérialisent une réponse ne doivent jamais accumuler un
// body illimité. 5 MiB laisse une marge confortable aux réponses API/HTML.
const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024;

function responseHeader(res, name) {
  try {
    return res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get(name)
      : null;
  } catch {
    return null;
  }
}

function closeResponseBody(res) {
  const body = res && res.body;
  try {
    if (body && typeof body.destroy === 'function' && !body.destroyed) body.destroy();
    else if (body && typeof body.cancel === 'function') body.cancel().catch(() => {});
  } catch {}
}

/**
 * Lit le body en contrôlant sa taille en octets; en cas de dépassement, ferme
 * le flux avant de rejeter. Le fallback text()/json() sert aux mocks historiques
 * qui n'exposent pas le stream node-fetch.
 * @param {object} res réponse fetch
 * @param {object} [options]
 * @param {number} [options.maxBytes=5 MiB] limite du body
 * @returns {Promise<string>} body décodé en UTF-8
 */
async function readResponseBody(res, { maxBytes = MAX_RESPONSE_BODY_BYTES } = {}) {
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Number(maxBytes)) : MAX_RESPONSE_BODY_BYTES;
  const contentLength = Number(responseHeader(res, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    closeResponseBody(res);
    throw new Error(`HTTP response body exceeds ${limit} byte limit`);
  }

  const body = res && res.body;
  const chunks = [];
  let size = 0;
  const addChunk = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > limit) {
      closeResponseBody(res);
      throw new Error(`HTTP response body exceeds ${limit} byte limit`);
    }
    chunks.push(data);
  };

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) addChunk(chunk);
    return Buffer.concat(chunks, size).toString('utf8');
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        addChunk(value);
      }
    } catch (err) {
      if (size > limit) await reader.cancel().catch(() => {});
      throw err;
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }

  if (res && typeof res.text === 'function') {
    const text = await res.text();
    const data = Buffer.from(String(text == null ? '' : text));
    if (data.length > limit) throw new Error(`HTTP response body exceeds ${limit} byte limit`);
    return data.toString('utf8');
  }
  if (res && typeof res.json === 'function') {
    const value = await res.json();
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > limit) throw new Error(`HTTP response body exceeds ${limit} byte limit`);
    return text;
  }
  return '';
}

function hasIdempotencyKey(headers) {
  if (!headers) return false;
  if (typeof headers.get === 'function') return !!headers.get('idempotency-key');
  return Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key' && !!headers[key]);
}

/**
 * Détermine si un statut HTTP mérite un retry.
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  // 408 Request Timeout et 425 Too Early sont transitoires comme les 5xx.
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Calcule le délai de retry (backoff exponentiel + jitter).
 * @param {number} attempt - tentative actuelle (0-indexed)
 * @param {object} opts
 * @returns {number} délai en ms
 */
function backoffMs(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Extrait le retry-after d'une réponse (header ou JSON body).
 * @param {object} res - réponse fetch
 * @param {object} [bodyJson] - body JSON parsé si disponible
 * @returns {number} délai en ms (0 si inconnu)
 */
function extractRetryAfterMs(res, bodyJson) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    if (v == null || v === '') return NaN;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    // Retry-After peut être une date HTTP (RFC 7231).
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : NaN;
  };
  const candidates = [
    bodyJson && Number(bodyJson.retry_after),
    h('retry-after'),
    h('x-ratelimit-reset-after'),
  ].filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return 0;
  return Math.ceil(Math.max(...candidates) * 1000);
}

/**
 * Fetch robuste avec retry, timeout et gestion des erreurs réseau.
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options fetch + config retry
 * @param {object} [options.headers] - headers HTTP
 * @param {number} [options.timeout=20000] - timeout en ms
 * @param {number} [options.maxAttempts=3] - nombre max de tentatives
 * @param {number} [options.baseDelayMs=500] - délai de base pour le backoff
 * @param {number} [options.maxDelayMs=15000] - délai max de backoff
 * @param {boolean} [options.retryUnsafeMethods=false] - autorise le retry des mutations
 * @param {number} [options.maxBodyBytes=5242880] - plafond de body lu par les helpers
 * @param {string} [options.label] - label pour les logs
 * @returns {Promise<object>} réponse fetch (avec .ok, .status, .text(), .json())
 */
async function fetchWithRetry(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : fetch;
  const { headers, timeout: timeoutMs, label } = opts;
  const maxAttempts = Math.max(1, Math.floor(Number(opts.maxAttempts) || 1));
  const maxRetryAfterMs = Number.isFinite(Number(opts.maxRetryAfterMs))
    ? Math.max(0, Number(opts.maxRetryAfterMs))
    : DEFAULTS.maxRetryAfterMs;
  // Transmet TOUTES les options fetch (method, body, signal, redirect…) :
  // avant, seul un GET sans body était possible malgré l'API générique.
  const init = { ...options };
  for (const k of [
    'maxAttempts',
    'baseDelayMs',
    'maxDelayMs',
    'maxRetryAfterMs',
    'maxBodyBytes',
    'retryUnsafeMethods',
    'label',
    'fetch',
  ]) {
    delete init[k];
  }
  init.headers = headers;
  init.timeout = timeoutMs;
  init.agent = opts.agent || pickAgent;
  const method = String(init.method || 'GET').toUpperCase();
  const retryAllowed = ['GET', 'HEAD', 'OPTIONS'].includes(method)
    || opts.retryUnsafeMethods === true
    || hasIdempotencyKey(headers);
  let lastError = null;
  let lastStatus = 0;
  let attemptsMade = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attemptsMade = attempt + 1;
    try {
      const res = await fetchImpl(url, init);

      if (res.ok || !isRetryableStatus(res.status)) {
        return res;
      }

      // Retryable: 429 ou 5xx
      // Sans opt-in, on rend la réponse mutation telle quelle pour ne pas
      // rejouer automatiquement un POST/PATCH à effet de bord.
      if (!retryAllowed) return res;
      lastStatus = res.status;
      lastError = null;
      let bodyJson = null;
      try {
        bodyJson = JSON.parse(await readResponseBody(res, { maxBytes: opts.maxBodyBytes }));
      } catch {}
      const retryAfter = extractRetryAfterMs(res, bodyJson);
      const tag = label ? `[${label}] ` : '';

      // Le serveur demande une pause plus longue que notre budget : échouer
      // tout de suite (sinon on retentait bien trop tôt et on re-429).
      if (retryAfter > maxRetryAfterMs) {
        const tooLong = new Error(
          `${tag}HTTP ${res.status} — Retry-After ${Math.ceil(retryAfter / 1000)}s > ${Math.ceil(maxRetryAfterMs / 1000)}s`,
        );
        tooLong.__httpRetryAfterTooLong = true;
        throw tooLong;
      }

      const delay = retryAfter || backoffMs(attempt, opts);

      if (attempt < maxAttempts - 1) {
        console.warn(
          `${tag}HTTP ${res.status} — retry ${attempt + 1}/${maxAttempts} dans ${Math.round(delay / 1000)}s`,
        );
        await sleep(Math.min(delay, Math.max(opts.maxDelayMs, retryAfter)));
      }
    } catch (e) {
      // Annulation explicite de l'appelant : ne jamais la transformer en retry.
      if (e && (e.name === 'AbortError' || e.type === 'aborted')) throw e;
      if (e && e.__httpRetryAfterTooLong) throw e;
      // Erreur réseau (timeout, DNS, connexion refusée)
      lastError = e;
      lastStatus = 0;
      // Une erreur réseau après un POST/PATCH est ambiguë: le serveur a pu
      // appliquer la mutation avant la rupture. Ne pas la rejouer par défaut.
      if (!retryAllowed) break;
      if (attempt < maxAttempts - 1) {
        const delay = backoffMs(attempt, opts);
        const tag = label ? `[${label}] ` : '';
        console.warn(
          `${tag}erreur réseau: ${String(e.message || e).slice(0, 100)} — retry ${attempt + 1}/${maxAttempts}`,
        );
        await sleep(delay);
      }
    }
  }

  // Toutes les tentatives ont échoué
  const tag = label ? `[${label}] ` : '';
  const msg = lastError
    ? `${tag}échec après ${attemptsMade} tentative${attemptsMade > 1 ? 's' : ''}: ${redactSecrets(String(lastError.message || lastError)).slice(0, 150)}`
    : `${tag}échec après ${attemptsMade} tentative${attemptsMade > 1 ? 's' : ''}${lastStatus ? ` (dernier HTTP ${lastStatus})` : ''}`;
  throw new Error(msg);
}

/**
 * Fetch + parse JSON avec retry, timeout et validation du content-type.
 * Évite le crash quand l'API renvoie du HTML (Cloudflare, page d'erreur).
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options (mêmes que fetchWithRetry)
 * @returns {Promise<object|null>} JSON parsé, ou null si la réponse n'est pas du JSON valide
 */
async function fetchJsonWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }

  // Valide le content-type avant de parser
  const ct = res.headers.get('content-type') || '';
  if (ct && !/[/+]json\b/i.test(ct) && !ct.includes('text/plain')) {
    // Content-type inattendu (HTML, etc.) — probablement une erreur
    const text = await readResponseBody(res, { maxBytes: options.maxBodyBytes }).catch(() => '');
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(
      `${tag}content-type inattendu: "${ct}" — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }

  // Lecture unique du body : après un res.json() raté, le flux est consommé
  // et res.text() renverrait toujours '' (diagnostic perdu).
  // BOM UTF-8 éventuel retiré : JSON.parse('\uFEFF{...}') échoue.
  const text = stripBom(await readResponseBody(res, { maxBytes: options.maxBodyBytes }).catch(() => ''));
  try {
    return JSON.parse(text);
  } catch {
    // Le body n'est pas du JSON valide (HTML de Cloudflare, page d'erreur, etc.)
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(
      `${tag}JSON invalide — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }
}

/**
 * Fetch + texte avec retry et timeout.
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options (mêmes que fetchWithRetry)
 * @returns {Promise<string|null>} texte de la réponse, ou null si échec
 */
async function fetchTextWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }
  return await readResponseBody(res, { maxBytes: options.maxBodyBytes });
}

/**
 * Parse le JSON d'une réponse fetch de manière sûre.
 * Évite le crash quand le body n'est pas du JSON valide (HTML de Cloudflare, etc.).
 *
 * @param {object} res - réponse fetch
 * @returns {Promise<object|null>} JSON parsé, ou null si invalide
 */
async function safeJson(res) {
  const text = stripBom(await readResponseBody(res).catch(() => ''));
  try {
    return JSON.parse(text);
  } catch {
    const ct = res.headers && res.headers.get('content-type') || '';
    console.warn(
      `JSON invalide (content-type: "${ct}") — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }
}

/** Retire un éventuel BOM UTF-8 en tête de texte. */
function stripBom(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '');
}

module.exports = {
  fetchWithRetry,
  readResponseBody,
  MAX_RESPONSE_BODY_BYTES,
  fetchJsonWithRetry,
  fetchTextWithRetry,
  safeJson,
  isRetryableStatus,
  extractRetryAfterMs,
  backoffMs,
  stripBom,
};
