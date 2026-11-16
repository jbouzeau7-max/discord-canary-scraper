/**
 * Discord Shop / Collectibles tracker
 * Source: public itemshop.gg feed (no Discord account authentication)
 *
 * Message (Components V2, sobre) :
 *   Boutique Discord • NEW item
 *   ### [Nom de l'item](https://discord.com/shop)
 *   [image]
 *   — rien d'autre —
 *
 * Env:
 *   SHOP_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 */
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
const { sleep, redactSecrets, DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');

const DATA = path.join(__dirname, '..', 'data');

// Source publique itemshop.gg — données moins riches (nom + type, pas d'id
// Discord ni d'image), mais le suivi fonctionne sans authentification de compte.
const FALLBACK_URL = 'https://itemshop.gg/discord';
const FALLBACK_STATE = path.join(DATA, 'shop_fallback.json');
const FALLBACK_MIN_ITEMS = 10;
const FALLBACK_TYPES = ['Bundle', 'Avatar Decoration', 'Profile Effect', 'Nameplate', 'Profile Frame', 'Avatar Frame', 'Clan Tag'];

// Webhooks candidats : si le premier a été supprimé (404 Unknown Webhook), on bascule sur le suivant.
const WEBHOOKS = [...new Set([process.env.SHOP_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL].map((u) => String(u || '').trim()).filter(Boolean))];
let WEBHOOK = WEBHOOKS[0] || null;

const SHOP_COLOR = 0x5865f2;
const SHOP_URL = 'https://discord.com/shop';
// Pas de deep-link public par item (SPA) → le titre pointe vers la boutique.
const MAX_NOTIFY_PER_RUN = 20;
const ANNOUNCED_KEEP_DAYS = 90;

function escapeMdTitle(t) {
  return String(t || 'Item')
    .slice(0, 200)
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}
function pickImage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = ['featured_block_url', 'catalog_banner_url', 'hero_banner_url', 'mobile_banner_url', 'logo_url', 'pdp_bg_url', 'thumbnail', 'image', 'asset'];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  if (Array.isArray(obj.items) && obj.items[0] && typeof obj.items[0].asset === 'string') {
    const asset = obj.items[0].asset;
    if (/^https?:\/\//i.test(asset)) return asset;
    return 'https://cdn.discordapp.com/avatar-decoration-presets/' + asset.replace(/^\//, '') + '.png';
  }
  if (obj.sku_id) return 'https://cdn.discordapp.com/media/v1/collectibles-shop/' + obj.sku_id + '/static';
  return null;
}
function pickImageCandidates(obj) {
  const out = [];
  const add = (url) => { if (url && !out.includes(url)) out.push(url); };
  if (!obj || typeof obj !== 'object') return out;
  for (const item of (Array.isArray(obj.items) ? obj.items : [])) {
    const asset = item && typeof item.asset === 'string' ? item.asset.trim() : '';
    if (!asset) continue;
    if (/^https?:\/\//i.test(asset)) add(asset);
    else if (asset.includes('/')) add('https://cdn.discordapp.com/assets/collectibles/' + asset.replace(/^\/+|\/+$/g, '') + '/static.png');
    else add('https://cdn.discordapp.com/avatar-decoration-presets/' + asset + '.png');
  }
  const direct = pickImage({ ...obj, items: undefined, sku_id: undefined });
  if (direct) add(direct);
  if (obj.sku_id) add('https://cdn.discordapp.com/media/v1/collectibles-shop/' + obj.sku_id + '/static');
  return out;
}
function buildItemComponents(item) {
  const components = [
    textDisplay('Boutique Discord • NEW item'),
    textDisplay(`### [${escapeMdTitle(item.name)}](${SHOP_URL})`),
  ];
  const gallery = mediaGalleryFromUrls(item.image && /^https?:\/\//i.test(String(item.image)) ? [item.image] : []);
  if (gallery) components.push(gallery);
  return components;
}

/**
 * « Boutique Discord • NEW item » : titre cliquable + image, rien d'autre.
 */
function buildItemComponents(item) {
  const comps = [
    textDisplay('Boutique Discord • NEW item'),
    textDisplay(`### [${escapeMdTitle(item.name)}](${SHOP_URL})`),
  ];
  const gallery = mediaGalleryFromUrls(
    item.image && /^https?:\/\//i.test(String(item.image)) ? [item.image] : [],
  );
  if (gallery) comps.push(gallery);
  return comps;
}

/** Envoie des composants Components V2 sur la webhook. */
async function postComponents(comps) {
  if (!WEBHOOK) return false;
  const messages = chunkIntoMessages(comps, SHOP_COLOR, true);
  for (const componentsMsg of messages) {
    for (;;) {
      const r = await sendWebhook(
        withComponentsUrl(WEBHOOK),
        {
          username: BOT.slice(0, 80),
          avatar_url: AVATAR,
          flags: IS_COMPONENTS_V2_FLAG,
          components: componentsMsg,
        },
        { identity: 'shop', label: 'shop' },
      );
      if (r.ok) break;
      // Webhook supprimée → webhook suivante (sans perdre le message)
      const idx = WEBHOOKS.indexOf(WEBHOOK);
      if (r.status === 404 && idx >= 0 && idx + 1 < WEBHOOKS.length) {
        console.warn('shop webhook 404 (supprimée) → bascule sur la webhook de secours');
        WEBHOOK = WEBHOOKS[idx + 1];
        continue;
      }
      console.warn('shop webhook fail', r.status, (r.text || '').slice(0, 160));
      return false;
    }
  }
  return true;
}

// ── Mode dégradé : source publique itemshop.gg ────────

/**
 * itemshop.gg publie la boutique du jour ; sa page de boutique est accessible publiquement.
 * Données moins riches (nom + type, pas d'id Discord ni d'image) mais la
 * veille continue — messages marqués « source publique ».
 */
function htmlToLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parse la page itemshop.gg : motif « nom / type / prix » par item.
 * La clé (nom|type) distingue les homonymes multi-types (ex: « Deadpool »
 * déco ET nameplate).
 * @param {string} html - HTML brut de la page publique
 * @returns {Array<{key:string,name:string,type:string,source:string}>}
 */
function parseFallbackShop(html) {
  const lines = htmlToLines(html);
  const junk = /^(advertisement|add the bot|discord alerts|today'?s shop|past rotations|discord shop today)$/i;
  const priceLike = /^\d[\d.,]*\s*(usd|eur)?$/i;
  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const type = lines[i];
    if (!FALLBACK_TYPES.includes(type)) continue;
    const name = lines[i - 1];
    if (!name || FALLBACK_TYPES.includes(name) || junk.test(name)) continue;
    if (name.length < 2 || name.length > 120) continue;
    if (/^https?:\/\//i.test(name) || priceLike.test(name)) continue;
    const key = name + '|' + type;
    if (!out.has(key)) out.set(key, { key, name, type, source: 'itemshop' });
  }
  return [...out.values()];
}

/** Récupère la boutique du jour depuis itemshop.gg (avec garde-fou de parse). */
async function fetchFallbackShop() {
  const res = await fetch(FALLBACK_URL, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,*/*' },
    timeout: 25000,
  });
  if (!res.ok) throw new Error('itemshop.gg HTTP ' + res.status);
  const items = parseFallbackShop(await res.text());
  if (items.length < FALLBACK_MIN_ITEMS) {
    throw new Error('itemshop.gg parse suspect (' + items.length + ' items) — page peut-être changée');
  }
  return items;
}

/** Message sobre (nom + type + lien boutique), sans image : la source n'en fournit pas. */
function buildFallbackComponents(item) {
  return [
    textDisplay('Boutique Discord • NEW item (source publique)'),
    textDisplay('### [' + escapeMdTitle(item.name) + '](' + SHOP_URL + ')'),
    textDisplay('_' + item.type + ' — itemshop.gg_'),
  ];
}

/** Purge les entrées announced de plus de keepDays jours. */
function pruneAnnounced(announced, keepDays) {
  const cutoff = Date.now() - keepDays * 86400000;
  for (const [id, ts] of Object.entries(announced)) {
    if (Date.parse(ts || '') < cutoff) delete announced[id];
  }
}

/**
 * Veille de secours : catalogage itemshop.gg par clé nom|type, état dédié
 * (data/shop_fallback.json), seed silencieux puis notifications des nouveautés.
 */
async function runFallbackMode() {
  let items;
  try {
    items = await fetchFallbackShop();
  } catch (e) {
    console.error('Fallback source failed:', redactSecrets(e.message));
    process.exit(1);
  }
  console.log('Fallback items (itemshop.gg):', items.length);

  let prev = { announced: {} };
  if (await fs.pathExists(FALLBACK_STATE)) {
    try {
      prev = await fs.readJson(FALLBACK_STATE);
    } catch (_) {}
  }
  const announced = Object.assign({}, prev.announced || {});
  const now = new Date().toISOString();
  const isFirst = Object.keys(announced).length === 0;
  if (isFirst) {
    for (const it of items) announced[it.key] = now;
    await writeJsonAtomic(FALLBACK_STATE, { count: items.length, announced }, 2);
    console.log('Fallback seed', items.length, 'items — no notify on first run');
    return;
  }

  const newItems = items.filter((it) => !announced[it.key]);
  console.log('Fallback new items:', newItems.length);
  if (!newItems.length) {
    pruneAnnounced(announced, ANNOUNCED_KEEP_DAYS);
    await writeJsonAtomic(FALLBACK_STATE, { count: items.length, announced }, 2);
    console.log('No new shop items (fallback)');
    return;
  }

  // Même granularité d'échec que le mode officiel : un item non envoyé sera
  // re-notifié au prochain run (clé absente de announced).
  const batch = newItems.slice(0, MAX_NOTIFY_PER_RUN);
  const notified = [];
  const pending = [];
  let failed = 0;
  for (const it of batch) {
    let ok = false;
    try {
      ok = await postComponents(buildFallbackComponents(it));
    } catch (e) {
      console.warn('notify error', redactSecrets(e.message || e));
    }
    if (ok) {
      announced[it.key] = now;
      notified.push(it.key);
      console.log('sent', it.name);
    } else {
      failed++;
      pending.push(it.key);
      console.warn('NOTIFY_FAIL shop fallback', it.key);
    }
    await sleep(300);
  }
  for (const it of newItems.slice(MAX_NOTIFY_PER_RUN)) pending.push(it.key);
  if (newItems.length > MAX_NOTIFY_PER_RUN) {
    console.log('Pending (next run):', newItems.length - MAX_NOTIFY_PER_RUN);
  }
  if (failed > 0) process.exitCode = 2;
  pruneAnnounced(announced, ANNOUNCED_KEEP_DAYS);
  await writeJsonAtomic(
    FALLBACK_STATE,
    { count: items.length, announced, lastNew: notified, pendingNew: pending },
    2,
  );
  console.log('Shop done (fallback) — announced', notified.length, 'failed', failed, 'pending', pending.length);
}

// ── Main ──────────────────────────────────────────────

async function main() {
  await fs.ensureDir(DATA);
  console.log('Discord Shop tracker — source publique itemshop.gg, sans authentification de compte');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.SHOP_WEBHOOK_URL
        ? 'SHOP_WEBHOOK_URL'
        : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );
  await runFallbackMode();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(redactSecrets(e.message || e));
    process.exit(1);
  });
}

module.exports = { main, parseFallbackShop, buildFallbackComponents, pickImageCandidates, buildItemComponents };
