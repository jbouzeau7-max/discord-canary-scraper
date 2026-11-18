/**
 * Actus générales → Discord webhook
 *
 * Catégories : monde · réseaux sociaux · football · iPhone & Android · Spotify ·
 *   jeux vidéo · cinéma & séries · F1 · basket/NBA · science & espace · crypto ·
 *   rap · IA · anime & manga · tennis · MMA & boxe · auto
 *   (filtrable : NEWS_CATEGORIES=foot,tech,gaming)
 * Sources : flux RSS publics uniquement — aucune API, aucun token.
 *   monde           : BBC World, Al Jazeera, France 24, Le Monde, Google News FR
 *   réseaux sociaux : TechCrunch Social, Google News FR
 *   football        : BBC Sport, Sky Sports, L'Équipe, RMC Sport, Google News FR
 *   iPhone & Android : iPhon.fr, Frandroid, 9to5Mac, 9to5Google
 *   Spotify         : Spotify Newsroom, Google News FR + EN
 *
 * Consigne du salon : informations importantes, PAS de politique →
 * blocklist anti-politique (globale + spécifique « monde »).
 *
 * Anti-spam : 1 actu = 1 message, mais plafonds par run — total, par
 * catégorie, par source. Tout ce qui n'est pas retenu est marqué vu :
 * pas de rattrapage différé au run suivant.
 *
 * Secret : NEWS_WEBHOOK_URL (soft-exit 0 s'il n'existe pas).
 * État : data/seen_news.json (commité par le workflow).
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { createHash } = require('crypto');
const { sendWebhook, withComponentsUrl } = require('./lib/webhook');
const { IS_COMPONENTS_V2_FLAG, textDisplay, container, mediaGalleryFromUrls, linkButton } = require('./lib/components_v2');
const { writeJsonAtomic } = require('./lib/atomic');
const { fetchTextWithRetry } = require('./lib/http');
const { DEFAULT_UA, trimRecent } = require('./lib/utils');

const WEBHOOK = process.env.NEWS_WEBHOOK_URL || '';

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'seen_news.json');
const MAX_SEEN = 8000; // 17 catégories ≈ 1 700 clés actives par run

// Anti-spam — plafonds par run (le workflow tourne toutes les 10 minutes)
const MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 8);
const MAX_PER_CATEGORY = Number(process.env.NEWS_MAX_PER_CATEGORY || 2);
const MAX_PER_SOURCE = Number(process.env.NEWS_MAX_PER_SOURCE || 2);
const MAX_AGE_HOURS = Number(process.env.NEWS_MAX_AGE_HOURS || 12);
// Fetch parallèle des flux (borné) — un run passe de ~N×latence à ~latence max.
const FETCH_CONCURRENCY = Number(process.env.NEWS_FETCH_CONCURRENCY || 12);
// Seuil de similarité (Jaccard sur mots) pour fusionner la même info vue
// par plusieurs sources dans un même run.
const SIMILAR_THRESHOLD = 0.6;
// Tolérance pour les dates dans le futur (fuseaux mal déclarés)
const FUTURE_SLACK_MS = 2 * 3600 * 1000;

const CATEGORY = {
  monde: { label: 'Monde', color: 0x5865f2, identity: 'newsMonde' },
  social: { label: 'Réseaux sociaux', color: 0xeb459e, identity: 'newsSocial' },
  foot: { label: 'Football', color: 0x57f287, identity: 'newsFoot' },
  tech: { label: 'iPhone & Android', color: 0x3498db, identity: 'newsTech' },
  spotify: { label: 'Spotify', color: 0x1db954, identity: 'newsSpotify' },
  gaming: { label: 'Jeux vidéo', color: 0xa855f7, identity: 'newsGaming' },
  cinema: { label: 'Cinéma & séries', color: 0xef4444, identity: 'newsCinema' },
  f1: { label: 'Formule 1', color: 0xff3c14, identity: 'newsF1' },
  basket: { label: 'Basket & NBA', color: 0xfb923c, identity: 'newsBasket' },
  science: { label: 'Science & espace', color: 0x22d3ee, identity: 'newsScience' },
  crypto: { label: 'Crypto', color: 0xfacc15, identity: 'newsCrypto' },
  rap: { label: 'Rap & musique', color: 0xec4899, identity: 'newsRap' },
  ia: { label: 'Intelligence artificielle', color: 0x6366f1, identity: 'newsIa' },
  anime: { label: 'Anime & manga', color: 0xf472b6, identity: 'newsAnime' },
  tennis: { label: 'Tennis', color: 0xbef264, identity: 'newsTennis' },
  mma: { label: 'MMA & boxe', color: 0xdc2626, identity: 'newsMma' },
  auto: { label: 'Auto', color: 0x94a3b8, identity: 'newsAuto' },
};

// Filtre optionnel : NEWS_CATEGORIES=foot,tech,gaming (vide = toutes)
const ENABLED_CATS = new Set(
  String(process.env.NEWS_CATEGORIES || '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => CATEGORY[c]),
);

const googleNews = (q, lang) =>
  lang === 'fr'
    ? 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=fr&gl=FR&ceid=FR:fr'
    : 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';

const SOURCES = [
  // Monde (hors politique, voir POLITICS_*)
  { id: 'bbc-world', cat: 'monde', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'aljazeera', cat: 'monde', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'france24', cat: 'monde', name: 'France 24', url: 'https://www.france24.com/fr/rss' },
  { id: 'lemonde-intl', cat: 'monde', name: 'Le Monde', url: 'https://www.lemonde.fr/international/rss_full.xml' },
  { id: 'gn-monde-fr', cat: 'monde', name: 'Google News', url: googleNews('actualités internationales', 'fr') },
  // Réseaux sociaux
  { id: 'tc-social', cat: 'social', name: 'TechCrunch', url: 'https://techcrunch.com/category/social/feed/' },
  { id: 'gn-social-fr', cat: 'social', name: 'Google News', url: googleNews('réseaux sociaux OR Instagram OR TikTok OR Snapchat OR WhatsApp', 'fr') },
  // Football
  { id: 'bbc-foot', cat: 'foot', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { id: 'sky-foot', cat: 'foot', name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040' },
  { id: 'lequipe-foot', cat: 'foot', name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Football/' },
  { id: 'rmc-foot', cat: 'foot', name: 'RMC Sport', url: 'https://rmcsport.bfmtv.com/rss/football/' },
  { id: 'gn-foot-fr', cat: 'foot', name: 'Google News', url: googleNews('football', 'fr') },
  // iPhone & Android
  { id: 'iphonfr', cat: 'tech', name: 'iPhon.fr', url: 'https://www.iphon.fr/feed' },
  { id: 'frandroid', cat: 'tech', name: 'Frandroid', url: 'https://www.frandroid.com/feed' },
  { id: '9to5mac', cat: 'tech', name: '9to5Mac', url: 'https://9to5mac.com/feed/' },
  { id: '9to5google', cat: 'tech', name: '9to5Google', url: 'https://9to5google.com/feed/' },
  // Spotify
  { id: 'spotify-newsroom', cat: 'spotify', name: 'Spotify Newsroom', url: 'https://newsroom.spotify.com/feed/' },
  { id: 'gn-spotify-fr', cat: 'spotify', name: 'Google News', url: googleNews('Spotify', 'fr') },
  { id: 'gn-spotify-en', cat: 'spotify', name: 'Google News', url: googleNews('Spotify', 'en') },
  // Jeux vidéo
  { id: 'jvcom', cat: 'gaming', name: 'Jeuxvideo.com', url: 'https://www.jeuxvideo.com/rss/rss.xml' },
  { id: 'gamekult', cat: 'gaming', name: 'Gamekult', url: 'https://www.gamekult.com/feed.xml' },
  { id: 'ign', cat: 'gaming', name: 'IGN', url: 'https://feeds.feedburner.com/ign/news' },
  { id: 'gn-gaming-fr', cat: 'gaming', name: 'Google News', url: googleNews('jeux vidéo', 'fr') },
  // Cinéma & séries
  { id: 'allocine', cat: 'cinema', name: 'AlloCiné', url: 'https://www.allocine.fr/rss/news.xml' },
  { id: 'variety', cat: 'cinema', name: 'Variety', url: 'https://variety.com/feed/' },
  { id: 'gn-cinema-fr', cat: 'cinema', name: 'Google News', url: googleNews('cinéma OR Netflix OR série', 'fr') },
  // Formule 1
  { id: 'motorsport-f1', cat: 'f1', name: 'Motorsport.com', url: 'https://fr.motorsport.com/rss/f1/news/' },
  { id: 'lequipe-f1', cat: 'f1', name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Formule-1/' },
  { id: 'autosport-f1', cat: 'f1', name: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { id: 'bbc-f1', cat: 'f1', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
  // Basket & NBA
  { id: 'basketusa', cat: 'basket', name: 'Basket USA', url: 'https://www.basketusa.com/feed/' },
  { id: 'lequipe-basket', cat: 'basket', name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Basket/' },
  { id: 'gn-nba-fr', cat: 'basket', name: 'Google News', url: googleNews('NBA', 'fr') },
  // Science & espace
  { id: 'numerama-sci', cat: 'science', name: 'Numerama', url: 'https://www.numerama.com/sciences/feed/' },
  { id: 'sciav', cat: 'science', name: 'Sciences et Avenir', url: 'https://www.sciencesetavenir.fr/rss.xml' },
  { id: 'space', cat: 'science', name: 'Space.com', url: 'https://www.space.com/feeds/all' },
  { id: 'nasa', cat: 'science', name: 'NASA', url: 'https://www.nasa.gov/news-release/feed/' },
  // Crypto
  { id: 'cointelegraph', cat: 'crypto', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { id: 'coindesk', cat: 'crypto', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'journalducoin', cat: 'crypto', name: 'Journal du Coin', url: 'https://journalducoin.com/feed/' },
  { id: 'cryptoast', cat: 'crypto', name: 'Cryptoast', url: 'https://cryptoast.fr/feed/' },
  // Rap & musique
  { id: 'gn-rap-fr', cat: 'rap', name: 'Google News', url: googleNews('rap OR rappeur OR album rap', 'fr') },
  { id: 'booska', cat: 'rap', name: 'Booska-P', url: 'https://www.booska-p.com/feed/' },
  { id: 'raplume', cat: 'rap', name: 'Raplume', url: 'https://www.raplume.eu/feed/' },
  { id: 'hiphopdx', cat: 'rap', name: 'HipHopDX', url: 'https://hiphopdx.com/rss/news.xml' },
  // Intelligence artificielle
  { id: 'gn-ia-fr', cat: 'ia', name: 'Google News', url: googleNews('intelligence artificielle OR ChatGPT OR OpenAI', 'fr') },
  { id: 'verge-ai', cat: 'ia', name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { id: 'tc-ai', cat: 'ia', name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  // Anime & manga
  { id: 'adala', cat: 'anime', name: 'Adala News', url: 'https://adala-news.fr/feed/' },
  { id: 'ann', cat: 'anime', name: 'Anime News Network', url: 'https://www.animenewsnetwork.com/news/rss.xml' },
  { id: 'gn-anime-fr', cat: 'anime', name: 'Google News', url: googleNews('anime OR manga', 'fr') },
  // Tennis
  { id: 'lequipe-tennis', cat: 'tennis', name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Tennis/' },
  { id: 'bbc-tennis', cat: 'tennis', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml' },
  { id: 'gn-tennis-fr', cat: 'tennis', name: 'Google News', url: googleNews('tennis', 'fr') },
  // MMA & boxe
  { id: 'gn-mma-fr', cat: 'mma', name: 'Google News', url: googleNews('UFC OR MMA OR boxe', 'fr') },
  { id: 'lequipe-mma', cat: 'mma', name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Mma/' },
  // Auto
  { id: 'gn-auto-fr', cat: 'auto', name: 'Google News', url: googleNews('voiture OR automobile OR Tesla', 'fr') },
];

// — Filtre anti-politique —
// Blocklist globale (toutes catégories). « politique de » est toléré
// (« politique de confidentialité », « politique de prix »...).
const POLITICS_GLOBAL = [
  /\bpolitics\b/i,
  /\bpolitical\b/i,
  /\bpolitique\b(?!\s+de\b)/i,
  /\bpoliticien\w*/i,
  /\b(élection|election|élections|elections)\b/i,
  /\b(référendum|referendum)\b/i,
  /\b(sénat|senate|sénateur|senator|senateur)\b/i,
  /\bcongress(man|woman)?\b/i,
  /\bcongrès\b/i,
  /\b(parlement|parliament|député|depute)\w*/i,
  /\b(législativ\w*|legislativ\w*)/i,
  /\b(ministre|minister|ministry)\b/i,
  /\b(gouvernement|government)\b/i,
  /\bassemblée nationale\b/i,
  /\b(prime minister|premier ministre)\b/i,
];
// Mots strictement politiques mais ambigus ailleurs — « président » d'un club
// de foot reste une actu légitime. Appliqué à « monde » seulement.
const POLITICS_MONDE = [
  /\b(président|president)\b/i,
  /\b(white house|élysée|downing street)\b/i,
  /\b(macron|trump|biden|poutine|putin|scholz|merkel)\b/i,
];

function isPolitical(title, desc, cat) {
  const text = (String(title || '') + ' ' + String(desc || '')).toLowerCase();
  for (const re of POLITICS_GLOBAL) if (re.test(text)) return true;
  if (cat === 'monde') for (const re of POLITICS_MONDE) if (re.test(text)) return true;
  return false;
}

// — Parsing RSS / Atom (items uniquement) —
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(?:(\d+)|[xX]([0-9a-fA-F]+));/g, (_, dec, hex) => {
      const n = dec == null ? parseInt(hex, 16) : Number(dec);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1].trim() : null;
}

function parseRssItems(xml) {
  const out = [];
  const blocks = [...String(xml || '').matchAll(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  for (const block of blocks) {
    const title = stripHtml(decodeXml(pickTag(block, 'title') || ''));
    let link = decodeXml(pickTag(block, 'link') || '');
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = decodeXml(m[1]);
    }
    const dateRaw =
      pickTag(block, 'pubDate') || pickTag(block, 'published') || pickTag(block, 'updated') || null;
    const desc = stripHtml(
      decodeXml(pickTag(block, 'description') || pickTag(block, 'summary') || ''),
    );
    const sourceTag = stripHtml(decodeXml(pickTag(block, 'source') || ''));
    if (!title || !link) continue;
    out.push({ title, link, dateRaw, desc, sourceTag, image: pickImage(block) });
  }
  return out;
}

// — Image de l'article (media:content > media:thumbnail > enclosure > <img>) —
const IMG_EXT_BAD = /\.(svg|svgz|ico|gif)(\?|#|$)/i;
function upgradeImage(u) {
  // BBC : vignettes 240 px → 976 px (même CDN, URL documentée)
  return String(u).replace(/(ichef\.bbci\.co\.uk\/(?:ace\/)?(?:standard|news)\/)\d+\//i, '$1976/');
}
function pickImage(block) {
  const b = String(block || '');
  const cands = [];
  const attr = (re) => {
    for (const m of b.matchAll(re)) {
      const tag = m[0];
      if (/medium=["'](video|audio)["']/i.test(tag) || /type=["'](video|audio)\//i.test(tag)) continue;
      const u = tag.match(/url=["']([^"']+)["']/i);
      const w = Number((tag.match(/width=["'](\d+)["']/i) || [])[1] || 0);
      if (u) cands.push({ url: decodeXml(u[1]), w });
    }
  };
  attr(/<media:content\b[^>]*>/gi);
  attr(/<media:thumbnail\b[^>]*>/gi);
  attr(/<enclosure\b[^>]*>/gi);
  if (!cands.length) {
    const html = decodeXml(pickTag(b, 'content:encoded') || pickTag(b, 'description') || '');
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) cands.push({ url: m[1], w: 0 });
  }
  cands.sort((a, c) => c.w - a.w);
  for (const c of cands) {
    const u = c.url.trim().replace(/^\/\//, 'https://');
    if (!/^https?:\/\//i.test(u) || IMG_EXT_BAD.test(u)) continue;
    return upgradeImage(u);
  }
  return null;
}

// — Dédup : URL normalisée + titre normalisé (croisé entre sources) —
function normalizeUrl(u) {
  let s = String(u || '').trim();
  try {
    const url = new URL(s);
    if (!/^https?:$/.test(url.protocol)) return '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid']) {
      url.searchParams.delete(p);
    }
    s = url.toString();
  } catch { return ''; }
  return s;
}

function normalizeTitle(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function key(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 20);
}

// Préfixes « 🔴 En direct : », « BREAKING: », « Urgent - »...
const BREAKING_RE = /^\s*(?:🔴\s*)?(?:en direct|direct|live|breaking(?: news)?|urgent|alerte|flash)\s*[:\-–|]\s*/i;

/**
 * Description utile ou vide : Google News répète le titre + le site, beaucoup
 * de flux finissent par « Lire la suite », « The post ... appeared first ».
 */
function cleanDesc(desc, title, sourceTag) {
  let d = String(desc || '')
    .replace(/\s*(?:\[(?:…|\.\.\.)\]|lire la suite|read more|continue reading)\W*$/i, '')
    .replace(/\s*The post .* appeared first on .*$/i, '')
    .replace(/\s*L’article .* est apparu en premier sur .*$/i, '')
    .replace(/\s*L'article .* est apparu en premier sur .*$/i, '')
    .trim();
  if (!d) return '';
  const nd = normalizeTitle(d);
  const nt = normalizeTitle(title);
  if (!nd || nd === nt || nt.startsWith(nd) || nd.startsWith(nt)) return '';
  if (sourceTag && nd === normalizeTitle(title + ' ' + sourceTag)) return '';
  if (d.length > 280) {
    const cut = d.slice(0, 280);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    d = end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  return d;
}

function buildItem(raw, src, now) {
  const title = raw.title.trim();
  let finalTitle = title;
  // Google News : « Titre - Site » → on garde le titre
  if (raw.sourceTag && title.toLowerCase().endsWith(' - ' + raw.sourceTag.toLowerCase())) {
    const cut = title.slice(0, title.length - raw.sourceTag.length - 3).trim();
    if (cut) finalTitle = cut;
  }
  const url = normalizeUrl(raw.link);
  const t = Date.parse(raw.dateRaw || '');
  if (!finalTitle || !url || !Number.isFinite(t)) return null;
  if (t - now > FUTURE_SLACK_MS) return null;
  const date = Math.min(t, now);
  if (now - date > MAX_AGE_HOURS * 3600 * 1000) return null;
  let breaking = false;
  const bm = finalTitle.match(BREAKING_RE);
  if (bm) {
    breaking = true;
    finalTitle = finalTitle.slice(bm[0].length).trim() || finalTitle;
  }
  if (/\b(breaking|urgent)\b/i.test(finalTitle)) breaking = true;
  return {
    cat: src.cat,
    sourceId: src.id,
    sourceName: src.name,
    title: finalTitle,
    url,
    desc: cleanDesc(raw.desc, finalTitle, raw.sourceTag),
    image: raw.image || null,
    breaking,
    date,
    keys: [key('u:' + url), key('t:' + normalizeTitle(finalTitle))],
  };
}

// — Même info, sources différentes (Jaccard sur mots significatifs) —
const STOP = new Set('le la les un une des de du d l et en au aux a pour par sur dans avec est sont the of to in on for and is are at by with from as after its it this that new'.split(' '));
function titleTokens(t) {
  return new Set(normalizeTitle(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
}
function similarity(a, b) {
  return tokenSimilarity(titleTokens(a), titleTokens(b));
}
function tokenSimilarity(A, B) {
  if (A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Retire les quasi-doublons (garde le 1er = le plus récent / prioritaire). */
function dedupeSimilar(items, threshold = SIMILAR_THRESHOLD) {
  const kept = [];
  const dropped = [];
  const groups = new Map();
  const tokens = [];
  const byKey = new Map();
  for (const it of items) {
    const words = titleTokens(it.title);
    let owner;
    for (const k of it.keys || []) {
      if (byKey.has(k)) { owner = byKey.get(k); break; }
    }
    if (!owner) owner = kept[tokens.findIndex((other) => tokenSimilarity(other, words) >= threshold)];
    if (!owner) {
      owner = it;
      kept.push(it);
      tokens.push(words);
      groups.set(it, [it]);
    } else {
      dropped.push(it);
      groups.get(owner).push(it);
      if (it.sourceName && it.sourceName !== owner.sourceName) {
        owner.alsoBy ||= [];
        if (!owner.alsoBy.includes(it.sourceName)) owner.alsoBy.push(it.sourceName);
      }
      if (!owner.image && it.image) owner.image = it.image;
    }
    for (const k of it.keys || []) if (!byKey.has(k)) byKey.set(k, owner);
  }
  return { kept, dropped, groups };
}

// — Plafonds anti-spam (items triés du plus récent au plus ancien) —
function pickItems(items, opts = {}) {
  const o = {
    maxPerRun: MAX_PER_RUN,
    maxPerCategory: MAX_PER_CATEGORY,
    maxPerSource: MAX_PER_SOURCE,
    ...opts,
  };
  const perSource = new Map();
  const perCategory = new Map();
  const picked = [];
  for (const it of items) {
    if (picked.length >= o.maxPerRun) break;
    const s = perSource.get(it.sourceId) || 0;
    if (s >= o.maxPerSource) continue;
    const c = perCategory.get(it.cat) || 0;
    if (c >= o.maxPerCategory) continue;
    perSource.set(it.sourceId, s + 1);
    perCategory.set(it.cat, c + 1);
    picked.push(it);
  }
  return picked;
}

async function loadSeen() {
  const set = new Set();
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      for (const k of d.ids || []) set.add(String(k));
    }
  } catch (e) {
    console.warn('loadSeen fail:', e.message);
  }
  return set;
}

async function saveSeen(set) {
  const ids = trimRecent(set, MAX_SEEN);
  await writeJsonAtomic(SEEN_FILE, { updatedAt: new Date().toISOString(), count: ids.length, ids }, 2);
}

async function fetchSource(src, now) {
  try {
    const xml = await fetchTextWithRetry(src.url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml, */*',
      },
      timeout: 15000,
      maxAttempts: 2,
      label: src.id,
    });
    if (!xml) return [];
    const items = parseRssItems(xml)
      .map((raw) => buildItem(raw, src, now))
      .filter(Boolean);
    console.log('source', src.id, items.length);
    return items;
  } catch (e) {
    console.warn('source fail', src.id, String(e.message || e).slice(0, 120));
    return [];
  }
}

function activeSources(sources = SOURCES, enabled = ENABLED_CATS) {
  return enabled.size ? sources.filter((src) => enabled.has(src.cat)) : sources;
}

async function fetchAll(now, sources = activeSources(), fetcher = fetchSource) {
  const results = new Array(sources.length);
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const i = next++;
      results[i] = await fetcher(sources[i], now);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(FETCH_CONCURRENCY, sources.length)) }, worker));
  // ordre des sources préservé → résultat déterministe
  return results.flat();
}

function escapeMd(t) {
  return String(t || '').replace(/([\\*_`~|\[\]])/g, '\\$1');
}

/** Message Components V2 : en-tête, titre cliquable, image, résumé, heure relative, bouton. */
function buildComponents(it) {
  const cat = CATEGORY[it.cat];
  const title = it.title.length > 250 ? it.title.slice(0, 250) + '…' : it.title;
  const unix = Math.floor(it.date / 1000);
  const head = (it.breaking ? '🔴 **URGENT** · ' : '') + '**' + escapeMd(it.sourceName) + '** · ' + cat.label;
  const inner = [textDisplay(head), textDisplay('### [' + escapeMd(title) + '](' + String(it.url).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')')];
  const gallery = it.image ? mediaGalleryFromUrls([it.image]) : null;
  if (gallery) inner.push(gallery);
  if (it.desc) inner.push(textDisplay(escapeMd(it.desc)));
  const more = it.alsoBy && it.alsoBy.length ? ' · aussi : ' + it.alsoBy.slice(0, 3).map(escapeMd).join(', ') : '';
  inner.push(textDisplay('-# Actus · ' + cat.label + ' · <t:' + unix + ':R>' + more));
  return [
    container(inner, it.breaking ? 0xed4245 : cat.color),
    { type: 1, components: [linkButton("Lire l'article", it.url)] },
  ];
}

async function postWebhook(it) {
  const cat = CATEGORY[it.cat];
  const send = (components) =>
    sendWebhook(
      withComponentsUrl(WEBHOOK),
      { flags: IS_COMPONENTS_V2_FLAG, components },
      { identity: cat.identity, label: 'news ' + it.cat, timeoutMs: 15000, minGapMs: 100 },
    );
  let r = await send(buildComponents(it));
  // Image refusée par Discord (400 sur le media) → renvoi sans image
  if (!r.ok && r.status === 400 && it.image) {
    console.warn('news 400 avec image — renvoi sans image');
    r = await send(buildComponents({ ...it, image: null }));
  }
  console.log('webhook', r.status, it.cat, it.title.slice(0, 60));
  return r.ok;
}

async function main() {
  console.log('=== Actus — ' + Object.keys(CATEGORY).join(' · ') + ' ===');
  if (!WEBHOOK) {
    console.warn('NEWS_WEBHOOK_URL manquant — soft skip');
    process.exit(0);
  }
  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  const now = Date.now();
  const all = await fetchAll(now);
  console.log('Items:', all.length, '· vus:', seen.size);
  if (!all.length) {
    console.warn('Aucun item fetché (soft)');
    return { ok: true, fetched: 0, sent: 0 };
  }

  const fresh = all.filter((it) => !it.keys.some((k) => seen.has(k)));
  const isFirstRun = seen.size === 0;
  if (isFirstRun) {
    for (const it of all) for (const k of it.keys) seen.add(k);
    await saveSeen(seen);
    console.log('Seed', seen.size, 'clés — aucun envoi au premier run');
    return { ok: true, seeded: seen.size };
  }
  console.log('Fresh:', fresh.length);

  const clean = fresh.filter((it) => !isPolitical(it.title, it.desc, it.cat));
  // Urgences d'abord, puis du plus récent au plus ancien
  clean.sort((a, b) => (b.breaking ? 1 : 0) - (a.breaking ? 1 : 0) || b.date - a.date);
  const { kept, dropped, groups } = dedupeSimilar(clean);
  if (dropped.length) console.log('Quasi-doublons fusionnés:', dropped.length);
  const picked = pickItems(kept);

  let sentOk = 0;
  let sentFail = 0;
  const retryKeys = new Set();
  for (const it of picked) {
    const ok = await postWebhook(it);
    if (ok) {
      sentOk++;
      for (const k of it.keys) seen.add(k);
    } else {
      sentFail++;
      for (const member of groups.get(it)) for (const k of member.keys) retryKeys.add(k);
      console.warn('NOTIFY_FAIL', it.title.slice(0, 60), '- retry au prochain run');
    }
  }
  // Anti-spam : tout ce qui n'est pas retenu (plafonné ou politique) est
  // marqué vu — pas de rattrapage différé au run suivant.
  const pickedSet = new Set(picked);
  for (const it of clean) {
    if (!pickedSet.has(it)) for (const k of it.keys) if (!retryKeys.has(k)) seen.add(k);
  }
  const cleanSet = new Set(clean);
  for (const it of fresh) {
    if (!cleanSet.has(it)) for (const k of it.keys) if (!retryKeys.has(k)) seen.add(k);
  }
  // Rafraîchit la récence des clés encore présentes dans les flux : elles ne
  // doivent jamais être évincées tant qu'elles peuvent réapparaître.
  for (const it of all) {
    for (const k of it.keys) {
      if (seen.has(k)) {
        seen.delete(k);
        seen.add(k);
      }
    }
  }
  await saveSeen(seen);
  console.log('Done. Fresh', fresh.length, '· envoyés', sentOk, '· échecs', sentFail);
  if (sentFail > 0 && sentOk === 0 && picked.length > 0) process.exitCode = 2;
  return { ok: sentFail === 0, fetched: all.length, fresh: fresh.length, sent: sentOk };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('News error:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  main,
  CATEGORY,
  SOURCES,
  activeSources,
  buildItem,
  buildComponents,
  cleanDesc,
  dedupeSimilar,
  similarity,
  fetchAll,
  pickImage,
  isPolitical,
  pickItems,
  parseRssItems,
  normalizeTitle,
  normalizeUrl,
};
