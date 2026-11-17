'use strict';

/**
 * Complète data/external_versions.json avec les versions beta/alpha Android
 * lues sur APKMirror.
 *
 * Pourquoi un navigateur : la page « Latest uploads » est protégée par
 * Cloudflare, un simple fetch HTTP reçoit 403 (« Just a moment… »), ce qui
 * laissait le canal beta vide run après run. Un Chromium headless passe le
 * challenge et rend le texte « Version:355.6 - Beta ».
 *
 * Le script échoue en douceur (exit 0) : sans données exploitables il
 * n'écrit rien, l'état existant reste la seule vérité. Il ne fabrique jamais
 * de version.
 */

const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('../src/lib/atomic');
const {
  parseVersionTrackPairs,
  latestByTrack,
  compareVersions,
  isCloudflareBlocked,
  parseTestFlightJoinPage,
} = require('../src/lib/mirror_parse');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXTERNAL_FILE = path.join(DATA_DIR, 'external_versions.json');
const URL_UPLOADS =
  process.env.MOBILE_APKMIRROR_URL ||
  'https://www.apkmirror.com/uploads/?appcategory=discord-chat-for-gamers';
const TESTFLIGHT_URL = 'https://testflight.apple.com/join/gdE4pRzI';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHALLENGE_TIMEOUT_MS = Number(process.env.MOBILE_MIRROR_CHALLENGE_MS || 25000);

/** Rend le texte visible de la page (après résolution du challenge). */
async function readUploadsText(url = URL_UPLOADS) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_e) {
    throw new Error(
      'playwright manquant : `npm i -D playwright` puis `npx playwright install chromium`',
    );
  }
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => '');
      if (title && !/just a moment/i.test(title)) break;
      await page.waitForTimeout(1000);
    }
    const text = await page.evaluate(() =>
      document.body ? document.body.innerText : '',
    );
    if (isCloudflareBlocked(text)) throw new Error('Cloudflare challenge not solved');
    if (!text.trim()) throw new Error('empty page');
    return text;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Page publique TestFlight : n'expose la version beta que si la bêta accepte
 * encore des testeurs (`beta is full` sinon). Aucun navigateur nécessaire.
 */
async function probeTestFlight(fetchImpl) {
  const doFetch = fetchImpl || require('node-fetch');
  const res = await doFetch(TESTFLIGHT_URL, {
    timeout: 20000,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`TestFlight HTTP ${res.status}`);
  return parseTestFlightJoinPage(await res.text());
}

/**
 * Fusionne les versions trouvées dans l'état existant.
 * Une version connue n'est jamais remplacée par une plus ancienne.
 */
function mergeTracks(previous, latest, nowIso, source = 'apkmirror', iosBeta = null) {
  const state = previous && typeof previous === 'object' ? previous : {};
  const oldAndroid = state.android && typeof state.android === 'object' ? state.android : {};
  const oldIos = state.ios && typeof state.ios === 'object' ? state.ios : {};
  const android = { ...oldAndroid };
  const updated = [];
  for (const track of ['beta', 'alpha']) {
    const candidate = latest?.[track];
    if (!candidate?.version) continue;
    const old = oldAndroid[track];
    if (old?.version && compareVersions(old.version, candidate.version) >= 0) continue;
    android[track] = {
      version: candidate.version,
      track,
      date: nowIso,
      source,
    };
    updated.push(`${track} ${candidate.version}`);
  }
  const ios = { ...oldIos };
  if (iosBeta?.version && (!oldIos.beta?.version || compareVersions(iosBeta.version, oldIos.beta.version) > 0)) {
    ios.beta = {
      version: iosBeta.version,
      build: oldIos.beta?.build || null,
      source: 'testflight_page',
      checkedAt: nowIso,
    };
    updated.push(`ios beta ${iosBeta.version}`);
  }
  return {
    state: {
      ...state,
      updatedAt: nowIso,
      sources: {
        ...(state.sources || {}),
        [source]: { url: URL_UPLOADS, lastAccessible: true, via: 'browser' },
      },
      android,
      ios,
    },
    updated,
  };
}

async function main() {
  let text = '';
  try {
    text = await readUploadsText();
  } catch (error) {
    console.warn('mobile_mirrors: APKMirror skipped —', error.message);
  }
  const pairs = text ? parseVersionTrackPairs(text) : [];
  const latest = latestByTrack(pairs);
  if (pairs.length) {
    console.log(
      `mobile_mirrors: ${pairs.length} versions parsed (beta ${latest.beta?.version || 'n/a'}, alpha ${latest.alpha?.version || 'n/a'}, stable ${latest.stable?.version || 'n/a'})`,
    );
  } else {
    console.warn('mobile_mirrors: no version/track pair on APKMirror — Android state untouched');
  }

  let iosBeta = null;
  try {
    const tf = await probeTestFlight();
    console.log('mobile_mirrors: TestFlight', tf.status, tf.version || '(no version)');
    if (tf.available) iosBeta = { version: tf.version };
  } catch (error) {
    console.warn('mobile_mirrors: TestFlight skipped —', error.message);
  }

  if (!pairs.length && !iosBeta) return;

  const previous = (await fs.pathExists(EXTERNAL_FILE))
    ? await fs.readJson(EXTERNAL_FILE)
    : null;
  const { state, updated } = mergeTracks(previous, latest, new Date().toISOString(), 'apkmirror', iosBeta);
  if (!updated.length) {
    console.log('mobile_mirrors: nothing newer than the saved state');
    return;
  }
  await writeJsonAtomic(EXTERNAL_FILE, state, 2);
  console.log('mobile_mirrors: saved', updated.join(', '));
}

if (require.main === module) {
  main().catch((error) => {
    // Non bloquant : ce script n'est qu'une source supplémentaire.
    console.warn('mobile_mirrors failed:', error.message);
  });
}

module.exports = { readUploadsText, mergeTracks, probeTestFlight };
