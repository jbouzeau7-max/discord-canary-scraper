'use strict';

const ASSET_HOSTS = new Set([
  'canary.discord.com',
  'ptb.discord.com',
  'discord.com',
  'cdn.discordapp.com',
]);

/** Return a canonical URL only for public Discord JS/CSS asset endpoints. */
function normalizeAssetUrl(value, base = 'https://canary.discord.com/app') {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!ASSET_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!url.pathname.startsWith('/assets/') || !/\.(?:js|css)$/i.test(url.pathname)) return null;
  url.search = '';
  url.hash = '';
  return url.href;
}

function isAllowedAssetUrl(value) {
  return normalizeAssetUrl(value) !== null;
}

module.exports = { ASSET_HOSTS, normalizeAssetUrl, isAllowedAssetUrl };
