'use strict';

/** Discord Shop / Collectibles tracker via the documented itemshop.gg API. */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook, withComponentsUrl } = require('./lib/webhook');
const {
  IS_COMPONENTS_V2_FLAG,
  textDisplay,
  mediaGalleryFromUrls,
  chunkIntoMessages,
} = require('./lib/components_v2');
const { writeJsonAtomic } = require('./lib/atomic');
const {
  sleep,
  redactSecrets,
  DEFAULT_BOT_NAME: BOT,
  DEFAULT_AVATAR_URL: AVATAR,
} = require('./lib/utils');

const DATA = path.join(__dirname, '..', 'data');
const SHOP_API_URL = 'https://itemshop.gg/api/v1/shop/discord';
const SHOP_STATE = path.join(DATA, 'shop_itemshop.json');
const SHOP_URL = 'https://discord.com/shop';
const DEFAULT_ATTRIBUTION_URL = 'https://itemshop.gg/discord';
const SHOP_COLOR = 0x5865f2;
const MAX_NOTIFY_PER_RUN = 20;
const ANNOUNCED_KEEP_DAYS = 90;
const API_MAX_BYTES = 8 * 1024 * 1024;
const API_RETRIES = 3;
const API_MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

// Le 1er webhook 404 bascule sur le webhook de secours, sans perdre l'item.
const WEBHOOKS = [...new Set(
  [process.env.SHOP_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL]
    .map((url) => String(url || '').trim())
    .filter(Boolean),
)];
let WEBHOOK = WEBHOOKS[0] || null;

function escapeMdTitle(value) {
  return String(value || 'Item')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200)
    .replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function attributionUrl(value) {
  const safe = httpsUrl(value);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase();
  return host === 'itemshop.gg' || host.endsWith('.itemshop.gg') ? safe : null;
}

function retryAfterMs(value, now = Date.now()) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function discardBody(response) {
  try {
    if (response && response.body && typeof response.body.destroy === 'function') {
      response.body.destroy();
    } else if (response && response.body && typeof response.body.resume === 'function') {
      response.body.resume();
    }
  } catch {}
}

async function readBodyLimited(response, maxBytes) {
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          discardBody(response);
          throw new Error('itemshop.gg API response exceeds size limit');
        }
        chunks.push(buffer);
      }
    } catch (error) {
      discardBody(response);
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('itemshop.gg API response exceeds size limit');
  }
  return text;
}

/** Validate the full API envelope and normalize only purchasable items. */
function normalizeShopPayload(payload) {
  const data = payload && payload.data;
  const meta = payload && payload.meta;
  if (!data || typeof data !== 'object' || data.game !== 'discord') {
    throw new Error('itemshop.gg API: unexpected game or missing data');
  }
  if (data.stale !== false) {
    throw new Error('itemshop.gg API: shop is stale or freshness is unspecified');
  }
  if (!Array.isArray(data.sections) || !Number.isInteger(data.itemCount) || data.itemCount < 0) {
    throw new Error('itemshop.gg API: invalid sections or itemCount');
  }
  const sourceUrl = attributionUrl(meta && meta.attribution && meta.attribution.url);
  if (!sourceUrl) throw new Error('itemshop.gg API: missing or invalid attribution URL');

  const totalItems = data.sections.reduce((total, section) => {
    if (!section || typeof section !== 'object') throw new Error('itemshop.gg API: invalid section');
    if (section.items != null && !Array.isArray(section.items)) {
      throw new Error('itemshop.gg API: invalid section items');
    }
    return total + (section.items || []).length;
  }, 0);
  if (totalItems !== data.itemCount) {
    throw new Error(`itemshop.gg API: itemCount mismatch (${data.itemCount} != ${totalItems})`);
  }

  const items = [];
  const seen = new Set();
  for (const section of data.sections) {
    if (section.upcoming === true) continue;
    for (const item of section.items || []) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('itemshop.gg API: invalid item record');
      }
      if (item.soldOut === true) continue;
      const identity = item.itemKey || item.id || `${item.name}|${item.type || ''}`;
      const key = String(identity).trim();
      if (!key) throw new Error('itemshop.gg API: empty item identity');
      if (seen.has(key)) continue;
      seen.add(key);
      const price = item.price && typeof item.price === 'object' ? item.price : null;
      let priceLabel = price && typeof price.label === 'string' ? price.label : '';
      if (!priceLabel && price && price.amount != null && Number.isFinite(Number(price.amount))) {
        priceLabel = `${price.amount}${price.currency ? ` ${price.currency}` : ''}`;
      }
      const image = item.images && (httpsUrl(item.images.card) || httpsUrl(item.images.render));
      items.push({
        key,
        name: item.name.trim().slice(0, 200),
        type: typeof item.type === 'string' ? item.type.trim().slice(0, 100) : '',
        image,
        priceLabel: String(priceLabel || '').trim().slice(0, 80),
      });
    }
  }

  const shopDate = typeof data.shopDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.shopDate)
    ? data.shopDate
    : null;
  if (!shopDate) throw new Error('itemshop.gg API: invalid shopDate');
  return {
    game: 'discord',
    shopDate,
    itemCount: data.itemCount,
    items,
    attributionUrl: sourceUrl,
    stale: false,
  };
}

async function fetchShopSnapshot({ fetchImpl = fetch, etag = null, sleepImpl = sleep } = {}) {
  const headers = {
    'User-Agent': 'discord-canary-scraper/1.0 (+https://github.com/jbouzeau7-max/discord-canary-scraper)',
    Accept: 'application/json',
  };
  if (etag) headers['If-None-Match'] = etag;

  for (let attempt = 0; attempt < API_RETRIES; attempt++) {
    const response = await fetchImpl(SHOP_API_URL, { headers, timeout: 25000 });
    if (response.status === 304) {
      return { notModified: true, etag: response.headers && response.headers.get('etag') || etag };
    }
    if (response.status === 429 || response.status >= 500) {
      discardBody(response);
      if (attempt + 1 >= API_RETRIES) throw new Error(`itemshop.gg API HTTP ${response.status}`);
      const requested = retryAfterMs(response.headers && response.headers.get('retry-after'));
      if (requested > API_MAX_RETRY_AFTER_MS) {
        throw new Error('itemshop.gg API Retry-After exceeds this run budget; defer to next scheduled run');
      }
      const wait = requested || Math.min(30000, 1000 * (2 ** attempt));
      await sleepImpl(wait);
      continue;
    }
    if (!response.ok) {
      discardBody(response);
      throw new Error(`itemshop.gg API HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > API_MAX_BYTES) {
      discardBody(response);
      throw new Error(`itemshop.gg API response too large (${contentLength} bytes)`);
    }
    const text = await readBodyLimited(response, API_MAX_BYTES);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error('itemshop.gg API returned invalid JSON: ' + error.message);
    }
    const snapshot = normalizeShopPayload(payload);
    return {
      ...snapshot,
      notModified: false,
      etag: response.headers && response.headers.get('etag') || etag,
    };
  }
  throw new Error('itemshop.gg API: retry budget exhausted');
}

function buildItemComponents(item, sourceUrl = DEFAULT_ATTRIBUTION_URL) {
  const components = [
    textDisplay('Boutique Discord • NOUVEL ITEM'),
    textDisplay(`### [${escapeMdTitle(item.name)}](${SHOP_URL})`),
  ];
  const summary = [item.type, item.priceLabel].filter(Boolean).map(escapeMdTitle).join(' · ');
  if (summary) components.push(textDisplay('-# ' + summary));
  if (item.image) {
    const gallery = mediaGalleryFromUrls([item.image]);
    if (gallery) components.push(gallery);
  }
  const source = attributionUrl(sourceUrl) || DEFAULT_ATTRIBUTION_URL;
  components.push(textDisplay(`-# Data from [itemshop.gg](${source})`));
  return components;
}

/** Résout les formes d’asset Discord déjà présentes dans les métadonnées. */
function pickImageCandidates(item) {
  const candidates = [];
  const add = (url) => {
    const safe = httpsUrl(url);
    if (safe && !candidates.includes(safe)) candidates.push(safe);
  };
  if (!item || typeof item !== 'object') return candidates;
  for (const entry of Array.isArray(item.items) ? item.items : []) {
    const asset = entry && typeof entry.asset === 'string' ? entry.asset.trim() : '';
    if (!asset) continue;
    if (/^https:\/\//i.test(asset)) add(asset);
    else if (asset.includes('/')) {
      add('https://cdn.discordapp.com/assets/collectibles/' + asset.replace(/^\/+|\/+$/g, '') + '/static.png');
    } else {
      add('https://cdn.discordapp.com/avatar-decoration-presets/' + asset + '.png');
    }
  }
  if (item.sku_id) add('https://cdn.discordapp.com/media/v1/collectibles-shop/' + item.sku_id + '/static');
  return candidates;
}

async function postComponents(components) {
  if (!WEBHOOK) return false;
  const messages = chunkIntoMessages(components, SHOP_COLOR, true);
  for (const componentsMsg of messages) {
    for (;;) {
      const response = await sendWebhook(
        withComponentsUrl(WEBHOOK),
        {
          username: BOT.slice(0, 80),
          avatar_url: AVATAR,
          flags: IS_COMPONENTS_V2_FLAG,
          components: componentsMsg,
        },
        { identity: 'shop', label: 'shop' },
      );
      if (response.ok) break;
      const index = WEBHOOKS.indexOf(WEBHOOK);
      if (response.status === 404 && index >= 0 && index + 1 < WEBHOOKS.length) {
        console.warn('shop webhook 404 (supprimée) → bascule sur la webhook de secours');
        WEBHOOK = WEBHOOKS[index + 1];
        continue;
      }
      console.warn('shop webhook fail', response.status, (response.text || '').slice(0, 160));
      return false;
    }
  }
  return true;
}

function pruneAnnounced(announced, keepDays, now = Date.now()) {
  const cutoff = now - keepDays * 86400000;
  for (const [id, timestamp] of Object.entries(announced)) {
    const parsed = Date.parse(timestamp || '');
    if (!Number.isFinite(parsed) || parsed < cutoff) delete announced[id];
  }
}

async function loadState(statePath) {
  try {
    const state = await fs.readJson(statePath);
    if (state && typeof state === 'object' && !Array.isArray(state)) return state;
  } catch {}
  return { schemaVersion: 2, initialized: false, announced: {}, etag: null };
}

async function runShopTracker({
  fetchImpl = fetch,
  sleepImpl = sleep,
  statePath = SHOP_STATE,
  notify = postComponents,
  now = () => new Date(),
} = {}) {
  const previous = await loadState(statePath);
  const previousEtag = typeof previous.etag === 'string' ? previous.etag : null;
  const snapshot = await fetchShopSnapshot({ fetchImpl, etag: previousEtag, sleepImpl });
  if (snapshot.notModified) {
    if (previous.initialized !== true) {
      throw new Error('itemshop.gg returned 304 without an initialized local baseline');
    }
    console.log('itemshop.gg shop unchanged (ETag 304)');
    return { ok: true, unchanged: true, notified: 0 };
  }

  const nowValue = now();
  const currentTime = (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString();
  const canReuseBaseline = previous.schemaVersion === 2 && previous.initialized === true &&
    previous.announced && typeof previous.announced === 'object' && !Array.isArray(previous.announced);
  const announced = canReuseBaseline ? { ...previous.announced } : {};
  if (!canReuseBaseline) {
    for (const item of snapshot.items) announced[item.key] = currentTime;
    await writeJsonAtomic(statePath, {
      schemaVersion: 2,
      source: 'itemshop.gg API',
      initialized: true,
      etag: snapshot.etag,
      shopDate: snapshot.shopDate,
      itemCount: snapshot.itemCount,
      announced,
      lastSyncAt: currentTime,
    }, 2);
    console.log('shop API baseline seeded silently', snapshot.items.length, 'items');
    return { ok: true, seeded: true, notified: 0 };
  }

  const fresh = snapshot.items.filter((item) => !announced[item.key]);
  console.log('itemshop.gg current items:', snapshot.items.length, 'new:', fresh.length);
  if (!fresh.length) {
    pruneAnnounced(announced, ANNOUNCED_KEEP_DAYS, Date.parse(currentTime));
    await writeJsonAtomic(statePath, {
      ...previous,
      schemaVersion: 2,
      source: 'itemshop.gg API',
      initialized: true,
      etag: snapshot.etag,
      shopDate: snapshot.shopDate,
      itemCount: snapshot.itemCount,
      announced,
      lastSyncAt: currentTime,
      lastNew: [],
      pendingNew: [],
    }, 2);
    return { ok: true, notified: 0, pending: 0 };
  }

  const batch = fresh.slice(0, MAX_NOTIFY_PER_RUN);
  const notified = [];
  const pending = [];
  let failed = 0;
  for (const item of batch) {
    let sent = false;
    try {
      sent = await notify(buildItemComponents(item, snapshot.attributionUrl));
    } catch (error) {
      console.warn('shop notify error', redactSecrets(error.message || error));
    }
    if (sent) {
      announced[item.key] = currentTime;
      notified.push(item.key);
      console.log('sent shop item', item.name);
    } else {
      failed++;
      pending.push(item.key);
      console.warn('NOTIFY_FAIL shop API', item.key);
    }
    await sleepImpl(300);
  }
  for (const item of fresh.slice(MAX_NOTIFY_PER_RUN)) pending.push(item.key);
  pruneAnnounced(announced, ANNOUNCED_KEEP_DAYS, Date.parse(currentTime));
  await writeJsonAtomic(statePath, {
    ...previous,
    schemaVersion: 2,
    source: 'itemshop.gg API',
    initialized: true,
    etag: snapshot.etag,
    shopDate: snapshot.shopDate,
    itemCount: snapshot.itemCount,
    announced,
    lastSyncAt: currentTime,
    lastNew: notified,
    pendingNew: pending,
  }, 2);
  console.log('Shop API done — announced', notified.length, 'failed', failed, 'pending', pending.length);
  return { ok: failed === 0, notified: notified.length, failed, pending: pending.length };
}

async function main() {
  await fs.ensureDir(DATA);
  console.log('Discord Shop tracker — official itemshop.gg JSON API, no Discord account authentication');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.SHOP_WEBHOOK_URL
        ? 'SHOP_WEBHOOK_URL'
        : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );
  return runShopTracker();
}

if (require.main === module) {
  main()
    .then((result) => {
      if (result && result.ok === false) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(redactSecrets(error.message || error));
      process.exitCode = 1;
    });
}

module.exports = {
  main,
  normalizeShopPayload,
  fetchShopSnapshot,
  buildItemComponents,
  pickImageCandidates,
  retryAfterMs,
  runShopTracker,
  SHOP_API_URL,
};
