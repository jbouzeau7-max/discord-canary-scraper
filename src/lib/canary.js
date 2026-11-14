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

async function fetchAppHtml(attempts = HTML_ATTEMPTS, fetchImpl = fetch) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(CANARY_APP, {
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/html' },
        timeout: HTML_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (!html || html.length < 500) throw new Error('HTML too short');
      return html;
    } catch (e) {
      lastErr = e;
      console.warn(`fetchAppHtml attempt ${i + 1}/${attempts}:`, e.message);
      if (i < attempts - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr || new Error('fetchAppHtml failed');
}

function parseGlobalEnv(html) {
  const out = {};
  const m = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\});/);
  if (m) {
    try {
      // crude parse — keys are unquoted in some builds
      const raw = m[1]
        .replace(/([{,])\s*([A-Z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      Object.assign(out, JSON.parse(raw));
    } catch (e) {
      console.warn('parseGlobalEnv JSON fail, falling back to regex');
    }
  }
  const bm = html.match(/BUILD_NUMBER["']?\s*[:=]\s*["']?(\d{4,12})/);
  if (bm) out.BUILD_NUMBER = bm[1];
  const vh = html.match(/VERSION_HASH["']?\s*[:=]\s*["']([a-f0-9]{7,40})/i);
  if (vh) out.VERSION_HASH = vh[1];
  return out;
}

function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const js = new Set();
  const css = new Set();

  const add = (href) => {
    if (!href || typeof href !== 'string') return;
    const raw = href.trim();
    if (!raw.includes('/assets/')) return;
    const clean = raw.split('?')[0].split('#')[0];
    let abs;
    if (/^https?:\/\//i.test(clean)) abs = clean;
    else if (clean.startsWith('//')) abs = 'https:' + clean;
    else abs = 'https://canary.discord.com' + (clean.startsWith('/') ? clean : '/' + clean);
    if (/\.js$/i.test(abs)) js.add(abs);
    if (/\.css$/i.test(abs)) css.add(abs);
  };

  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('link[href]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    const as = String($(el).attr('as') || '').toLowerCase();
    if (/(^|\s)stylesheet(\s|$)/.test(rel) || (/(^|\s)preload(\s|$)/.test(rel) && as === 'style')) {
      add($(el).attr('href'));
    }
  });

  const reSrc = /(?:src|href)=["']([^"']*\/assets\/[^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/gi;
  let m;
  while ((m = reSrc.exec(html))) add(m[1]);

  return { js: [...js], css: [...css] };
}

function prioritizeAssets(assets) {
  return [...assets].sort((a, b) => score(b) - score(a));
}

function score(url) {
  const u = String(url).toLowerCase();
  if (/\/web\./.test(u)) return 100;
  if (/\/sentry\./.test(u)) return 10;
  return 50;
}

module.exports = {
  fetchBuild,
  fetchAppHtml,
  extractAssetUrls,
  prioritizeAssets,
  parseGlobalEnv,
  CANARY_APP,
};
