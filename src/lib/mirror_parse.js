'use strict';

/**
 * Parsers partagés pour les sources « mobiles » scrapées :
 *  - APKMirror / Aptoide (pages HTML protégées par Cloudflare)
 *  - page publique TestFlight d'Apple
 *
 * Ces fonctions sont pures (aucun réseau) pour rester testables : les scrapers
 * passent le texte de la page, jamais le HTML complet, et c'est ici que la
 * classification par track (stable / beta / alpha) est décidée.
 */

/** Marqueurs des interstitiels Cloudflare (« Just a moment... », challenge JS). */
const CLOUDFLARE_MARKERS = [
  'just a moment',
  'cf-challenge',
  'cf_chl_opt',
  'attention required',
  'enable javascript and cookies to continue',
];

/** Vrai si le corps reçu est un challenge Cloudflare et non la page demandée. */
function isCloudflareBlocked(body) {
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  return CLOUDFLARE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Paires version/track d'une page miroir.
 * Formats réels observés :
 *   APKMirror : « Version:355.6 - Beta », « [DMCAed NAME] ... 356.0 - Alpha »
 *   Aptoide   : « 347.8 - Beta », « 346.13 - Stable »
 * @returns {{version:string, track:'stable'|'beta'|'alpha', label:string}[]}
 */
function parseVersionTrackPairs(text) {
  const re = /(\d{2,3})\.(\d{1,2})\s*[-–—]\s*(Stable|Beta|Alpha)\b/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const version = `${Number(m[1])}.${Number(m[2])}`;
    const track = m[3].toLowerCase();
    const key = `${version}|${track}`;
    // La page APKMirror répète la version (titre de l'upload + « Version:… »).
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ version, track, label: m[3] });
  }
  return out;
}

/** Comparaison numérique de versions « 354.2 » (pas lexicographique). */
function compareVersions(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Dernière version par track. Ne renvoie jamais une entrée inventée : si aucun
 * miroir ne publie le track demandé, la clé vaut null.
 */
function latestByTrack(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const pick = (track) =>
    list
      .filter((p) => p && p.track === track && p.version)
      .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
  return {
    stable: pick('stable'),
    beta: pick('beta'),
    alpha: pick('alpha'),
    count: list.length,
  };
}

/**
 * Page publique TestFlight (`/join/{code}`) d'Apple.
 * Elle n'expose une version que lorsque la bêta accepte encore des testeurs :
 * quand elle est pleine, le HTML se limite à « This beta is full ».
 * @returns {{status:'open'|'full'|'unknown', version:string|null, available:boolean}}
 */
function parseTestFlightJoinPage(html) {
  const text = String(html || '');
  const lower = text.toLowerCase();
  if (!text) return { status: 'unknown', version: null, available: false };
  if (/beta is full|this beta is full|no longer accepting/i.test(lower)) {
    return { status: 'full', version: null, available: false };
  }
  const patterns = [
    /"appStoreVersion"\s*:\s*"(\d{1,3}\.\d{1,2}(?:\.\d{1,2})?)"/i,
    /"version"\s*:\s*"(\d{1,3}\.\d{1,2}(?:\.\d{1,2})?)"/i,
    /Version\s+(\d{1,3}\.\d{1,2}(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && /^\d{2,3}\./.test(m[1])) {
      return { status: 'open', version: m[1], available: true };
    }
  }
  return { status: 'unknown', version: null, available: false };
}

module.exports = {
  CLOUDFLARE_MARKERS,
  isCloudflareBlocked,
  parseVersionTrackPairs,
  latestByTrack,
  compareVersions,
  parseTestFlightJoinPage,
};
