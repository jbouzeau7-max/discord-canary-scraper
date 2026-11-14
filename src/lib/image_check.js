'use strict';
/**
 * Vérifie qu'une URL d'image sera réellement affichable par Discord
 * (2xx + content-type png/jpeg/gif/webp). Évite l'icône « image cassée »
 * dans les media galleries (SVG, 404, XML d'erreur CDN…).
 */
const fetch = require('node-fetch');

const RENDERABLE = /^image\/(png|jpe?g|gif|webp)\b/i;
const BAD_EXT = /\.(svg|svgz|ico|avif|tiff?|bmp)(\?|#|$)/i;

function looksRenderable(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (BAD_EXT.test(u)) return false;
  if (/^data:/i.test(u)) return false;
  return true;
}

const cache = new Map();

async function probe(url, method, timeout) {
  const headers = { 'user-agent': 'Mozilla/5.0 (discord-canary-scraper)' };
  if (method === 'GET') headers.range = 'bytes=0-0';
  const res = await fetch(url, { method, headers, timeout, redirect: 'follow' });
  try {
    if (method === 'GET' && res.body && res.body.destroy) res.body.destroy();
  } catch (_) {}
  return { ok: res.ok || res.status === 206, type: res.headers.get('content-type') || '' };
}

async function isRenderableImage(url, { timeout = 8000 } = {}) {
  if (!looksRenderable(url)) return false;
  if (cache.has(url)) return cache.get(url);
  let ok = false;
  try {
    let r = await probe(url, 'HEAD', timeout);
    if (!r.ok || !r.type) r = await probe(url, 'GET', timeout);
    ok = r.ok && RENDERABLE.test(r.type);
  } catch (_) {
    ok = false;
  }
  cache.set(url, ok);
  return ok;
}

/** Première URL affichable parmi les candidates (ordre conservé), sinon null. */
async function firstRenderableImage(urls, opts) {
  const seen = new Set();
  for (const u of urls || []) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    if (await isRenderableImage(u, opts)) return u;
  }
  return null;
}

module.exports = { isRenderableImage, firstRenderableImage, looksRenderable, _cache: cache };
