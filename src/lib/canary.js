/**
 * Discord Canary build scraper.
 * Fetches the canary.discord.com/app HTML, parses GLOBAL_ENV metadata
 * (BUILD_NUMBER, VERSION_HASH, etc.), and extracts all JS/CSS asset URLs.
 * Assets are prioritized so web.* bundles are fetched first.
 */
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { DEFAULT_UA, sleep, envNumber } = require('./utils');

const CANARY_APP = 'https://canary.discord.com/app';
const HTML_ATTEMPTS = envNumber('CANARY_HTML_ATTEMPTS', 3, { min: 1, max: 10, int: true });
const HTML_TIMEOUT_MS = envNumber('CANARY_HTML_TIMEOUT_MS', 20000, { min: 1000 });

/**
 * Fetch the Discord Canary web app HTML and extract build metadata + asset URLs.
 *
 * @returns {Promise<{buildNumber:string,versionHash:string|null,releaseChannel:string,apiEndpoint:string|null,webappEndpoint:string|null,assets:string[],cssAssets:string[],globalEnv:object,scrapedAt:string}>}
 * @throws {Error} if BUILD_NUMBER is missing or invalid, or if no JS assets found
 */
async function fetchBuild(opts = {}) {
  const html = await fetchAppHtml(HTML_ATTEMPTS, opts.fetch || fetch);
  console.log('HTML length:', html.length);

  const env = parseGlobalEnv(html);
  const { js, css } = extractAssetUrls(html);
  const assets = prioritizeAssets(js);

  console.log(
    'BUILD_NUMBER:',
    env.BUILD_NUMBER,
    '| js:',
    assets.length,
    '| css:',
    css.length,
    '| web:',
    assets.filter((u) => /\/web\./i.test(u)).length,
  );

  // BUILD_NUMBER is mandatory — never continue as "unknown".
  if (!env.BUILD_NUMBER || !/^\d{4,12}$/.test(String(env.BUILD_NUMBER))) {
    throw new Error(
      'BUILD_NUMBER_MISSING: could not parse a valid Discord Canary BUILD_NUMBER from HTML — abort scrape',
    );
  }
  if (!assets.length) {
    throw new Error('NO_JS_ASSETS: HTML listed zero /assets/ JS files — abort scrape');
  }

  return {
    buildNumber: String(env.BUILD_NUMBER),
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    apiEndpoint: env.API_ENDPOINT || null,
    webappEndpoint: env.WEBAPP_ENDPOINT || null,
    assets,
    cssAssets: css,
    globalEnv: env,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * HTML de l'app avec retries : une erreur réseau / 5xx / page incomplète
 * passagère faisait échouer tout le run (build annoncé 5 min plus tard).
 */
async function fetchAppHtml(attempts = HTML_ATTEMPTS, fetchImpl = fetch) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(CANARY_APP, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache',
        },
        timeout: HTML_TIMEOUT_MS,
      });
      if (res.ok) {
        const html = await res.text();
        if (isCompleteAppHtml(html) || i + 1 >= attempts) return html;
        lastErr = new Error('canary app HTML sans BUILD_NUMBER (' + html.length + ' octets)');
      } else {
        lastErr = new Error('canary app HTTP ' + res.status);
        // 4xx (hors 429) : inutile de marteler, l'erreur est permanente.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) {
          lastErr.retryAfterMs = Math.min(60000, ra * 1000);
        }
      }
    } catch (e) {
      lastErr = e;
    }
    if (i + 1 < attempts) {
      console.warn(`fetchBuild retry ${i + 1}/${attempts - 1}:`, String(lastErr && lastErr.message).slice(0, 160));
      const base = 800 * (i + 1) * (i + 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep((lastErr && lastErr.retryAfterMs) || base + jitter);
    }
  }
  throw lastErr || new Error('canary app fetch failed');
}

/**
 * La page est-elle la vraie app (et non un interstitiel Cloudflare) ?
 *
 * Cloudflare injecte son script de télémétrie `/cdn-cgi/challenge-platform/
 * scripts/jsd/main.js` dans TOUTES les pages servies normalement : le chercher
 * classait chaque réponse valide comme « challenge » → 2 retries inutiles
 * (~4,5 s perdues à CHAQUE run, avant toute détection). On se fie donc au
 * contenu : un BUILD_NUMBER numérique réellement parsable, et aucun marqueur
 * propre à un interstitiel (titre « Just a moment... », _cf_chl_opt, cf-challenge).
 */
function isCompleteAppHtml(html) {
  const s = String(html || '');
  if (!/BUILD_NUMBER/.test(s)) return false;
  if (/cf-challenge|Just a moment\.\.\.|_cf_chl_opt|challenge-error-text/i.test(s)) return false;
  const bn = parseGlobalEnv(s).BUILD_NUMBER;
  return !!bn && /^\d{4,12}$/.test(String(bn));
}

/**
 * Parse Discord's GLOBAL_ENV object from the HTML to extract build metadata.
 * Tries quoted, unquoted, and window.GLOBAL_ENV block patterns.
 * @param {string} html - raw HTML from canary.discord.com/app
 * @returns {object} parsed environment keys
 */
function parseGlobalEnv(html) {
  const out = {};
  const keys = [
    'BUILD_NUMBER',
    'VERSION_HASH',
    'RELEASE_CHANNEL',
    'API_ENDPOINT',
    'WEBAPP_ENDPOINT',
    'CDN_HOST',
    'ASSET_ENDPOINT',
    'MEDIA_PROXY_ENDPOINT',
    'WIDGET_ENDPOINT',
    'INVITE_HOST',
    'GUILD_TEMPLATE_HOST',
    'GIFT_CODE_HOST',
    'MARKETING_ENDPOINT',
    'NETWORKING_ENDPOINT',
    'REMOTE_AUTH_ENDPOINT',
    'SENTRY_TAGS',
  ];
  for (const k of keys) {
    const re = new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"');
    const m = html.match(re);
    if (m) out[k] = m[1];
  }
  // BUILD_NUMBER sometimes unquoted numeric (4–12 digits)
  if (!out.BUILD_NUMBER) {
    const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d{4,12})"?/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  if (!out.BUILD_NUMBER) {
    const m = html.match(/BUILD_NUMBER['"]?\s*[:=]\s*['"]?(\d{4,12})/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  if (!out.BUILD_NUMBER) {
    const m = html.match(/window\.GLOBAL_ENV\s*=\s*\{([\s\S]{0,4000}?)\}/);
    if (m) {
      const block = m[1];
      const bm = block.match(/BUILD_NUMBER['"]?\s*:\s*['"]?(\d{4,12})/);
      if (bm) out.BUILD_NUMBER = bm[1];
    }
  }
  return out;
}

/**
 * Extract all JS and CSS asset URLs from the Discord Canary HTML.
 * Uses both cheerio DOM parsing and regex fallback for robustness.
 * @param {string} html - raw HTML
 * @returns {{js:string[],css:string[]}} arrays of absolute asset URLs
 */
function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const js = new Set();
  const css = new Set();

  const add = (href) => {
    if (!href || typeof href !== 'string') return;
    const raw = href.trim();
    if (!raw.includes('/assets/')) return;
    // ?query et #fragment ne font pas partie du nom de fichier.
    const clean = raw.split('?')[0].split('#')[0];
    let abs;
    if (/^https?:\/\//i.test(clean)) abs = clean;
    // URL protocole-relative (//cdn.discordapp.com/assets/...) : surtout ne
    // pas la préfixer par canary.discord.com (ancien bug → 404 garanti).
    else if (clean.startsWith('//')) abs = 'https:' + clean;
    else abs = 'https://canary.discord.com' + (clean.startsWith('/') ? clean : '/' + clean);
    if (/\.js$/i.test(abs)) js.add(abs);
    if (/\.css$/i.test(abs)) css.add(abs);
  };

  $('script[src]').each((_, el) => add($(el).attr('src')));
  // rel peut contenir plusieurs jetons ("stylesheet preload") et Discord
  // précharge parfois les CSS via <link rel="preload" as="style">.
  $('link[href]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    const as = String($(el).attr('as') || '').toLowerCase();
    if (/(^|\s)stylesheet(\s|$)/.test(rel) || (/(^|\s)preload(\s|$)/.test(rel) && as === 'style')) {
      add($(el).attr('href'));
    }
  });

  // Query/fragment éventuels inclus dans la capture (nettoyés par add()).
  const reSrc = /(?:src|href)=["']([^"']*\/assets\/[^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/gi;
  let m;
  while ((m = reSrc.exec(html))) add(m[1]);

  return { js: [...js], css: [...css] };
}

/**
 * Sort assets by priority: web.* bundles first, then other JS, then sentry.
 * @param {string[]} assets - asset URLs
 * @returns {string[]} sorted assets
 */
function prioritizeAssets(assets) {
  return [...assets].sort((a, b) => score(b) - score(a));
}

/** Priority score for an asset URL (higher = more important). */
function score(url) {
  const u = String(url).toLowerCase();
  if (/\/web\./.test(u)) return 100;
  if (/\/sentry\./.test(u)) return 10;
  return 50;
}

module.exports = {
  isCompleteAppHtml,
  fetchBuild,
  fetchAppHtml,
  extractAssetUrls,
  prioritizeAssets,
  parseGlobalEnv,
  CANARY_APP,
};
