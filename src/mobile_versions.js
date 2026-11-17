/**
 * Discord Mobile Version Tracker
 *
 * Tracks iOS (stable + beta) and Android (stable + beta + alpha) versions.
 *
 * Sources:
 *  - iOS stable: iTunes App Store lookup API
 *  - iOS beta: Discord OTA manifest (TestFlight track, if ahead of App Store)
 *  - Android stable: APKCombo / Google Play (or OTA if it matches)
 *  - Android beta: Aptoide versions page (lists track labels) / APKMirror
 *  - Android alpha: APKMirror (lists alpha track) / Aptoide
 *
 * The OTA manifest at https://discord.com/{platform}/{version}/manifest.json
 * also serves beta/alpha builds — the build number encodes the track
 * (MMM T NN PPPPPPPPP → T: 0=stable, 1=bêta, 2=alpha, 3=dev), so beta/alpha
 * are decoded directly from Discord's OTA. Aptoide/APKMirror are fallback labels.
 *
 * Build number format (from Discord Userdoccers):
 *   MMM T NN PPPPPPP
 *   346 0 13 00444005
 *   ^   ^   ^  ^
 *   |   |   |  patch/build
 *   |   |   minor version
 *   |   track (0=stable, 1=beta, 2=alpha, 3=dev)
 *   major version
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook, withComponentsUrl } = require('./lib/webhook');
const {
  IS_COMPONENTS_V2_FLAG,
  textDisplay,
  separator,
  linkButton,
  chunkIntoMessages,
} = require('./lib/components_v2');
const { writeJsonAtomic } = require('./lib/atomic');
const { DEFAULT_BOT_NAME: BOT_NAME, DEFAULT_MOBILE_AVATAR: BOT_AVATAR, DEFAULT_UA, trimRecent } = require('./lib/utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');
const EXTERNAL_FILE = path.join(DATA_DIR, 'external_versions.json');
// Webhook UNIQUE pour les versions mobiles : la première var définie gagne.
// MOBILE_WEBHOOK_URL (salon dédié) → DISCORD_WEBHOOK_URL.
const WEBHOOK_CANDIDATES = [
  ['MOBILE_WEBHOOK_URL', process.env.MOBILE_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK_URL = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;

// ── PAUSE ─────────────────────────────────────────────
const PAUSED =
  process.env.MOBILE_VERSIONS_PAUSED === '1' ||
  process.env.MOBILE_VERSIONS_PAUSED === 'true';
// ──────────────────────────────────────────────────────

const IOS_APP_ID = '985746746';
const TESTFLIGHT_URL = 'https://testflight.apple.com/join/gdE4pRzI';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.discord';
const APTOIDE_VERSIONS_URL = 'https://discord.bd.aptoide.com/versions';
const APKMIRROR_UPLOADS_URL = 'https://www.apkmirror.com/uploads/?appcategory=discord-chat-for-gamers';
// Commits publics du datamining Android : leur titre inclut le build MMMTNN,
// qui permet de distinguer les tracks stable, beta et alpha.
const DATAMINE_COMMITS_URL =
  process.env.MOBILE_DATAMINE_COMMITS_URL ||
  'https://api.github.com/repos/Wumpus-Central/discord-mobile-datamining/commits?per_page=100';

// ── Version helpers ───────────────────────────────────

function parseVersion(v) {
  const parts = String(v)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function channelKey(c) {
  return `${c.platform}/${c.channel}`;
}

function versionFingerprint(c) {
  if (!c || !c.version) return null;
  return `${c.platform}|${c.channel}|${c.version}`;
}

// ── HTTP helpers ──────────────────────────────────────

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    timeout: 22000,
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

// ── iOS stable (App Store) ────────────────────────────

async function iosStable() {
  const data = await fetchJson(
    `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=us`,
  );
  const r = data.results?.[0];
  if (!r) throw new Error('iTunes: no result');
  return {
    platform: 'ios',
    channel: 'stable',
    version: r.version,
    build: null,
    size: r.fileSizeBytes ? (Math.round((Number(r.fileSizeBytes) / 1048576) * 10) / 10) + ' MB' : null,
    requires: r.minimumOsVersion ? 'iOS ' + r.minimumOsVersion + '+' : null,
    artwork: r.artworkUrl512 || r.artworkUrl100 || null,
    releaseDate: r.currentVersionReleaseDate || null,
    releaseNotes: (r.releaseNotes || '').slice(0, 400) || null,
    storeUrl: r.trackViewUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`,
    source: 'itunes_lookup',
    available: true,
  };
}

// ── OTA manifest probing ──────────────────────────────

async function probeOta(platform, centerMajor) {
  const found = [];
  const seen = new Set();

  const majors = [];
  for (let m = centerMajor + 5; m >= Math.max(180, centerMajor - 15); m--)
    majors.push(m);

  const minors =
    platform === 'android'
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  let emptyMajors = 0;

  for (const major of majors) {
    let hits = 0;
    const batchSize = 8;

    for (let i = 0; i < minors.length; i += batchSize) {
      const slice = minors.slice(i, i + batchSize);
      const results = await Promise.all(
        slice.map(async (minor) => {
          const version = `${major}.${minor}`;
          try {
            const data = await fetchJson(
              `https://discord.com/${platform}/${version}/manifest.json`,
            );
            const meta = data.metadata || data || {};
            return {
              version,
              build:
                meta.build != null
                  ? String(meta.build)
                  : meta.native_build != null
                    ? String(meta.native_build)
                    : null,
              commit: meta.commit || null,
              releaseName: meta.release_name || null,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r || seen.has(r.version)) continue;
        seen.add(r.version);
        found.push(r);
        hits++;
      }
    }

    if (hits === 0) {
      emptyMajors++;
      if (found.length && emptyMajors >= 4) break;
    } else {
      emptyMajors = 0;
    }
  }

  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

// ── Android stable (stores) ───────────────────────────

async function androidFromStores() {
  const sources = [
    {
      name: 'apkcombo',
      url: 'https://apkcombo.com/discord/com.discord/',
      patterns: [
        /softwareVersion["'\s:>]+(\d+\.\d+(?:\.\d+)?)/i,
        /itemprop=["']version["'][^>]*content=["'](\d+\.\d+(?:\.\d+)?)["']/i,
        /(?:Version|version)[^\d]{0,40}(\d{2,3}\.\d+(?:\.\d+)?)/,
      ],
    },
    {
      name: 'apkpure',
      url: 'https://apkpure.com/discord-talk-chat-hang-out/com.discord',
      patterns: [
        /(\d{2,3}\.\d+\.\d+)\s*<\/span>/,
        /version["'\s:>]+(\d{2,3}\.\d+(?:\.\d+)?)/i,
      ],
    },
    {
      name: 'play_html',
      url: 'https://play.google.com/store/apps/details?id=com.discord&hl=en&gl=US',
      patterns: [
        /\[\[\["(\d+\.\d+\.\d+)"/,
        /Current Version[^\d]{0,80}(\d+\.\d+(?:\.\d+)?)/i,
      ],
    },
  ];

  for (const src of sources) {
    try {
      const html = await fetchText(src.url);
      for (const re of src.patterns) {
        const m = html.match(re);
        if (m && /^\d{2,3}\./.test(m[1])) {
          return {
            platform: 'android',
            channel: 'stable',
            version: m[1],
            build: null,
            source: src.name,
            storeUrl: PLAY_STORE_URL,
            available: true,
          };
        }
      }
    } catch (e) {
      console.warn(src.name, e.message);
    }
  }
  return null;
}

// ── Android beta/alpha from external data file ───────

/**
 * Load the last known beta/alpha versions from data/external_versions.json.
 * This file is a fallback for when Aptoide/APKMirror are behind Cloudflare.
 * It can be updated manually or automatically when the scraping succeeds.
 */
async function loadExternalVersions() {
  try {
    if (await fs.pathExists(EXTERNAL_FILE)) {
      const data = await fs.readJson(EXTERNAL_FILE);
      return data;
    }
  } catch (e) {
    console.warn('loadExternalVersions:', e.message);
  }
  return null;
}

/**
 * Save the external versions data to data/external_versions.json.
 * Called when Aptoide/APKMirror scraping succeeds.
 */
async function saveExternalVersions(data) {
  try {
    await writeJsonAtomic(EXTERNAL_FILE, data, 2);
    console.log('Saved external versions to', EXTERNAL_FILE);
  } catch (e) {
    console.warn('saveExternalVersions:', e.message);
  }
}

/** Fusionne une réponse partielle sans effacer beta/alpha absentes. */
function mergeExternalVersionData(previous, update) {
  const oldData = previous && typeof previous === 'object' ? previous : {};
  const nextData = update && typeof update === 'object' ? update : {};
  const oldAndroid = oldData.android && typeof oldData.android === 'object' ? oldData.android : {};
  const nextAndroid = nextData.android && typeof nextData.android === 'object' ? nextData.android : {};
  const oldIos = oldData.ios && typeof oldData.ios === 'object' ? oldData.ios : {};
  const nextIos = nextData.ios && typeof nextData.ios === 'object' ? nextData.ios : {};
  const keepTrack = (key) =>
    nextAndroid[key]?.version ? nextAndroid[key] : oldAndroid[key] || null;
  return {
    ...oldData,
    ...nextData,
    sources: { ...(oldData.sources || {}), ...(nextData.sources || {}) },
    android: {
      ...oldAndroid,
      ...nextAndroid,
      beta: keepTrack('beta'),
      alpha: keepTrack('alpha'),
    },
    ios: {
      ...oldIos,
      ...nextIos,
      beta: preferNewerTrackVersion(oldIos.beta, nextIos.beta),
    },
  };
}

// ── Android beta/alpha from Aptoide ───────────────────

/**
 * Scrape Aptoide versions page for Discord Android versions with track labels.
 * Aptoide lists versions like "347.8 - Beta — 22/9/2026" and "346.13 - Stable — 22/9/2026".
 * This is the most reliable source for Android beta versions.
 *
 * Returns: { beta: {version, date}, alpha: {version, date} } or null
 */
async function androidFromAptoide() {
  // Try multiple Aptoide locales — the data is the same but some might not be behind Cloudflare
  const locales = ['bd', 'ru', 'fr', 'en', 'vn', 'cn', 'pl'];
  for (const locale of locales) {
    const url = `https://discord.${locale}.aptoide.com/versions`;
    try {
      const html = await fetchText(url, {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      // Skip Cloudflare challenge pages
      if (html.includes('Just a moment') || html.includes('cf-challenge') || html.length < 7000) {
        console.warn(`Aptoide ${locale}: Cloudflare challenge, skipping`);
        continue;
      }

      // Parse version-track pairs from the page
      // Format in HTML: "347.8 - Beta" or "346.13 - Stable"
      const versionTrackRe = /(\d{2,3}\.\d+)\s*[-–]\s*(Stable|Beta|Alpha)/gi;
      const matches = [...html.matchAll(versionTrackRe)];

      if (!matches.length) {
        console.warn(`Aptoide ${locale}: no version-track pairs found (${html.length} bytes)`);
        continue;
      }

      const versions = matches.map((m) => ({
        version: m[1],
        track: m[2].toLowerCase(),
      }));

      // Find the latest beta and alpha
      const betas = versions.filter((v) => v.track === 'beta')
        .sort((a, b) => cmpVersion(b.version, a.version));
      const alphas = versions.filter((v) => v.track === 'alpha')
        .sort((a, b) => cmpVersion(b.version, a.version));
      const stables = versions.filter((v) => v.track === 'stable')
        .sort((a, b) => cmpVersion(b.version, a.version));

      console.log(`Aptoide ${locale}: found ${versions.length} versions (${betas.length} beta, ${alphas.length} alpha, ${stables.length} stable)`);

      return {
        beta: betas[0] || null,
        alpha: alphas[0] || null,
        stable: stables[0] || null,
        all: versions,
        source: 'aptoide',
      };
    } catch (e) {
      console.warn(`Aptoide ${locale}:`, e.message);
    }
  }
  return null;
}

// ── Android beta/alpha from APKMirror ─────────────────

/**
 * Scrape APKMirror for Discord Android versions with track labels.
 * APKMirror lists versions like "Version:290.16 - Beta" and "Version:291.4 - Alpha".
 * Returns: { beta: {version}, alpha: {version} } or null
 */
async function androidFromApkMirror() {
  try {
    const html = await fetchText(APKMIRROR_UPLOADS_URL, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html',
      },
    });

    if (html.includes('Just a moment') || html.includes('cf-challenge') || html.length < 5000) {
      console.warn('APKMirror: Cloudflare challenge, skipping');
      return null;
    }

    // Parse version-track pairs
    const versionTrackRe = /(\d{2,3}\.\d+)\s*[-–]\s*(Stable|Beta|Alpha)/gi;
    const matches = [...html.matchAll(versionTrackRe)];

    if (!matches.length) {
      console.warn('APKMirror: no version-track pairs found');
      return null;
    }

    const versions = matches.map((m) => ({
      version: m[1],
      track: m[2].toLowerCase(),
    }));

    const betas = versions.filter((v) => v.track === 'beta')
      .sort((a, b) => cmpVersion(b.version, a.version));
    const alphas = versions.filter((v) => v.track === 'alpha')
      .sort((a, b) => cmpVersion(b.version, a.version));

    console.log(`APKMirror: found ${versions.length} versions (${betas.length} beta, ${alphas.length} alpha)`);

    return {
      beta: betas[0] || null,
      alpha: alphas[0] || null,
      source: 'apkmirror',
    };
  } catch (e) {
    console.warn('APKMirror:', e.message);
    return null;
  }
}

// ── Android beta/alpha from Discord min version API ──

/**
 * Discord's minimum version API at https://dl.discordapp.net/apps/android/versions.json
 * Returns the minimum supported version, which can hint at the current stable track.
 */
async function discordMinVersion() {
  try {
    const data = await fetchJson('https://dl.discordapp.net/apps/android/versions.json');
    return data?.discord_android_min_version || null;
  } catch (e) {
    console.warn('Discord min version:', e.message);
    return null;
  }
}

/** Parse les commits Android sans faire confiance aux titres malformés. */
function parseAndroidDataminingCommits(commits) {
  if (!Array.isArray(commits)) return null;
  const found = [];
  const re = /^(\d{3})\.(\d{1,2})\s+\((\d{3})(\d)(\d{2})\b/;
  for (const item of commits) {
    const message = String(item?.commit?.message || '').trim();
    const match = message.match(re);
    if (!match) continue;
    const [, major, minor, buildMajor, trackText, buildMinor] = match;
    if (major !== buildMajor || Number(minor) !== Number(buildMinor)) continue;
    const track = Number(trackText);
    if (track !== 1 && track !== 2) continue;
    const version = `${Number(major)}.${Number(minor)}`;
    const rawDate = item?.commit?.author?.date;
    const date = rawDate && Number.isFinite(Date.parse(rawDate)) ? rawDate : null;
    found.push({ version, track, date, source: 'datamining_commits' });
  }

  const latest = (track) =>
    found
      .filter((entry) => entry.track === track)
      .sort((a, b) => cmpVersion(b.version, a.version) || (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0))[0] || null;
  const beta = latest(1);
  const alpha = latest(2);
  // Toutes les versions vues par track : permet de signaler les versions
  // intermédiaires sorties entre deux runs (sinon seule la dernière apparaît).
  const all = (track) => [...new Set(found.filter((e) => e.track === track).map((e) => e.version))]
    .sort((a, b) => cmpVersion(b, a));
  return beta || alpha
    ? { beta, alpha, versions: { beta: all(1), alpha: all(2) }, source: 'datamining_commits' }
    : null;
}

/** Source Android sans Cloudflare ; un échec ne bloque pas les autres sources. */
async function androidFromDataminingRepo(fetchJsonImpl = fetchJson, url = DATAMINE_COMMITS_URL) {
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const result = parseAndroidDataminingCommits(await fetchJsonImpl(url, { headers }));
    if (!result) console.warn('Android datamining commits: no valid beta/alpha versions');
    return result;
  } catch (error) {
    console.warn('Android datamining commits:', error.message);
    return null;
  }
}

/** Choisit la version la plus récente sans faire régresser une autre source. */
function preferNewerTrackVersion(current, candidate) {
  if (!candidate?.version) return current || null;
  if (!current?.version || cmpVersion(candidate.version, current.version) > 0) return candidate;
  return current;
}

// ── Channel classification ────────────────────────────

/**
 * Classify channels for a platform using all available sources.
 *
 * For iOS:
 *  - stable = App Store version
 *  - beta = OTA version ahead of stable (TestFlight)
 *
 * For Android:
 *  - stable = store version (or OTA if it matches)
 *  - beta = from Aptoide/APKMirror (track-labeled versions)
 *  - alpha = from APKMirror/Aptoide (track-labeled versions)
 *  - Fallback: OTA versions ahead of stable
 */
function selectIosBetaFallback(storeVersion, otaVersions, fallbackBeta) {
  if (!storeVersion || !fallbackBeta?.version) return null;
  const hasOtaAhead = (Array.isArray(otaVersions) ? otaVersions : []).some(
    (version) => version?.version && cmpVersion(version.version, storeVersion) > 0,
  );
  if (hasOtaAhead || cmpVersion(fallbackBeta.version, storeVersion) <= 0) return null;
  return fallbackBeta;
}

function classifyIosChannels(storeVersion, iosStoreData, otaVersions, fallbackBeta = null) {
  const channels = [];
  const ota = Array.isArray(otaVersions) ? otaVersions : [];

  // iOS stable
  channels.push({
    platform: 'ios',
    channel: 'stable',
    version: storeVersion,
    build: null,
    size: iosStoreData?.size || null,
    requires: iosStoreData?.requires || null,
    artwork: iosStoreData?.artwork || null,
    releaseDate: iosStoreData?.releaseDate || null,
    releaseNotes: iosStoreData?.releaseNotes || null,
    source: 'itunes_lookup',
    storeUrl: `https://apps.apple.com/app/id${IOS_APP_ID}`,
    available: !!storeVersion,
  });

  // iOS beta (TestFlight) — OTA version ahead of App Store
  if (storeVersion) {
    const ahead = ota.filter((v) => v?.version && cmpVersion(v.version, storeVersion) > 0);
    if (ahead.length > 0) {
      const beta = ahead[0]; // highest OTA version ahead of stable
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: beta.version,
        build: beta.build,
        commit: beta.commit,
        releaseName: beta.releaseName,
        artwork: iosStoreData?.artwork || null,
        source: 'discord_ota_manifest',
        storeUrl: TESTFLIGHT_URL,
        available: true,
        note: 'OTA ahead of App Store (TestFlight)',
      });
    } else if (selectIosBetaFallback(storeVersion, ota, fallbackBeta)) {
      const beta = fallbackBeta;
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: beta.version,
        build: beta.build || null,
        commit: beta.commit || null,
        releaseName: beta.releaseName || null,
        artwork: iosStoreData?.artwork || null,
        source: beta.source || 'testflight_fallback',
        storeUrl: TESTFLIGHT_URL,
        available: true,
        note: 'Saved TestFlight version ahead of App Store (fallback)',
      });
    } else {
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: null,
        available: false,
        note: 'OTA not ahead of App Store',
        storeUrl: TESTFLIGHT_URL,
      });
    }
  } else {
    channels.push({
      platform: 'ios',
      channel: 'beta',
      version: null,
      available: false,
      note: 'No App Store version available',
      storeUrl: TESTFLIGHT_URL,
    });
  }

  return channels;
}

function classifyAndroidChannels(storeVersion, otaVersions, externalBeta, externalAlpha) {
  const channels = [];
  const otaLatest = otaVersions[0] || null;

  // Android stable — prefer store version, fall back to OTA
  let stableVersion = storeVersion;
  let stableBuild = null;
  let stableCommit = null;
  let stableReleaseName = null;
  let stableSource = 'store';

  if (otaLatest && storeVersion && cmpVersion(otaLatest.version, storeVersion) === 0) {
    // OTA latest matches store → use OTA metadata (has build/commit)
    stableBuild = otaLatest.build;
    stableCommit = otaLatest.commit;
    stableReleaseName = otaLatest.releaseName;
    stableSource = 'discord_ota_manifest';
  }

  if (!stableVersion && otaLatest) {
    stableVersion = otaLatest.version;
    stableBuild = otaLatest.build;
    stableCommit = otaLatest.commit;
    stableReleaseName = otaLatest.releaseName;
    stableSource = 'discord_ota_manifest';
  }

  if (stableVersion) {
    channels.push({
      platform: 'android',
      channel: 'stable',
      version: stableVersion,
      build: stableBuild,
      commit: stableCommit,
      releaseName: stableReleaseName,
      source: stableSource,
      storeUrl: PLAY_STORE_URL,
      available: true,
    });
  } else {
    channels.push({
      platform: 'android',
      channel: 'stable',
      version: null,
      available: false,
      note: 'No public Android version source',
      storeUrl: PLAY_STORE_URL,
    });
  }

  // Versions OTA en avance sur la stable
  const ahead = stableVersion
    ? otaVersions.filter((v) => cmpVersion(v.version, stableVersion) > 0)
    : [];

  // Track EXACT décodé du build number : MMM T NN PPPPPPP → T
  // (0 = stable, 1 = bêta, 2 = alpha, 3 = dev). On lit le manifeste OTA de
  // Discord directement — plus fiable que les miroirs (Aptoide/APKMirror).
  const otaByTrack = (track) =>
    ahead.find((v) => (decodeAndroidBuild(v.build) || {}).track === track) || null;
  const otaBeta = otaByTrack(1);
  const otaAlpha = otaByTrack(2);

  const otaEntry = (v, note, channel) => ({
    platform: 'android',
    channel,
    version: v.version,
    build: v.build,
    commit: v.commit,
    releaseName: v.releaseName,
    source: 'discord_ota_manifest',
    storeUrl: PLAY_STORE_URL,
    available: true,
    note,
  });

  // Android bêta — track décodé (OTA) > label miroir (Aptoide/APKMirror) > inférence
  if (otaBeta) {
    channels.push(otaEntry(otaBeta, 'Track bêta décodé du build number', 'beta'));
  } else if (externalBeta && externalBeta.version) {
    const otaMatch = otaVersions.find((v) => v.version === externalBeta.version);
    channels.push({
      platform: 'android',
      channel: 'beta',
      version: externalBeta.version,
      build: otaMatch?.build || null,
      commit: otaMatch?.commit || null,
      releaseName: otaMatch?.releaseName || null,
      source: externalBeta.source || 'aptoide',
      storeUrl: PLAY_STORE_URL,
      available: true,
      note: externalBeta.date ? `Track-labeled on ${externalBeta.source}` : 'Track-labeled version',
    });
  } else if (ahead.length >= 2) {
    // 2+ versions en avance sans track décodé → la 2e est probablement la bêta
    channels.push(otaEntry(ahead[1], 'OTA en avance sur la stable (bêta inférée)', 'beta'));
  } else {
    channels.push({
      platform: 'android',
      channel: 'beta',
      version: null,
      available: false,
      note: ahead.length
        ? 'Une seule version OTA en avance — track indéterminé'
        : 'No OTA version ahead of stable',
      storeUrl: PLAY_STORE_URL,
    });
  }

  // Android alpha — track décodé (OTA) > label miroir > plus haute OTA en avance
  if (otaAlpha) {
    channels.push(otaEntry(otaAlpha, 'Track alpha décodé du build number', 'alpha'));
  } else if (externalAlpha && externalAlpha.version) {
    const otaMatch = otaVersions.find((v) => v.version === externalAlpha.version);
    channels.push({
      platform: 'android',
      channel: 'alpha',
      version: externalAlpha.version,
      build: otaMatch?.build || null,
      commit: otaMatch?.commit || null,
      releaseName: otaMatch?.releaseName || null,
      source: externalAlpha.source || 'apkmirror',
      storeUrl: PLAY_STORE_URL,
      available: true,
      note: externalAlpha.date ? `Track-labeled on ${externalAlpha.source}` : 'Track-labeled version',
    });
  } else {
    const selectedBetaVersion =
      channels.find((channel) => channel.channel === 'beta' && channel.version)?.version || null;
    const alphaCand = ahead.find((v) => v.version !== selectedBetaVersion);
    if (alphaCand) {
      channels.push(otaEntry(alphaCand, 'OTA en avance sur la stable (alpha inférée)', 'alpha'));
    } else {
      channels.push({
        platform: 'android',
        channel: 'alpha',
        version: null,
        available: false,
        note: 'No alpha version found (OTA + mirrors)',
        storeUrl: PLAY_STORE_URL,
      });
    }
  }

  return channels;
}

// ── Main collection ───────────────────────────────────

async function collectAll() {
  const checkedAt = new Date().toISOString();
  const channels = [];
  const otaIndex = { ios: [], android: [] };
  const sources = {};

  // 1. iOS stable from App Store
  let iosStoreVersion = null;
  let iosStoreData = null;
  try {
    iosStoreData = await iosStable();
    iosStoreVersion = iosStoreData.version;
    console.log('iOS stable', iosStoreVersion);
  } catch (e) {
    console.warn('iOS stable fail', e.message);
  }

  // Center the OTA search around the iOS stable major (or a fallback)
  const centerMajor = iosStoreVersion ? parseVersion(iosStoreVersion)[0] : 346;

  // Les sources restantes sont indépendantes les unes des autres : elles sont
  // lancées ENSEMBLE puis consommées dans l'ordre d'origine (mêmes logs, même
  // logique de repli). Avant : 7 étapes réseau en série, la plus lente
  // retardait toutes les suivantes et donc la notification.
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
  const take = async (task) => {
    const r = await task;
    if (r.error) throw r.error;
    return r.value;
  };
  const iosOtaTask = settle(probeOta('ios', centerMajor));
  const androidOtaTask = settle(probeOta('android', centerMajor));
  const androidStoreTask = settle(androidFromStores());
  const aptoideTask = settle(androidFromAptoide());
  const datamineTask = settle(androidFromDataminingRepo());
  const minVersionTask = settle(discordMinVersion());

  // 2. iOS OTA probe
  let iosOta = [];
  try {
    iosOta = await take(iosOtaTask);
    otaIndex.ios = iosOta.slice(0, 30);
    console.log('iOS OTA versions found:', iosOta.length);
    if (iosOta[0]) console.log('iOS OTA latest', iosOta[0].version, iosOta[0].build);
  } catch (e) {
    console.warn('iOS OTA fail', e.message);
  }

  // 3. Android OTA probe
  let androidOta = [];
  try {
    androidOta = await take(androidOtaTask);
    otaIndex.android = androidOta.slice(0, 40);
    console.log('Android OTA versions found:', androidOta.length);
    if (androidOta[0]) console.log('Android OTA latest', androidOta[0].version, androidOta[0].build);
  } catch (e) {
    console.warn('Android OTA fail', e.message);
  }

  // 4. Android store version
  let androidStoreVersion = null;
  try {
    const androidStore = await take(androidStoreTask);
    if (androidStore) {
      androidStoreVersion = androidStore.version;
      console.log('Android store', androidStoreVersion, androidStore.source);
    }
  } catch (e) {
    console.warn('Android store fail', e.message);
  }

  // 5. Android beta/alpha from Aptoide
  let externalBeta = null;
  let externalAlpha = null;
  let savedExternalData = await loadExternalVersions();
  const aptoideData = await take(aptoideTask).catch(() => null);
  if (aptoideData) {
    sources.aptoide = true;
    if (aptoideData.beta) {
      externalBeta = { version: aptoideData.beta.version, source: 'aptoide', date: aptoideData.beta.date };
      console.log('Android beta (Aptoide)', aptoideData.beta.version);
    }
    if (aptoideData.alpha) {
      externalAlpha = { version: aptoideData.alpha.version, source: 'aptoide', date: aptoideData.alpha.date };
      console.log('Android alpha (Aptoide)', aptoideData.alpha.version);
    }
    // Une page peut être accessible mais ne contenir qu'un seul track. Garder
    // la valeur sauvegardée pour tout track omis, sans régression de version.
    externalBeta = preferNewerTrackVersion(savedExternalData?.android?.beta, externalBeta);
    externalAlpha = preferNewerTrackVersion(savedExternalData?.android?.alpha, externalAlpha);
    // Save to external versions file for future fallback, sans effacer un track.
    savedExternalData = mergeExternalVersionData(savedExternalData, {
      updatedAt: checkedAt,
      sources: { aptoide: { url: APTOIDE_VERSIONS_URL, lastAccessible: true } },
      android: {
        beta: externalBeta ? { ...externalBeta, track: 'beta' } : null,
        alpha: externalAlpha ? { ...externalAlpha, track: 'alpha' } : null,
      },
    });
    await saveExternalVersions(savedExternalData);
  } else {
    // Aptoide blocked by Cloudflare — load from fallback file
    const externalData = savedExternalData;
    if (externalData) {
      sources.externalFallback = true;
      sources.externalFallbackDate = externalData.updatedAt;
      if (externalData.android?.beta) {
        externalBeta = { version: externalData.android.beta.version, source: externalData.android.beta.source || 'aptoide', date: externalData.android.beta.date };
        console.log('Android beta (fallback)', externalBeta.version, 'from', externalData.updatedAt);
      }
      if (externalData.android?.alpha) {
        externalAlpha = { version: externalData.android.alpha.version, source: externalData.android.alpha.source || 'apkmirror', date: externalData.android.alpha.date };
        console.log('Android alpha (fallback)', externalAlpha.version, 'from', externalData.updatedAt);
      }
    }
  }

  // 5bis. Source Android beta/alpha indépendante des stores qui bloquent souvent
  // les scrapers. La sélection par version évite de régresser si un miroir
  // annonce une version plus récente.
  const datamineData = await take(datamineTask).catch(() => null);
  if (datamineData) {
    sources.dataminingCommits = true;
    if (datamineData.versions) sources.androidTrackVersions = datamineData.versions;
    externalBeta = preferNewerTrackVersion(externalBeta, datamineData.beta);
    externalAlpha = preferNewerTrackVersion(externalAlpha, datamineData.alpha);
    console.log(
      'Android beta/alpha (datamining commits)',
      externalBeta?.version || 'n/a',
      externalAlpha?.version || 'n/a',
    );

    // Préserver les autres champs/sources du fichier de repli, tout en gardant
    // les dernières versions confirmées si l'API GitHub devient inaccessible.
    const oldExternal = savedExternalData || {};
    savedExternalData = mergeExternalVersionData(oldExternal, {
      updatedAt: checkedAt,
      sources: {
        ...(oldExternal.sources || {}),
        dataminingCommits: { url: DATAMINE_COMMITS_URL, lastAccessible: true },
      },
      android: {
        ...(oldExternal.android || {}),
        beta: externalBeta
          ? { ...externalBeta, track: 'beta' }
          : oldExternal.android?.beta || null,
        alpha: externalAlpha
          ? { ...externalAlpha, track: 'alpha' }
          : oldExternal.android?.alpha || null,
      },
    });
    await saveExternalVersions(savedExternalData);
  }

  // 6. Android beta/alpha from APKMirror (fallback)
  if (!externalBeta || !externalAlpha) {
    const apkMirrorData = await androidFromApkMirror();
    if (apkMirrorData) {
      sources.apkmirror = true;
      if (!externalBeta && apkMirrorData.beta) {
        externalBeta = { version: apkMirrorData.beta.version, source: 'apkmirror' };
        console.log('Android beta (APKMirror)', apkMirrorData.beta.version);
      }
      if (!externalAlpha && apkMirrorData.alpha) {
        externalAlpha = { version: apkMirrorData.alpha.version, source: 'apkmirror' };
        console.log('Android alpha (APKMirror)', apkMirrorData.alpha.version);
      }
    }
  }

  // 7. Discord min version (informational)
  const minVersion = await take(minVersionTask).catch(() => null);
  if (minVersion) {
    console.log('Discord Android min version:', minVersion);
    sources.discordMinVersion = minVersion;
  }

  // Repli TestFlight : le fichier était lu auparavant mais sa valeur n'était
  // jamais passée au classificateur. Ne le montrer que s'il reste en avance
  // sur l'App Store et qu'aucune OTA actuelle n'est plus récente.
  const iosBetaFallback = selectIosBetaFallback(
    iosStoreVersion,
    iosOta,
    savedExternalData?.ios?.beta,
  );
  if (iosBetaFallback) {
    sources.iosBetaFallback = iosBetaFallback;
    console.log('iOS beta (fallback)', iosBetaFallback.version, 'from', savedExternalData?.updatedAt || 'saved state');
  }

  // 8. Classify iOS channels (stable + beta)
  const iosClassified = classifyIosChannels(iosStoreVersion, iosStoreData, iosOta, iosBetaFallback);
  const currentIosBeta = iosClassified.find((channel) => channel.channel === 'beta' && channel.version);
  if (currentIosBeta) {
    savedExternalData = mergeExternalVersionData(savedExternalData, {
      updatedAt: checkedAt,
      sources: { iosOta: { lastAccessible: true } },
      ios: {
        beta: {
          version: currentIosBeta.version,
          build: currentIosBeta.build || null,
          commit: currentIosBeta.commit || null,
          releaseName: currentIosBeta.releaseName || null,
          source: currentIosBeta.source || 'discord_ota_manifest',
          checkedAt,
        },
      },
    });
    await saveExternalVersions(savedExternalData);
  }
  for (const c of iosClassified) {
    channels.push({ ...c, checkedAt });
  }

  // 9. Classify Android channels (stable + beta + alpha)
  const androidClassified = classifyAndroidChannels(
    androidStoreVersion, androidOta, externalBeta, externalAlpha,
  );
  for (const c of androidClassified) {
    channels.push({ ...c, checkedAt });
  }

  // Vignette (icône Discord) pour tous les canaux qui n'en ont pas
  for (const c of channels) {
    if (!c.artwork) c.artwork = iosStoreData?.artwork || null;
  }

  // Print summary
  for (const c of channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }

  return { scrapedAt: checkedAt, channels, otaIndex, sources };
}

// ── Change detection ──────────────────────────────────

/**
 * Versions publiées strictement entre `from` et `to` pour un canal, d'après
 * les index connus (OTA Discord, commits de datamining). Sert à ne jamais
 * « oublier » une version sortie entre deux runs.
 */
function intermediateVersions(snapshot, channel, from, to) {
  if (!from || !to || cmpVersion(to, from) <= 0) return [];
  const pool = new Set();
  const plat = channel.platform;
  const track = channel.channel;
  const ota = (snapshot && snapshot.otaIndex && snapshot.otaIndex[plat]) || [];
  for (const v of ota) {
    if (!v || !v.version) continue;
    if (plat === 'android') {
      const d = decodeAndroidBuild(v.build);
      const t = d ? d.track : 0;
      const want = track === 'stable' ? 0 : track === 'beta' ? 1 : 2;
      if (t !== want) continue;
    } else if (track !== 'stable' && track !== 'beta') continue;
    pool.add(v.version);
  }
  const tv = snapshot && snapshot.sources && snapshot.sources.androidTrackVersions;
  if (plat === 'android' && tv && Array.isArray(tv[track])) for (const v of tv[track]) pool.add(v);
  return [...pool]
    .filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, to) < 0)
    .sort((a, b) => cmpVersion(a, b));
}

function detectChanges(previous, snapshot) {
  const changes = [];
  const notified = new Set((previous?.notifiedFingerprints || []).map(String));
  const prevMap = new Map();
  for (const c of previous?.channels || []) {
    if (c && c.version) prevMap.set(channelKey(c), c);
  }

  for (const c of snapshot.channels) {
    if (!c.version || c.stale) continue;
    const key = channelKey(c);
    const fp = versionFingerprint(c);
    if (!fp) continue;
    const prev = prevMap.get(key);
    if (
      prev && prev.version && cmpVersion(c.version, prev.version) === 0 &&
      c.build && prev.build && String(c.build) !== String(prev.build)
    ) {
      // Même version, nouveau build (re-publication / hotfix OTA) : annoncé une fois.
      const rfp = `${fp}|${c.build}`;
      if (!notified.has(rfp)) changes.push({ type: 'rebuild', channel: c, previous: prev, fp: rfp });
      continue;
    }
    if (notified.has(fp)) continue;

    if (!prev || !prev.version) {
      changes.push({ type: 'new', channel: c, previous: null, fp });
      continue;
    }
    if (cmpVersion(c.version, prev.version) > 0) {
      const skipped = intermediateVersions(snapshot, c, prev.version, c.version);
      changes.push({ type: 'updated', channel: c, previous: prev, fp, ...(skipped.length ? { skipped } : {}) });
    }
  }

  return { changes, notified };
}

/** Ne jamais remplacer une version connue par une réponse momentanément vide. */
function preserveUnavailableChannels(previous, snapshot) {
  const current = Array.isArray(snapshot?.channels) ? snapshot.channels : [];
  const currentKeys = new Set(current.map((c) => channelKey(c)));
  const previousByKey = new Map(
    (Array.isArray(previous?.channels) ? previous.channels : [])
      .filter((c) => c && c.version)
      .map((c) => [channelKey(c), c]),
  );
  const result = current.map((channel) => {
    if (channel?.version) return channel;
    const old = previousByKey.get(channelKey(channel || {}));
    if (!old) return channel;
    return {
      ...old,
      stale: true,
      staleReason: 'No current version from available sources',
    };
  });
  for (const [key, old] of previousByKey) {
    if (currentKeys.has(key)) continue;
    result.push({
      ...old,
      stale: true,
      staleReason: 'Channel missing from current source response',
    });
  }
  snapshot.channels = result;
  return snapshot;
}

// ── Notifications ─────────────────────────────────────

/**
 * Décode un build number Android au format Discord :
 *   MMM T NN PPPPPPPPP  (ex. 35000800463173 → 350 / 0 / 08 / 00463173)
 *   → version 350.8 · track 0 = stable (0=stable, 1=beta, 2=alpha, 3=dev)
 */
function decodeAndroidBuild(build) {
  const m = String(build || '').match(/^(\d{3})(\d)(\d{2})(\d{8})$/);
  if (!m) return null;
  const trackNames = { 0: 'stable', 1: 'beta', 2: 'alpha', 3: 'dev' };
  return {
    version: `${Number(m[1])}.${Number(m[3])}`,
    track: Number(m[2]),
    trackName: trackNames[Number(m[2])] || 'unknown',
  };
}

/** Couleur d'accent par canal (style release tracker). */
function colorFor(channel) {
  if (channel === 'alpha') return 0xfee75c;
  if (channel === 'beta') return 0xe67e22;
  return 0x57f287;
}

const CHANNEL_EMOJI = { stable: '🟢', beta: '🟠', alpha: '🟡' };
const PLATFORM_EMOJI = { ios: '🍎', android: '🤖' };

function platformLabel(c) {
  return c.platform === 'ios' ? 'iOS' : 'Android';
}

function releaseTitle(c) {
  if (c.platform === 'ios') return c.channel === 'beta' ? 'New TestFlight Release' : 'New App Store Release';
  return `New Android ${trackName(c)} Release`;
}

function trackName(c) {
  if (c.channel === 'beta') return 'Beta';
  if (c.channel === 'alpha') return 'Alpha';
  return 'Stable';
}

/** Nature du bump : « major » (346 → 347), « minor » (346.1 → 346.2) ou null. */
function bumpKind(from, to) {
  if (!from || !to) return null;
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (b[0] !== a[0]) return 'major';
  return cmpVersion(to, from) > 0 ? 'minor' : null;
}

/** Timestamp Discord (<t:…:f> · <t:…:R>) — s'affiche dans le fuseau du lecteur. */
function discordTime(iso, withRelative = true) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const s = Math.floor(t / 1000);
  return withRelative ? `<t:${s}:f> · <t:${s}:R>` : `<t:${s}:f>`;
}

/** Coupe un texte à `max` caractères sur une fin de ligne / de mot. */
function trimText(text, max) {
  const s = String(text || '').replace(/\r/g, '').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  const sp = cut.lastIndexOf(' ');
  if (nl > max * 0.6) cut = cut.slice(0, nl);
  else if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.trimEnd() + '…';
}

const SOURCE_LABELS = {
  itunes_lookup: 'App Store',
  discord_ota_manifest: 'Discord OTA',
  aptoide: 'Aptoide',
  apkmirror: 'APKMirror',
  apkcombo: 'APKCombo',
  apkpure: 'APKPure',
  play_html: 'Google Play',
  store: 'Store',
  datamining_commits: 'Android datamining commits',
  testflight_fallback: 'TestFlight fallback',
};

/** Boutons de liens d'une release (max 5 par ActionRow). */
function releaseButtons(c) {
  const buttons = [];
  if (c.platform === 'ios') {
    buttons.push(linkButton('App Store', c.channel === 'stable' && c.storeUrl ? c.storeUrl : `https://apps.apple.com/app/id${IOS_APP_ID}`));
    if (c.channel === 'beta') buttons.push(linkButton('Join TestFlight', TESTFLIGHT_URL));
  } else {
    buttons.push(linkButton('Google Play', PLAY_STORE_URL));
    if (c.channel === 'beta' || c.channel === 'alpha') {
      buttons.push(linkButton('APKMirror', APKMIRROR_UPLOADS_URL));
      buttons.push(linkButton('Aptoide', APTOIDE_VERSIONS_URL));
    }
  }
  return buttons.slice(0, 5);
}

/**
 * Construit les composants Components V2 d'un message de release :
 *
 *   ┌ ## 🍎 New App Store Release                     [icône]
 *   │ 🟢 **Discord iOS** · Stable · Minor update
 *   │ ### 346.0 → 347.0
 *   ├──────────
 *   │ **Build** · **Commit** · **Size** · **Requires** · **Released** · **Detected**
 *   ├──────────
 *   │ **What's New** (citation)
 *   │ [App Store] [Join TestFlight]
 *   └ -# Datamining · Mobile · source
 */
function buildReleaseComponents(ch) {
  const c = ch.channel;
  const prevVersion = ch.previous && ch.previous.version ? ch.previous.version : null;
  const isNew = ch.type === 'new' || !prevVersion;
  const kind = isNew ? 'First seen' : ch.type === 'rebuild' ? 'New build' : bumpKind(prevVersion, c.version) === 'major' ? 'Major update' : 'Minor update';

  const header = [
    `## ${PLATFORM_EMOJI[c.platform] || '📱'} ${releaseTitle(c)}`,
    `${CHANNEL_EMOJI[c.channel] || '⚪'} **Discord ${platformLabel(c)}** · ${trackName(c)} · ${kind}`,
    isNew || ch.type === 'rebuild' ? `### ${c.version}` : `### ${prevVersion} → ${c.version}`,
  ].join('\n');

  const comps = [];
  if (c.artwork && /^https?:\/\//i.test(c.artwork)) {
    comps.push({
      type: 9, // Section
      components: [textDisplay(header)],
      accessory: { type: 11, media: { url: String(c.artwork).slice(0, 2048) } }, // Thumbnail
    });
  } else {
    comps.push(textDisplay(header));
  }

  const lines = [];
  if (c.build) {
    const decoded = c.platform === 'android' ? decodeAndroidBuild(c.build) : null;
    lines.push(`**Build** · \`${c.build}\`${decoded ? ` · track ${decoded.track} (${decoded.trackName})` : ''}`);
  }
  if (ch.type === 'rebuild' && ch.previous && ch.previous.build) {
    lines.push(`**Previous build** · \`${ch.previous.build}\``);
  }
  if (Array.isArray(ch.skipped) && ch.skipped.length) {
    lines.push(`**Also released since last check** · ${ch.skipped.slice(0, 15).map((v) => `\`${v}\``).join(', ')}${ch.skipped.length > 15 ? ` +${ch.skipped.length - 15}` : ''}`);
  }
  if (c.releaseName) lines.push(`**Release** · \`${String(c.releaseName).slice(0, 60)}\``);
  if (c.commit) lines.push(`**Commit** · \`${String(c.commit).slice(0, 12)}\``);
  if (c.size) lines.push(`**Size** · ${c.size}`);
  if (c.requires) lines.push(`**Requires** · ${c.requires}`);
  const released = c.releaseDate ? discordTime(c.releaseDate) : null;
  if (released) lines.push(`**Released** · ${released}`);
  const detected = discordTime(c.checkedAt || new Date().toISOString());
  if (detected) lines.push(`**Detected** · ${detected}`);
  if (lines.length) {
    comps.push(separator(true, 1));
    comps.push(textDisplay(lines.join('\n')));
  }

  if (c.releaseNotes) {
    const notes = trimText(c.releaseNotes, 700)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    comps.push(separator(true, 1));
    comps.push(textDisplay(`**What's New**\n${notes}`));
  }

  const buttons = releaseButtons(c);
  if (buttons.length) comps.push({ type: 1, components: buttons });

  const src = SOURCE_LABELS[c.source] || c.source || null;
  const footer = ['Datamining', 'Mobile', `${platformLabel(c)} ${trackName(c)}`];
  if (src) footer.push(`source: ${src}`);
  if (c.note) footer.push(String(c.note).slice(0, 80));
  comps.push(textDisplay(`-# ${footer.join(' · ')}`));
  return comps;
}

/**
 * Résumé Components V2 quand plusieurs canaux bougent dans le même run :
 * une ligne par canal, groupées par plateforme.
 */
function buildSummaryComponents(changes) {
  const byPlatform = { ios: [], android: [] };
  for (const ch of changes) {
    const c = ch.channel;
    const prev = ch.previous && ch.previous.version ? ch.previous.version : null;
    const arrow = prev ? `${prev} → **${c.version}**` : `**${c.version}** (new)`;
    const line = `${CHANNEL_EMOJI[c.channel] || '⚪'} **${trackName(c)}** · ${arrow}${c.build ? ` · \`${c.build}\`` : ''}`;
    (byPlatform[c.platform] || (byPlatform[c.platform] = [])).push(line);
  }
  const comps = [textDisplay(`## 📱 Discord Mobile · ${changes.length} new version${changes.length > 1 ? 's' : ''}`)];
  for (const plat of Object.keys(byPlatform)) {
    const lines = byPlatform[plat];
    if (!lines.length) continue;
    comps.push(separator(true, 1));
    comps.push(textDisplay(`**${PLATFORM_EMOJI[plat] || '📱'} ${plat === 'ios' ? 'iOS' : 'Android'}**\n${lines.join('\n')}`));
  }
  comps.push(textDisplay('-# Datamining · Mobile · versions'));
  return comps;
}

/** Envoie un payload Components V2 (boutons inclus) sur la webhook. */
async function postComponents(components, accentColor) {
  if (!WEBHOOK_URL) return false;
  const messages = chunkIntoMessages(components, accentColor, true);
  const url = withComponentsUrl(WEBHOOK_URL);
  for (const componentsMsg of messages) {
    const r = await sendWebhook(url, {
      username: BOT_NAME,
      avatar_url: BOT_AVATAR,
      flags: IS_COMPONENTS_V2_FLAG,
      components: componentsMsg,
    }, { identity: 'mobile', label: 'mobile', timeoutMs: 30000, minGapMs: 200 });
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        throw new Error('Webhook HTTP ' + r.status);
      }
      throw new Error('Webhook failed after retries');
    }
  }
  return true;
}

/** Ordre d'affichage : iOS puis Android, stable → beta → alpha. */
function sortChanges(changes) {
  const pOrder = { ios: 0, android: 1 };
  const cOrder = { stable: 0, beta: 1, alpha: 2 };
  return [...changes].sort((a, b) =>
    (pOrder[a.channel.platform] ?? 9) - (pOrder[b.channel.platform] ?? 9) ||
    (cOrder[a.channel.channel] ?? 9) - (cOrder[b.channel.channel] ?? 9));
}

/**
 * Envoie les notifs : un résumé uniquement s'il y a plusieurs releases,
 * puis 1 message Components V2 par release (icône, détails, boutons).
 */
async function notify(changes) {
  if (!WEBHOOK_URL || !changes.length) return;
  const r = await deliverChanges(changes);
  if (r.error) throw r.error;
}

/**
 * Envoie les releases une par une et rapporte précisément ce qui est parti.
 * Avant : un échec sur la 3e release faisait rejouer les 2 premières au run
 * suivant (doublons), car rien n'indiquait lesquelles étaient déjà livrées.
 * @returns {Promise<{sent:object[],failed:object[],error:Error|null}>}
 */
async function deliverChanges(changes, post = postComponents) {
  const ordered = sortChanges(changes || []);
  const sent = [];
  if (!ordered.length) return { sent, failed: [], error: null };
  try {
    if (ordered.length > 1) await post(buildSummaryComponents(ordered), 0x5865f2);
    for (const ch of ordered) {
      await post(buildReleaseComponents(ch), colorFor(ch.channel.channel));
      sent.push(ch);
    }
  } catch (error) {
    const done = new Set(sent);
    return { sent, failed: ordered.filter((ch) => !done.has(ch)), error };
  }
  return { sent, failed: [], error: null };
}

/**
 * Remet l'ancienne version des canaux dont la notification a échoué, pour que
 * le run suivant les redétecte même si cet état est enregistré. Sans cela la
 * nouvelle version était écrite sans avoir été annoncée : jamais renvoyée.
 */
function holdBackFailedChannels(snapshot, failed) {
  const byKey = new Map((failed || []).map((ch) => [channelKey(ch.channel), ch]));
  if (!byKey.size) return snapshot;
  snapshot.channels = (snapshot.channels || [])
    .map((c) => {
      const ch = byKey.get(channelKey(c));
      if (!ch) return c;
      return ch.previous || null; // canal inédit : retiré, il sera « new » au prochain run
    })
    .filter(Boolean);
  return snapshot;
}

const changeSummary = (c) => ({
  type: c.type,
  key: channelKey(c.channel),
  from: c.previous?.version || null,
  to: c.channel.version,
  build: c.channel.build || null,
});

// ── Main ──────────────────────────────────────────────

async function main() {
  if (PAUSED) {
    console.log('=== Mobile Versions ===');
    console.log('PAUSED — no scrape / no webhooks');
    console.log('Set MOBILE_VERSIONS_PAUSED=0 to re-enable');
    console.log('=== Mobile versions done (paused) ===');
    return;
  }

  await fs.ensureDir(DATA_DIR);
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {
      console.warn('loadPrevious: failed to read', STATE_FILE, '-', e.message);
    }
  }

  console.log('=== Mobile Versions ===');
  console.log('Webhook:', WEBHOOK_URL ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  const snapshot = preserveUnavailableChannels(previous, await collectAll());

  const hadPriorState =
    previous &&
    ((previous.notifiedFingerprints && previous.notifiedFingerprints.length) ||
      (previous.channels || []).some((c) => c && c.version));

  const { changes, notified } = detectChanges(previous, snapshot);

  for (const fp of previous?.notifiedFingerprints || []) {
    notified.add(String(fp));
  }

  const history = previous?.history || [];
  const willNotify = hadPriorState && changes.length > 0 && !!WEBHOOK_URL;

  console.log(
    'Candidates:', changes.length,
    '| hadPriorState:', !!hadPriorState,
    '| prior fingerprints:', notified.size,
  );

  if (!hadPriorState) {
    console.log('Seed run - no webhook; recording fingerprints');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) { notified.delete(fp); notified.add(fp); }
    }
  } else if (willNotify) {
    const record = (list) => {
      for (const ch of list) {
        if (ch.fp) notified.add(ch.fp);
        history.unshift({
          at: snapshot.scrapedAt,
          key: channelKey(ch.channel),
          from: ch.previous?.version || null,
          to: ch.channel.version,
          build: ch.channel.build || null,
        });
      }
    };
    const outcome = await deliverChanges(changes);
    if (outcome.error) {
      // Livrées : acquittées (pas de doublon). Échouées : ancienne version
      // conservée (pas de perte), elles repartent au prochain run.
      const delivered = new Set(outcome.sent);
      record(changes.filter((ch) => delivered.has(ch)));
      holdBackFailedChannels(snapshot, outcome.failed);
      snapshot.history = history.slice(0, 100);
      snapshot.previousScrapedAt = previous?.scrapedAt || null;
      snapshot.notifiedFingerprints = trimRecent(notified, 2000);
      snapshot.changes = outcome.sent.map(changeSummary);
      snapshot.paused = false;
      snapshot.notifyOk = false;
      await writeJsonAtomic(STATE_FILE, snapshot, 2);
      console.warn(
        'NOTIFY_FAIL:', outcome.error.message,
        `- ${outcome.sent.length} livrée(s) et acquittée(s), ${outcome.failed.length} à renvoyer au prochain run`,
      );
      process.exit(2);
    }
    record(changes);
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) { notified.delete(fp); notified.add(fp); }
    }
  } else {
    console.log('No version bumps - no webhook');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) { notified.delete(fp); notified.add(fp); }
    }
  }

  snapshot.history = history.slice(0, 100);
  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.notifiedFingerprints = trimRecent(notified, 2000);
  snapshot.changes = willNotify ? changes.map(changeSummary) : [];
  snapshot.paused = false;
  snapshot.notifyOk = true;

  await writeJsonAtomic(STATE_FILE, snapshot, 2);
  console.log('=== Mobile versions done ===');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  parseVersion,
  cmpVersion,
  bumpKind,
  decodeAndroidBuild,
  parseAndroidDataminingCommits,
  androidFromDataminingRepo,
  preferNewerTrackVersion,
  mergeExternalVersionData,
  classifyAndroidChannels,
  selectIosBetaFallback,
  classifyIosChannels,
  detectChanges,
  intermediateVersions,
  notify,
  deliverChanges,
  holdBackFailedChannels,
  preserveUnavailableChannels,
  buildReleaseComponents,
  buildSummaryComponents,
  sortChanges,
  trimText,
  discordTime,
  colorFor,
};
