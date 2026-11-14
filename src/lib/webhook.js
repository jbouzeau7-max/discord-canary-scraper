/**
 * Envoi robuste de webhooks Discord, partagé par tous les scripts.
 *
 * - 429 : respecte Retry-After (header), retry_after (JSON) et X-RateLimit-Reset-After
 * - 5xx / erreurs réseau / timeout : backoff exponentiel avec jitter
 * - 4xx (hors 429) : échec immédiat (payload invalide → inutile de réessayer)
 * - X-RateLimit-Remaining: 0 → attend le reset avant la requête suivante
 * - découpe les embeds en messages ≤ 10 embeds ET ≤ 6000 caractères (limites Discord)
 * - masque le token du webhook dans les logs
 */
const fetch = require('node-fetch');
const https = require('https');
const { sleep, envNumber } = require('./utils');
const { IS_COMPONENTS_V2_FLAG, embedsToComponents, textDisplay, chunkText } = require('./components_v2');
const { allowedMentions, mentionText, autoPingRoles } = require('./mentions');
const { webhookIdentity } = require('./webhook_identity');

const DEFAULTS = {
  maxAttempts: envNumber('WEBHOOK_MAX_ATTEMPTS', 5, { min: 1, max: 20, int: true }),
  timeoutMs: envNumber('WEBHOOK_TIMEOUT_MS', 20000, { min: 1000 }),
  baseDelayMs: 300,
  maxDelayMs: 30000,
  // 0 par défaut : le bucket Discord (X-RateLimit-Remaining/Reset-After) et les 429
  // sont déjà respectés → pas de pause fixe inutile entre deux messages.
  minGapMs: envNumber('WEBHOOK_MIN_GAP_MS', 0, { min: 0 }),
  // 429 : attente maximale et budget de tentatives dédié (un rate-limit n'est
  // pas un échec du message).
  max429WaitMs: envNumber('WEBHOOK_MAX_429_WAIT_MS', 120000, { min: 1000 }),
  max429Retries: envNumber('WEBHOOK_MAX_429_RETRIES', 6, { min: 0, max: 50, int: true }),
};

// Keep-alive : une seule connexion TLS réutilisée pour tous les messages
// (avant : DNS + TCP + TLS à chaque message → ~100-300 ms perdus par envoi).
const webhookAgent = new https.Agent({ keepAlive: process.env.WEBHOOK_KEEP_ALIVE !== '0', maxSockets: 4 });

// Limites officielles Discord
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 6000;

// Pause partagée si Discord signale un bucket épuisé
let bucketResetAt = 0;

// File d'attente par URL : sérialise les envois vers le même webhook
// pour éviter les 429 quand plusieurs appels parallèles ciblent le même webhook.
const urlQueues = new Map();

/**
 * Exécute un envoi webhook en respectant l'ordre par URL.
 * Les appels parallèles vers le même webhook sont automatiquement sérialisés.
 */
function enqueue(url, fn) {
  const prev = urlQueues.get(url) || Promise.resolve();
  const next = prev.then(fn, fn); // fn s'exécute même si le précédent a échoué
  urlQueues.set(url, next.catch(() => {})); // ne jamais casser la chaîne
  return next;
}

function maskWebhook(url) {
  return String(url || '')
    .replace(/(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***')
    .replace(/(webhooks\/\d+\/)[\w-]{20,}/gi, '$1***');
}

function sanitizeLogText(text, url) {
  let s = maskWebhook(String(text || ''));
  if (url) {
    const m = String(url).match(/\/webhooks\/\d+\/([\w-]+)/i);
    if (m && m[1] && m[1].length >= 10) s = s.split(m[1]).join('***');
  }
  return s.slice(0, 400);
}

function isWebhookUrl(url) {
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i.test(
    String(url || ''),
  );
}

// Aucun emoji dans les messages : retirés de tous les textes envoyés
// (hors blocs de code ``` qui contiennent des données brutes du client).
const EMOJI_RE = /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}])(?:\u{FE0F}|\u{20E3}|\u{200D}(?:\p{Extended_Pictographic}))*\u{FE0F}?/gu;
const EMOJI_SP_RE = new RegExp(EMOJI_RE.source + '[ \\t]?', 'gu');
const TEXT_KEYS = new Set(['content', 'title', 'description', 'name', 'value', 'text', 'label']);

const FLAG_RE = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu;
const flagCode = (_m, a, b) => String.fromCharCode(65 + a.codePointAt(0) - 0x1f1e6, 65 + b.codePointAt(0) - 0x1f1e6);

function stripEmojiText(str) {
  if (typeof str !== 'string' || !str) return str;
  // Drapeaux → codes pays, globe → « Monde », interdit → « sauf »
  str = str
    .replace(/\u{1F6AB}\s*/gu, 'sauf ')
    .replace(FLAG_RE, flagCode)
    .replace(/[\u{1F30D}\u{1F30E}\u{1F30F}]/gu, 'Monde');
  return str
    .split(/(```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<t:\d+(?::\w)?>)/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // code / mention / timestamp : intact
      return part.replace(EMOJI_SP_RE, '').replace(/[\u{FE0F}\u{200D}\u{20E3}]/gu, '');
    })
    .join('');
}

function stripEmojiDeep(v, key) {
  if (typeof v === 'string') return key && TEXT_KEYS.has(key) ? stripEmojiText(v) : v;
  if (Array.isArray(v)) return v.map((x) => stripEmojiDeep(x, key === 'components' || key === 'embeds' || key === 'fields' || key === 'items' ? null : key));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'emoji') continue; // emoji de bouton
      out[k] = stripEmojiDeep(x, k);
    }
    return out;
  }
  return v;
}

function backoff(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** Délai demandé par Discord (ms), ou 0 si inconnu. */
function retryAfterMs(res, json) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    return v == null || v === '' ? NaN : Number(v);
  };
  const candidates = [
    json && Number(json.retry_after),
    h('retry-after'),
    h('x-ratelimit-reset-after'),
  ].filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return 0;
  // Discord renvoie des secondes (float)
  return Math.ceil(Math.max(...candidates) * 1000);
}

/** Longueur « comptée » par Discord pour la limite de 6000 caractères. */
function embedChars(e) {
  if (!e || typeof e !== 'object') return 0;
  let n = 0;
  n += String(e.title || '').length;
  n += String(e.description || '').length;
  if (e.footer) n += String(e.footer.text || '').length;
  if (e.author) n += String(e.author.name || '').length;
  for (const f of e.fields || []) {
    n += String(f.name || '').length + String(f.value || '').length;
  }
  return n;
}

/** Découpe une liste d'embeds en groupes compatibles avec les limites Discord. */
function chunkEmbeds(embeds, maxPerMsg = MAX_EMBEDS_PER_MESSAGE, maxChars = MAX_EMBED_CHARS_PER_MESSAGE) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const e of embeds || []) {
    if (!e) continue;
    const c = embedChars(e);
    if (cur.length && (cur.length >= maxPerMsg || chars + c > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Envoie un message webhook.
 * Les appels parallèles vers la même URL sont automatiquement sérialisés
 * pour éviter les 429 liés au rate-limiting Discord.
 * @returns {Promise<{ok:boolean,status:number,text:string,attempts:number,json?:any}>}
 */
async function sendWebhook(url, body, options = {}) {
  return enqueue(url, () => _sendWebhook(url, body, options));
}

async function _sendWebhook(url, body, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!url) return { ok: false, status: 0, text: 'no webhook url', attempts: 0 };
  let data = opts.identity ? { ...body, ...webhookIdentity(opts.identity) } : body;
  // Sécurité : sans allowed_mentions explicite, aucune mention ne ping
  // (@everyone/@here/rôles/utilisateurs présents dans un texte scrapé).
  if (data && typeof data === 'object' && !data.allowed_mentions && Array.isArray(data.components) && opts.identity) {
    const roles = autoPingRoles(opts.identity, null, data.components);
    if (roles.length) {
      data = { ...data, components: [textDisplay(mentionText(roles)), ...data.components], allowed_mentions: allowedMentions(roles) };
    }
  }
  if (data && typeof data === 'object' && !data.allowed_mentions && (data.components || data.embeds)) {
    data = { ...data, allowed_mentions: { parse: [] } };
  }
  if (data && typeof data === 'object' && process.env.WEBHOOK_KEEP_EMOJI !== '1') {
    const { username, avatar_url } = data;
    data = stripEmojiDeep(data);
    if (username !== undefined) data.username = username;
    if (avatar_url !== undefined) data.avatar_url = avatar_url;
  }
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const label = opts.label || '';
  let last = { ok: false, status: 0, text: '', attempts: 0 };
  let rateLimited = 0;
  let tries = 0; // requêtes réellement émises (429 compris)

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    tries++;
    const waitBucket = bucketResetAt - Date.now();
    if (waitBucket > 0) await sleep(Math.min(waitBucket, opts.maxDelayMs));

    let res;
    try {
      res = await (opts.fetchImpl || fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeout: opts.timeoutMs,
        ...(String(url).startsWith('https:') ? { agent: webhookAgent } : {}),
      });
    } catch (e) {
      last = { ok: false, status: 0, text: sanitizeLogText(e && (e.message || e), url), attempts: tries };
      const d = backoff(attempt, opts);
      console.warn(`webhook network error (${attempt + 1}/${opts.maxAttempts}) ${label}`, last.text, `wait ${d}ms`);
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    last = { ok: res.ok, status: res.status, text: text.slice(0, 500), attempts: tries, json };

    const remaining = res.headers && res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const ra = retryAfterMs(res, null);
      if (ra > 0) bucketResetAt = Date.now() + ra;
    }

    if (res.ok) {
      // Pause seulement si Discord ne nous dit pas qu'il reste du quota
      // (remaining > 0 → envoi suivant immédiat, remaining = 0 → bucketResetAt).
      const hasQuota = remaining != null && remaining !== '' && Number(remaining) > 0;
      if (opts.minGapMs && !hasQuota && remaining !== '0') await sleep(opts.minGapMs);
      return last;
    }

    if (res.status === 429 || res.status >= 500) {
      const ra = res.status === 429 ? retryAfterMs(res, json) : 0;
      // 429 : on attend TOUT le délai demandé par Discord. Avant : plafonné à
      // 30 s → nouvelle tentative trop tôt, re-429, tentatives épuisées et
      // message jamais envoyé sur les gros lots.
      const cap = res.status === 429 ? opts.max429WaitMs : opts.maxDelayMs;
      const d = Math.min(cap, ra > 0 ? ra + 100 : backoff(attempt + rateLimited, opts));
      console.warn(`webhook ${res.status} (${attempt + 1}/${opts.maxAttempts}) ${label} wait ${d}ms`);
      // Attente demandée déraisonnable (ban temporaire) : échec immédiat, le
      // run suivant reprendra (dedupe) au lieu de bloquer le job jusqu'au timeout.
      if (res.status === 429 && ra > opts.max429WaitMs) return last;
      if (res.status === 429 && rateLimited < opts.max429Retries) {
        rateLimited++;
        await sleep(d);
        attempt--; // ne consomme pas le budget d'échecs
        continue;
      }
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    // 4xx : payload invalide / webhook supprimé → pas de retry
    console.warn(`webhook fail ${res.status} ${label} ${maskWebhook(url)}`, sanitizeLogText(last.text, url));
    return last;
  }

  console.warn(`webhook gave up after ${last.attempts} attempts ${label}`, last.status, sanitizeLogText(last.text, url));
  return last;
}

/**
 * Ajoute with_components=true à l'URL du webhook (requis pour Components V2).
 */
function withComponentsUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('with_components', 'true');
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'with_components=true';
  }
}

/**
 * Envoie une liste d'embeds en les convertissant automatiquement en Components V2.
 * Les embeds sont transformés en Container + TextDisplay, ce qui :
 * - Supporte du texte bien plus long (4000 chars par TextDisplay vs 1024 par field)
 * - Évite les erreurs de limite de 6000 chars par embed
 * - Gère automatiquement le dépassement en multipliant les messages
 * Arrête au premier échec (retourne le résultat de l'échec).
 */
async function sendEmbeds(url, base, embeds, options = {}) {
  if (!url || !embeds || !embeds.length)
    return { ok: false, status: 0, text: 'skip', attempts: 0, sent: 0 };

  // Convertir les embeds en messages Components V2 avec bouton dismiss
  const withDismiss = options.withDismiss !== false;
  const messages = embedsToComponents(embeds, withDismiss);
  if (!messages.length)
    return { ok: false, status: 0, text: 'no components', attempts: 0, sent: 0 };

  const componentUrl = withComponentsUrl(url);
  let last = { ok: true, status: 204, text: '', attempts: 0 };
  let sent = 0;
  // Ping de rôle(s) : uniquement sur le 1er message (pas sur les suites).
  const pingRoles = [].concat(options.pingRoles || autoPingRoles(options.identity, embeds)).filter(Boolean);

  for (let mi = 0; mi < messages.length; mi++) {
    let components = messages[mi];
    const ping = mi === 0 && pingRoles.length ? pingRoles : [];
    if (ping.length) components = [textDisplay(mentionText(ping)), ...components];
    const body = {
      ...base,
      flags: IS_COMPONENTS_V2_FLAG,
      components,
      allowed_mentions: allowedMentions(ping),
    };
    // Supprimer embeds/content qui ne fonctionnent pas avec Components V2
    delete body.embeds;
    delete body.content;

    last = await sendWebhook(componentUrl, body, options);
    // 400 = payload refusé : réessayer à l'identique échouerait à chaque run
    // et bloquerait TOUTES les notifications suivantes → repli en texte brut.
    if (!last.ok && last.status === 400 && options.plainFallback !== false) {
      console.warn('webhook 400 — repli en texte brut', options.label || '', sanitizeLogText(last.text, url));
      last = await sendPlainFallback(url, base, components, options);
    }
    if (!last.ok) return { ...last, sent };
    sent += 1;
  }
  return { ...last, sent };
}

/** Texte de tous les TextDisplay d'un arbre de composants. */
function collectText(comp, out) {
  if (!comp || typeof comp !== 'object') return out;
  if (comp.type === 10 && typeof comp.content === 'string' && comp.content.trim()) out.push(comp.content);
  if (Array.isArray(comp.components)) for (const c of comp.components) collectText(c, out);
  return out;
}

/** Découpe en messages « content » (≤ 2000) sans casser les blocs de code. */
function plainChunks(text, max = 1900) {
  const out = [];
  let open = false; // bloc ``` resté ouvert à la fin du morceau précédent
  for (let part of chunkText(text, max - 16)) {
    if (open) part = '```diff\n' + part;
    open = (part.match(/```/g) || []).length % 2 === 1;
    if (open) part = part.replace(/\s+$/, '') + '\n```';
    if (part.trim()) out.push(part);
  }
  return out;
}

async function sendPlainFallback(url, base, components, options) {
  const text = (components || []).reduce((acc, c) => collectText(c, acc), []).join('\n');
  let last = { ok: false, status: 400, text: 'empty fallback', attempts: 0 };
  for (const content of plainChunks(text)) {
    last = await sendWebhook(url, { ...base, content, allowed_mentions: { parse: [] } }, options);
    if (!last.ok) return last;
  }
  return last;
}

function _resetBucket() {
  bucketResetAt = 0;
}

module.exports = {
  sendWebhook,
  sendEmbeds,
  sendComponentsV2: sendEmbeds, // alias pour clarté
  withComponentsUrl,
  chunkEmbeds,
  plainChunks,
  embedChars,
  retryAfterMs,
  maskWebhook,
  sanitizeLogText,
  stripEmojiText,
  stripEmojiDeep,
  isWebhookUrl,
  MAX_EMBEDS_PER_MESSAGE,
  MAX_EMBED_CHARS_PER_MESSAGE,
  _resetBucket,
};
