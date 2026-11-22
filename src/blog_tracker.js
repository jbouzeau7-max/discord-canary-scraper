/**
 * Discord Blog + Help Centers tracker
 *
 * Sources:
 *  - Blog: https://discord.com/blog/rss.xml (corps hashé depuis content:encoded
 *    quand présent — sinon fetch de la page article en fallback)
 *  - Zendesk help centers:
 *      support.discord.com        (centre d'aide principal)
 *      support-dev.discord.com    (support développeurs)
 *      support-apps.discord.com   (support apps)
 *      creator-support.discord.com (support créateurs)
 *
 * Features:
 *  - retries avec backoff (1s/2s/4s) par source, Retry-After respecté (RSS + Zendesk)
 *  - quota Zendesk partagé par IP : appels sérialisés (2 en vol max, espacement
 *    minimal) et pause globale sur 429 avant toute réémission
 *  - health gate: message d'erreur sur la webhook si une source est down
 *    (dédupliqué 6h) + lien vers le run GitHub Actions
 *  - noms de sections/catégories Zendesk (via sections.json + categories.json)
 *  - hashVersion: un changement de méthode de hash ne déclenche pas de fausse
 *    notif "updated" (le corps n'est comparé que si les versions de hash matchent)
 *  - pruning: les articles disparus du catalogue sont gardés 90j (help) / 180j
 *    (blog), puis supprimés de l'état pour qu'il ne grossisse pas à l'infini
 *
 * State: data/blog_tracker.json
 * Webhook: BLOG_WEBHOOK_URL → ZENDESK_WEBHOOK_URL → DISCORD_WEBHOOK_URL
 * Opt-in: BLOG_NOTIFY_REMOVED=1 pour notifier aussi les suppressions
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { sendWebhook, withComponentsUrl } = require('./lib/webhook');
const {
  IS_COMPONENTS_V2_FLAG,
  textDisplay,
  mediaGalleryFromUrls,
  linkButton,
  chunkIntoMessages,
} = require('./lib/components_v2');
const { writeJsonAtomic } = require('./lib/atomic');
const { fetchWithRetry, extractRetryAfterMs, isRetryableStatus } = require('./lib/http');
const { sleep, DEFAULT_UA, DEFAULT_AVATAR_URL } = require('./lib/utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'blog_tracker.json');

const WEBHOOK_CANDIDATES = [
  ['BLOG_WEBHOOK_URL', process.env.BLOG_WEBHOOK_URL],
  ['ZENDESK_WEBHOOK_URL', process.env.ZENDESK_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  DEFAULT_AVATAR_URL;

const BLOG_RSS = 'https://discord.com/blog/rss.xml';

const HELP_CENTERS = [
  {
    key: 'support',
    label: 'Help Center',
    hosts: ['https://support.discord.com', 'https://discord.zendesk.com'],
  },
  { key: 'dev', label: 'Developer Support', hosts: ['https://support-dev.discord.com'] },
  { key: 'apps', label: 'Apps Support', hosts: ['https://support-apps.discord.com'] },
  { key: 'creator', label: 'Creator Support', hosts: ['https://creator-support.discord.com'] },
];

const COLORS = {
  added: 0x57f287,
  updated: 0xfee75c,
  removed: 0xed4245,
  blog: 0x5865f2,
};

// Version du hash du corps — incrémentée quand la méthode de hash change.
// Un article ancien (v1/absent) vs nouveau (v2) ne produit pas de notif "updated".
const HASH_VERSION = 2;

const BLOG_STALE_DAYS = 180; // articles blog hors RSS gardés en état
const HELP_STALE_DAYS = 90; // articles help hors catalogue gardés en état
const ERROR_NOTIFY_EVERY_MS = 6 * 3600 * 1000; // message d'erreur max toutes les 6h
const MAX_NOTIFY_PER_RUN = 30;

const RUN_URL =
  process.env.GITHUB_SERVER_URL &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

// ── Text helpers ──────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return ' ';
      }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return ' ';
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // &amp; en tout dernier pour ne pas double-décoder (&amp;lt; reste &lt;)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function firstImage(html) {
  // Ignore logos / SVG / icônes : Discord ne les rend pas en MediaGallery
  for (const m of String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const u = m[1];
    if (/\.(svg|svgz|ico)(\?|#|$)/i.test(u)) continue;
    if (/(^|[\/_-])(logo|icon|favicon|avatar)[^\/]*$/i.test(u)) continue;
    return u;
  }
  return null;
}

/** og:image / twitter:image (ordre d'attributs libre), sans SVG. */
function metaImage(html) {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["']/i.test(tag)) continue;
    const c = tag.match(/content=["']([^"']+)["']/i);
    if (c && !/\.(svg|svgz|ico)(\?|#|$)/i.test(c[1])) return c[1];
  }
  return null;
}

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

function formatDateEn(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 40);
    const date = d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${date} at ${time} UTC`;
  } catch {
    return String(iso).slice(0, 40);
  }
}

function escapeMdTitle(t) {
  return truncate(t || 'Untitled', 200)
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}
/** Neutralise les runs de backticks pour insérer du texte dans un bloc de code. */
function sanitizeCodeBlock(s) {
  return String(s || '').replace(/`+/g, (m) => '`\u200b'.repeat(m.length));
}

/** Bloc de code Discord (les backticks du texte sont neutralisés). */
function codeBlock(s) {
  return '```\n' + sanitizeCodeBlock(s) + '\n```';
}

/**
 * Première divergence entre deux aperçus + fenêtre centrée dessus
 * (± radius caractères) pour montrer directement ce qui a changé.
 */
function firstDivergence(before, after, radius = 120) {
  const b = String(before || '');
  const a = String(after || '');
  let i = 0;
  while (i < Math.min(b.length, a.length) && b[i] === a[i]) i++;
  const start = Math.max(0, i - radius);
  const end = start + 2 * radius;
  const win = (s) =>
    (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
  return { pos: i, before: win(b), after: win(a) };
}

// ── HTTP ──────────────────────────────────────────────

const BLOG_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 90 * 1000; // garde-fou: le job a 12 min de budget

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: opts.accept || 'text/html,application/json,*/*',
      ...(opts.headers || {}),
    },
    timeout: opts.timeout || 30000,
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + url);
    err.status = res.status;
    err.retryAfterMs = extractRetryAfterMs(res, null);
    throw err;
  }
  return res.text();
}

// ── Quota Zendesk (partagé par IP entre tous les help centers) ──────────
// Les 4 help centers tapent le même edge depuis la même IP de runner : un
// burst de requêtes simultanées se fait 429 (observé sur apps/creator).
// → max 2 requêtes en vol, espacement minimal entre départs, et sur 429 tout
// le client patiente le Retry-After annoncé avant de réémettre.

const ZENDESK_MAX_IN_FLIGHT = 2;
const ZENDESK_MIN_GAP_MS = 150;
const ZENDESK_MAX_ATTEMPTS = 4;
const ZENDESK_MAX_RETRY_AFTER_MS = 90 * 1000;
const ZENDESK_MAX_BACKOFF_MS = 8000;

let zendeskInFlight = 0;
const zendeskWaiters = [];
let zendeskNextStart = 0;
let zendeskBlockedUntil = 0;
// Horloge logique : garde l'espacement effectif même si sleep est stubé (tests).
let zendeskClock = 0;
const zdNow = () => Math.max(Date.now(), zendeskClock);

async function zendeskWait(untilMs) {
  const now = zdNow();
  if (untilMs <= now) return;
  zendeskClock = untilMs; // réserve le créneau dans la timeline logique
  await sleep(untilMs - now);
}

async function acquireZendeskSlot() {
  // Réservation synchrone du prochain départ (pas d'await avant) → l'ordre et
  // l'espacement sont déterministes même avec 4 centers en parallèle.
  const start = Math.max(zdNow(), zendeskNextStart, zendeskBlockedUntil);
  zendeskNextStart = start + ZENDESK_MIN_GAP_MS;
  if (zendeskInFlight >= ZENDESK_MAX_IN_FLIGHT) {
    await new Promise((resolve) => zendeskWaiters.push(resolve));
  } else {
    zendeskInFlight++;
  }
  await zendeskWait(start);
}

function releaseZendeskSlot() {
  const next = zendeskWaiters.shift();
  if (next) {
    next(); // créneau transféré au waiter, zendeskInFlight inchangé
    return;
  }
  zendeskInFlight--;
}

function httpError(status, url, extra = {}) {
  const err = new Error(`HTTP ${status} ${url}`);
  err.status = status;
  if (status === 429) err.rateLimited = true;
  return Object.assign(err, extra);
}

/**
 * GET JSON sur une API Zendesk via la porte de quota partagée.
 * Retry sur 429/408/425/5xx en respectant Retry-After (échec rapide et clair
 * si la consigne dépasse le budget du run — pas de contournement).
 */
async function fetchZendeskJson(url, opts = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= ZENDESK_MAX_ATTEMPTS; attempt++) {
    await acquireZendeskSlot();
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json',
          ...(opts.headers || {}),
        },
        timeout: opts.timeout || 30000,
      });
    } catch (e) {
      releaseZendeskSlot();
      lastErr = e;
      if (attempt === ZENDESK_MAX_ATTEMPTS) break;
      const wait = Math.min(ZENDESK_MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt - 1));
      console.warn(`zendesk réseau ${String(e.message || e).slice(0, 90)} — retry dans ${wait}ms`);
      await zendeskWait(zdNow() + wait);
      continue;
    }

    try {
      const status = Number(res.status) || 0;
      if (res.ok) return JSON.parse(await res.text());

      const retryAfterMs = extractRetryAfterMs(res, null);
      if (typeof res.text === 'function') await res.text().catch(() => '');
      lastErr = httpError(status, url, { retryAfterMs });

      if (!isRetryableStatus(status) || attempt === ZENDESK_MAX_ATTEMPTS) break;

      const wait = retryAfterMs > 0
        ? retryAfterMs
        : Math.min(ZENDESK_MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt - 1));
      if (wait > ZENDESK_MAX_RETRY_AFTER_MS) {
        throw httpError(status, url, {
          retryAfterMs: wait,
          message: `HTTP ${status} ${url} — Retry-After ${Math.ceil(wait / 1000)}s > budget ${Math.round(ZENDESK_MAX_RETRY_AFTER_MS / 1000)}s`,
        });
      }
      if (status === 429) {
        // Quota partagé : on met tout le client en pause, pas juste cette requête.
        zendeskBlockedUntil = Math.max(zendeskBlockedUntil, zdNow() + wait);
        console.warn(
          `zendesk 429 ${url.slice(0, 90)} — pause globale ${Math.round(wait / 1000)}s (Retry-After)`,
        );
      } else {
        console.warn(`zendesk HTTP ${status} — retry ${attempt}/${ZENDESK_MAX_ATTEMPTS} dans ${wait}ms`);
        await zendeskWait(zdNow() + wait);
      }
    } finally {
      releaseZendeskSlot();
    }
  }
  throw lastErr || new Error('zendesk fetch failed ' + url);
}

/** Flux RSS blog : retries + Retry-After via le helper réseau partagé. */
async function fetchBlogRss() {
  const res = await fetchWithRetry(BLOG_RSS, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    timeout: 30000,
    maxAttempts: BLOG_MAX_ATTEMPTS,
    maxRetryAfterMs: MAX_RETRY_AFTER_MS,
    label: 'blog rss',
  });
  if (!res.ok) throw httpError(Number(res.status) || 0, BLOG_RSS);
  return res.text();
}


// ── Blog (RSS) ────────────────────────────────────────

function parseRssItems(xml, requireEnvelope = false) {
  const items = [];
  const $ = cheerio.load(xml, { xml: { withStartIndices: true, withEndIndices: true } });
  // XML mode recovers unclosed elements; require their actual closing tags in the input.
  const explicitlyClosed = el => el && el.endIndex < xml.length &&
    xml.slice(xml.lastIndexOf('<', el.endIndex), el.endIndex + 1).trimEnd().replace(/\s+>$/, '>') === `</${el.name}>`;
  const entries = $('item').toArray();
  if (requireEnvelope) {
    const roots = $.root().children();
    const channels = roots.children('channel');
    if (roots.length !== 1 || !roots.is('rss') || !explicitlyClosed(roots[0]) ||
        channels.length !== 1 || !explicitlyClosed(channels[0]) ||
        entries.some(el => el.parent !== channels[0])) throw new Error('Incomplete blog RSS envelope');
  }
  for (const el of entries) {
    if (!explicitlyClosed(el)) throw new Error('Incomplete blog RSS item');
    const chunk = xml.slice(el.startIndex, el.endIndex + 1);
    const get = (tag) => {
      const m = chunk.match(
        new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i'),
      );
      if (m) return m[1].trim();
      const m2 = chunk.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return m2 ? m2[1].trim() : null;
    };
    const title = get('title');
    const link = get('link') || get('guid');
    const pubDate = get('pubDate') || get('dc:date');
    const description = get('description') || '';
    const content = get('content:encoded') || null;
    const mediaM = chunk.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*url=["']([^"']+)["']/i);
    const image = mediaM && !/\.(svg|svgz|ico)(\?|#|$)/i.test(mediaM[1]) ? mediaM[1] : null;
    if (!link) continue;
    items.push({
      id: link,
      title: stripHtml(title || link),
      link,
      pubDate,
      description: stripHtml(description).slice(0, 500),
      content,
      image,
    });
  }
  return items;
}

async function fetchBlogPostBody(link) {
  try {
    const html = await fetchText(link, { timeout: 25000 });
    let body = null;
    const rich = html.match(
      /<article[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
    );
    if (rich) body = rich[1];
    if (!body) {
      const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (main) body = main[1];
    }
    if (!body) body = html;
    const text = stripHtml(body);
    const thumb = metaImage(html) || firstImage(body) || firstImage(html);
    return { bodyHash: sha256(text), bodyPreview: truncate(text, 400), thumb };
  } catch (e) {
    console.warn('blog body fail', link, String(e.message || e).slice(0, 80));
    return { bodyHash: null, bodyPreview: null, thumb: null };
  }
}

/**
 * Récupère les articles blog. Le hash du corps vient du content:encoded du RSS
 * quand il est disponible (aucun fetch article nécessaire) ; sinon fetch de la
 * page pour les nouveaux articles seulement.
 */
async function fetchBlog(oldById) {
  const xml = await fetchBlogRss();
  const items = parseRssItems(xml, true);
  if (!items.length) throw new Error('Blog RSS returned no usable articles');
  console.log('Blog RSS items:', items.length);

  const queue = items.slice(0, Math.min(items.length, 40));
  const freshIds = new Set(queue.map((it) => it.id));
  const out = [];
  let i = 0;
  const workers = 4;
  async function worker() {
    while (i < queue.length) {
      const idx = i++;
      const it = queue[idx];
      const old = oldById[it.id];
      let bodyHash = old ? old.bodyHash : null;
      let bodyPreview = old ? old.bodyPreview : null;
      let thumb = old ? old.thumb : null;
      let hashVersion;
      if (it.content) {
        const text = stripHtml(it.content);
        bodyHash = sha256(text);
        bodyPreview = truncate(text, 400);
        thumb = firstImage(it.content) || it.image || thumb;
        hashVersion = HASH_VERSION;
      } else if (bodyHash) {
        // Hash hérité de l'état précédent : on le garde tel quel avec sa
        // version d'origine (comparable uniquement avec lui-même).
        hashVersion = old.hashVersion || 1;
      } else {
        await sleep(100);
        const b = await fetchBlogPostBody(it.link);
        bodyHash = b.bodyHash || bodyHash;
        bodyPreview = b.bodyPreview || bodyPreview;
        thumb = b.thumb || thumb;
        hashVersion = HASH_VERSION;
      }
      out.push({
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate,
        description: it.description,
        bodyHash,
        hashVersion,
        bodyPreview,
        thumb,
        source: 'blog',
      });
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));

  // Articles hors RSS : gardés 180j puis pruning
  const cutoff = Date.now() - BLOG_STALE_DAYS * 86400000;
  let keptStale = 0;
  for (const [id, old] of Object.entries(oldById)) {
    if (freshIds.has(id) || old.source !== 'blog') continue;
    if (Date.parse(old.pubDate || '') > cutoff) {
      out.push(old);
      keptStale++;
    }
  }
  if (keptStale) console.log('Blog kept stale (out of RSS):', keptStale);
  return out;
}

// ── Zendesk help centers ───────────────────────────────

/** sections.json + categories.json → Map(sectionId → "Catégorie · Section"). */
async function fetchHelpMeta(center) {
  const host = center.hosts[0];
  const categories = new Map();
  const sections = new Map();
  let page = `${host}/api/v2/help_center/en-us/categories.json?per_page=100`;
  let pages = 0;
  while (page && pages < 10) {
    pages++;
    const data = await fetchZendeskJson(page, { timeout: 20000, label: `help meta ${center.key}` });
    for (const c of data.categories || []) categories.set(String(c.id), c.name || '');
    page = data.next_page || null;
    await sleep(100);
  }
  page = `${host}/api/v2/help_center/en-us/sections.json?per_page=100`;
  pages = 0;
  while (page && pages < 15) {
    pages++;
    const data = await fetchZendeskJson(page, { timeout: 20000, label: `help sections ${center.key}` });
    for (const s of data.sections || []) {
      const cat = categories.get(String(s.category_id)) || '';
      sections.set(String(s.id), cat ? `${cat} · ${s.name || ''}` : (s.name || ''));
    }
    page = data.next_page || null;
    await sleep(100);
  }
  console.log(`Help meta ${center.key}: ${sections.size} sections, ${categories.size} categories`);
  return sections;
}

async function fetchHelpArticles(host, center, sectionsById) {
  const list = [];
  const seen = new Set();
  let page = `${host}/api/v2/help_center/en-us/articles.json?per_page=100&sort_by=updated_at&sort_order=desc`;
  let pages = 0;
  while (page && pages < 25) {
    pages++;
    const data = await fetchZendeskJson(page, { timeout: 30000, label: `help ${center.key}` });
    if (!Array.isArray(data.articles)) throw new Error('Zendesk response is missing articles');
    if (data.next_page !== null && (typeof data.next_page !== 'string' || !data.next_page.trim())) {
      throw new Error('Zendesk response has missing or invalid next_page');
    }
    const batch = data.articles;
    for (const a of batch) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const body = a.body || '';
      const text = stripHtml(body);
      list.push({
        id: String(a.id),
        title: a.title || String(a.id),
        link: a.html_url || `${host}/hc/en-us/articles/${a.id}`,
        updatedAt: a.updated_at || a.edited_at || null,
        createdAt: a.created_at || null,
        sectionId: a.section_id != null ? String(a.section_id) : null,
        sectionName: a.section_id != null ? sectionsById.get(String(a.section_id)) || null : null,
        bodyHash: sha256(text),
        hashVersion: HASH_VERSION,
        bodyPreview: truncate(text, 400),
        thumb: firstImage(body),
        source: center.key,
        label: center.label,
      });
    }
    page = data.next_page;
    if (!batch.length) break;
    if (page && pages < 25) await sleep(150);
  }
  if (page) throw new Error('Incomplete Zendesk pagination');
  console.log(`Help ${center.key}: ${list.length} articles (${pages} pages)`);
  return list;
}

async function fetchHelpCenter(center, sectionsById) {
  let lastErr = null;
  for (const host of center.hosts) {
    try {
      return await fetchHelpArticles(host, center, sectionsById);
    } catch (e) {
      if (e.status === 429) throw e;
      lastErr = e;
      console.warn(`help ${center.key} via ${host}:`, String(e.message || e).slice(0, 100));
    }
  }
  throw lastErr || new Error(`help center ${center.key} fetch failed`);
}

/** Fusionne le catalogue frais avec les anciens articles disparus (< 90j). */
function keepStaleHelp(fresh, prevList, sourceKey) {
  const freshIds = new Set(fresh.map((e) => String(e.id)));
  const cutoff = Date.now() - HELP_STALE_DAYS * 86400000;
  const out = [...fresh];
  let kept = 0;
  for (const o of prevList || []) {
    if (freshIds.has(String(o.id)) || o.source !== sourceKey) continue;
    if (Date.parse(o.updatedAt || o.createdAt || '') > cutoff) {
      out.push(o);
      kept++;
    }
  }
  if (kept) console.log(`help ${sourceKey}: kept stale:`, kept);
  return out;
}

// ── Diff ───────────────────────────────────────────────

function indexById(list) {
  const m = {};
  for (const e of list || []) {
    if (e && e.id != null && e.id !== '') m[String(e.id)] = e;
  }
  return m;
}

function computeDiff(oldList, newList, source) {
  const oldM = indexById(oldList);
  const newM = indexById(newList);
  const added = [];
  const updated = [];
  const removed = [];
  for (const [id, n] of Object.entries(newM)) {
    const o = oldM[id];
    if (!o) {
      added.push(n);
      continue;
    }
    const changes = [];
    if (n.title && o.title && n.title !== o.title) {
      changes.push({ kind: 'title', label: 'Title', before: o.title, after: n.title });
    }
    // Le corps n'est comparé que si la méthode de hash est identique des deux
    // côtés (absent = legacy v1). Sinon: migration silencieuse, pas de notif.
    const hashComparable = (o.hashVersion || 1) === (n.hashVersion || 1);
    if (hashComparable && n.bodyHash && o.bodyHash && n.bodyHash !== o.bodyHash) {
      // Toujours notifier un changement de corps, même si l'aperçu capturé
      // (400 chars) est identique → "modified beyond the captured excerpt".
      changes.push({
        kind: 'body',
        label: 'Body',
        before: o.bodyPreview || null,
        after: n.bodyPreview || null,
      });
    }
    if (
      n.description &&
      o.description &&
      n.description !== o.description &&
      !changes.some((c) => c.kind === 'body')
    ) {
      changes.push({
        kind: 'description',
        label: 'Summary',
        before: o.description,
        after: n.description,
      });
    }
    if (n.link && o.link && n.link !== o.link) {
      changes.push({ kind: 'link', label: 'Link', before: o.link, after: n.link });
    }
    if (n.thumb && o.thumb && n.thumb !== o.thumb) {
      changes.push({ kind: 'thumb', label: 'Image', before: o.thumb, after: n.thumb });
    }
    if (changes.length) {
      updated.push({
        ...n,
        _changes: changes,
        _previous: { title: o.title, bodyPreview: o.bodyPreview },
      });
    }
  }
  for (const [id, o] of Object.entries(oldM)) {
    if (!newM[id] && o.source === source) removed.push(o);
  }
  const byDate = (a, b) => {
    const da = Date.parse(a.updatedAt || a.pubDate || a.createdAt || 0) || 0;
    const db = Date.parse(b.updatedAt || b.pubDate || b.createdAt || 0) || 0;
    return db - da;
  };
  added.sort(byDate);
  updated.sort(byDate);
  return { added, updated, removed };
}

// ── Messages (Components V2, style tracker sobre) ─────

function colorFor(source, action) {
  if (action === 'updated') return COLORS.updated;
  if (action === 'removed') return COLORS.removed;
  return source === 'blog' ? COLORS.blog : COLORS.added;
}

/** Lignes "ce qui a changé" pour les updates (blog + help). */
function changeText(entry) {
  const lines = [];
  for (const c of entry._changes || []) {
    if (c.kind === 'title') {
      lines.push(`**Title** · ~~${truncate(c.before, 100)}~~ → **${truncate(c.after, 100)}**`);
    } else if (c.kind === 'body') {
      lines.push('**Body** · modified');
      if (c.before && c.after && c.before !== c.after) {
        const w = firstDivergence(c.before, c.after);
        lines.push(`-# First change around character ${w.pos + 1}`);
        lines.push('**Before**');
        lines.push(codeBlock(w.before));
        lines.push('**After**');
        lines.push(codeBlock(w.after));
      } else {
        lines.push('> Modified beyond the captured excerpt');
      }
    } else if (c.kind === 'description') {
      const w = firstDivergence(c.before, c.after, 80);
      lines.push('**Summary** · changed', '**Before**', codeBlock(w.before), '**After**', codeBlock(w.after));
    } else if (c.kind === 'link') {
      lines.push('**Link** · changed');
    } else if (c.kind === 'thumb') {
      lines.push('**Image** · changed');
    } else {
      lines.push(`**${c.label || c.kind}** · changed`);
    }
  }
  return lines.length ? textDisplay(lines.join('\n')) : null;
}

function actionRow(buttons) {
  const valid = (buttons || []).filter(Boolean).slice(0, 4);
  return valid.length ? { type: 1, components: valid } : null;
}

function buildBlogComps(entry, action) {
  const comps = [];
  const headline =
    action === 'added'
      ? '## New Blog Post'
      : action === 'updated'
        ? '## Blog Post Updated'
        : '## Blog Post Removed';
  comps.push(textDisplay(headline));

  const gallery = mediaGalleryFromUrls(
    entry.thumb && /^https?:\/\//i.test(String(entry.thumb)) ? [entry.thumb] : [],
  );
  if (gallery) comps.push(gallery);

  comps.push(
    textDisplay(entry.link ? `### [${escapeMdTitle(entry.title)}](${entry.link})` : '### ' + escapeMdTitle(entry.title)),
  );

  if (action === 'updated') {
    const ct = changeText(entry);
    if (ct) comps.push(ct);
  } else {
    const preview = truncate((entry.bodyPreview || entry.description || '').trim(), 280);
    if (preview) comps.push(textDisplay(preview));
    const pub = formatDateEn(entry.pubDate);
    if (pub) comps.push(textDisplay(`-# Published ${pub}`));
  }

  if (entry.link && action !== 'removed') {
    comps.push(actionRow([linkButton('Read article', entry.link)]));
  }
  comps.push(textDisplay('-# Datamining · Blog Discord' + (action === 'updated' ? ' · updated' : '')));
  return comps;
}

function buildHelpComps(entry, action, center) {
  const comps = [];
  const headline =
    action === 'added'
      ? '## New Help Center Article'
      : action === 'updated'
        ? '## Help Center Article Updated'
        : '## Help Center Article Removed';
  comps.push(textDisplay(headline));

  const gallery = mediaGalleryFromUrls(
    entry.thumb && /^https?:\/\//i.test(String(entry.thumb)) ? [entry.thumb] : [],
  );
  if (gallery) comps.push(gallery);

  comps.push(
    textDisplay(entry.link ? `### [${escapeMdTitle(entry.title)}](${entry.link})` : '### ' + escapeMdTitle(entry.title)),
  );

  if (action === 'updated') {
    const ct = changeText(entry);
    if (ct) comps.push(ct);
  } else {
    const info = [];
    if (entry.sectionName) info.push(`**Section** · ${truncate(entry.sectionName, 80)}`);
    else if (entry.sectionId) info.push(`**Section** · \`${entry.sectionId}\``);
    const upd = formatDateEn(entry.updatedAt);
    if (upd) info.push(`**Updated** · ${upd}`);
    if (info.length) comps.push(textDisplay(info.join('\n')));
    const preview = truncate((entry.bodyPreview || '').trim(), 280);
    if (preview) comps.push(textDisplay(preview));
  }

  if (entry.link && action !== 'removed') {
    comps.push(actionRow([linkButton('Open article', entry.link)]));
  }
  comps.push(textDisplay(`-# Datamining · Help Center · ${center.label}`));
  return comps;
}

function buildHealthComps(statuses) {
  const lines = statuses.map(
    (s) =>
      `**${s.label}** · ${
        s.ok
          ? 'OK'
          : (s.rateLimited ? 'FAILED (rate limited) — ' : 'FAILED — ') +
            truncate(s.error || 'unknown error', 90)
      }`,
  );
  const comps = [
    textDisplay('## Blog Tracker Error'),
    textDisplay(lines.join('\n')),
  ];
  const row = actionRow(RUN_URL ? [linkButton('Actions run', RUN_URL)] : []);
  if (row) comps.push(row);
  comps.push(textDisplay('-# Datamining · Blog Tracker'));
  return comps;
}

// ── Webhook ───────────────────────────────────────────

/** Envoie des composants Components V2 (boutons inclus) sur la webhook. */
async function postComponents(comps, accentColor) {
  if (!WEBHOOK) return false;
  const messages = chunkIntoMessages(comps, accentColor, true);
  for (const componentsMsg of messages) {
    const r = await sendWebhook(
      withComponentsUrl(WEBHOOK),
      {
        username: BOT_NAME,
        avatar_url: AVATAR,
        flags: IS_COMPONENTS_V2_FLAG,
        components: componentsMsg,
      },
      { identity: 'blog', label: 'blog' },
    );
    if (!r.ok) {
      console.warn('blog webhook fail', r.status, (r.text || '').slice(0, 200));
      return false;
    }
  }
  return true;
}

async function notifyAll(diffs) {
  if (!WEBHOOK) {
    console.warn('No BLOG_WEBHOOK_URL / DISCORD_WEBHOOK_URL — notifications disabled');
    return { sent: 0, failed: 0, pending: 0, items: [] };
  }
  const queue = [];
  const notifyRemoved = process.env.BLOG_NOTIFY_REMOVED === '1';
  for (const [source, d] of Object.entries(diffs)) {
    for (const e of d.added || []) queue.push({ e, action: 'added', source });
    for (const e of d.updated || []) queue.push({ e, action: 'updated', source });
    if (notifyRemoved) {
      for (const e of d.removed || []) queue.push({ e, action: 'removed', source });
    }
  }
  const batch = queue.slice(0, MAX_NOTIFY_PER_RUN);
  console.log('Notify queue:', queue.length, 'batch:', batch.length);
  const items = [];
  let sent = 0;
  let failed = 0;
  for (const item of batch) {
    let ok = false;
    try {
      const isBlog = item.e.source === 'blog';
      const comps = isBlog
        ? buildBlogComps(item.e, item.action)
        : buildHelpComps(
            item.e,
            item.action,
            HELP_CENTERS.find((c) => c.key === item.e.source) || {
              key: item.e.source,
              label: item.e.label || item.e.source,
            },
          );
      ok = await postComponents(comps, colorFor(item.e.source, item.action));
    } catch (e) {
      console.warn('notify error', item.source, item.e.id, String(e.message || e).slice(0, 100));
      ok = false;
    }
    if (ok) {
      sent++;
      console.log('sent', item.action, item.source, item.e.title);
    } else {
      failed++;
      console.warn('NOTIFY_FAIL', item.action, item.source, item.e.id);
    }
    items.push({ ...item, sent: ok });
    await sleep(300);
  }
  // Les éléments hors lot doivent figurer dans items (sent:false) pour que
  // applyNotifyResult les annule ; sinon ils seraient enregistrés comme vus
  // et jamais notifiés.
  for (const item of queue.slice(batch.length)) items.push({ ...item, sent: false });
  return {
    sent,
    failed,
    pending: Math.max(0, queue.length - batch.length),
    items,
  };
}

/**
 * Applique le résultat des notifs à l'état :
 *  - envoyé → garde la nouvelle version
 *  - échec/pending → revert vers la version précédente (re-notifié au prochain
 *    run) ; un "added" non envoyé est retiré (re-détecté comme "added")
 */
function applyNotifyResult(prevList, freshList, result, sourceKey) {
  const revertIds = new Set();
  for (const item of result.items || []) {
    if (item.source !== sourceKey || item.sent) continue;
    revertIds.add(String(item.e.id));
  }
  const prevM = indexById(prevList);
  const freshM = indexById(freshList);
  const out = [];
  const pushed = new Set();
  for (const e of freshList || []) {
    const id = String(e.id);
    if (revertIds.has(id)) {
      const o = prevM[id];
      if (o && !pushed.has(id)) {
        out.push(o);
        pushed.add(id);
      }
      continue; // added non envoyé → retiré, re-notifié "added" au prochain run
    }
    if (!pushed.has(id)) {
      out.push(e);
      pushed.add(id);
    }
  }
  for (const [id, o] of Object.entries(prevM)) {
    if (!revertIds.has(id) || pushed.has(id) || freshM[id]) continue;
    if (o && o.source === sourceKey) {
      out.push(o);
      pushed.add(id);
    }
  }
  return out;
}

// ── Main ──────────────────────────────────────────────

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('=== Blog + Help Centers tracker ===');
  console.log('Webhook:', WEBHOOK ? WEBHOOK_SOURCE : 'MISSING');

  let previous = { scrapedAt: null, blog: [], help: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {
      console.warn('state read fail', e.message);
    }
  }
  // Migration ancien format: zendesk → help.support
  if (!previous.help) previous.help = {};
  if (previous.zendesk && !(previous.help.support || []).length) {
    previous.help.support = previous.zendesk;
    console.log('Migrated legacy zendesk state → help.support:', previous.zendesk.length);
  }
  previous.blog = previous.blog || [];

  const isFirst =
    !previous.scrapedAt &&
    !previous.blog.length &&
    !Object.values(previous.help).some((l) => (l || []).length);

  const statuses = [];

  // 1. Blog
  let blog = previous.blog;
  try {
    blog = await fetchBlog(indexById(previous.blog));
    statuses.push({ label: 'Blog RSS', ok: true });
  } catch (e) {
    console.error('blog fail', e.message);
    statuses.push({
      label: 'Blog RSS',
      ok: false,
      error: e.message,
      rateLimited: e.rateLimited === true || e.status === 429 || /HTTP 429/.test(String(e.message || '')),
    });
  }

  // 2. Help centers
  const help = {};
  const helpRetryAt = {};
  await Promise.all(HELP_CENTERS.map(async (center) => {
    const prevList = previous.help[center.key] || [];
    const deadline = previous.helpRetryAt?.[center.key];
    if (Number.isFinite(deadline) && deadline > Date.now()) {
      helpRetryAt[center.key] = deadline;
      help[center.key] = prevList;
      statuses.push({ label: center.label, ok: false, rateLimited: true, error: 'Retry-After en cours' });
      return;
    }
    let list = prevList;
    try {
      const sectionsById = await fetchHelpMeta(center).catch((e) => {
        if (e.status === 429) throw e;
        return new Map();
      });
      const fresh = await fetchHelpCenter(center, sectionsById);
      list = keepStaleHelp(fresh, prevList, center.key);
      statuses.push({ label: center.label, ok: true });
    } catch (e) {
      console.error('help fail', center.key, e.message);
      if (e.status === 429 && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0) {
        helpRetryAt[center.key] = Date.now() + e.retryAfterMs;
      }
      statuses.push({
        label: center.label,
        ok: false,
        error: e.message,
        rateLimited: e.rateLimited === true || e.status === 429,
      });
    }
    help[center.key] = list;
  }));

  console.log(
    'Blog entries:', blog.length,
    '| Help:', HELP_CENTERS.map((c) => `${c.key}=${(help[c.key] || []).length}`).join(' '),
  );

  // 3. Diffs
  const diffs = { blog: computeDiff(previous.blog, blog, 'blog') };
  for (const c of HELP_CENTERS) {
    diffs[c.key] = computeDiff(previous.help[c.key] || [], help[c.key] || [], c.key);
  }
  for (const [k, d] of Object.entries(diffs)) {
    console.log(`Diff ${k} a/u/r ${d.added.length}/${d.updated.length}/${d.removed.length}`);
  }

  // 4. Notifications
  let nextBlog = blog;
  const nextHelp = { ...help };
  if (isFirst) {
    console.log('First run — seed state, no notify flood');
  } else {
    const result = await notifyAll(diffs);
    console.log('Notify sent', result.sent, 'failed', result.failed, 'pending', result.pending);
    nextBlog = applyNotifyResult(previous.blog, blog, result, 'blog');
    for (const c of HELP_CENTERS) {
      nextHelp[c.key] = applyNotifyResult(previous.help[c.key] || [], help[c.key] || [], result, c.key);
    }
    if (result.failed > 0) process.exitCode = 2;
    if (result.pending > 0) {
      console.warn('Pending items will be re-notified next run:', result.pending);
    }
  }

  // 5. Health gate — message d'erreur si une source a échoué (max 1 toutes les 6h)
  let lastErrorNotifiedAt = previous.lastErrorNotifiedAt || null;
  const failures = statuses.filter((s) => !s.ok);
  if (failures.length && WEBHOOK) {
    const lastTs = lastErrorNotifiedAt ? Date.parse(lastErrorNotifiedAt) : 0;
    if (Date.now() - (lastTs || 0) > ERROR_NOTIFY_EVERY_MS) {
      try {
        if (!await postComponents(buildHealthComps(statuses), 0xed4245)) {
          throw new Error('Discord rejected the health alert; will retry next run');
        }
        lastErrorNotifiedAt = new Date().toISOString();
        console.log('Health message sent');
      } catch (e) {
        console.warn('health message fail', e.message);
      }
    } else {
      console.log('Health message suppressed (recently notified)');
    }
  }

  // 6. État
  const counts = { blog: nextBlog.length, help: {} };
  for (const c of HELP_CENTERS) counts.help[c.key] = (nextHelp[c.key] || []).length;
  await writeJsonAtomic(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      blog: nextBlog,
      help: nextHelp,
      helpRetryAt,
      counts,
      lastErrorNotifiedAt,
    },
    2,
  );
  console.log('State written ·', STATE_FILE);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, changeText, applyNotifyResult, parseRssItems, firstImage, metaImage };
