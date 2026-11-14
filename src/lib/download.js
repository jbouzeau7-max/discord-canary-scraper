/**
 * Robust asset downloads for Canary scraper.
 * - atomic .part → final
 * - retries + Retry-After on 429
 * - timeouts, integrity summary
 * - hard max body size (memory safety)
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const { sleep, envNumber, DEFAULT_UA } = require('./utils');

const MAX_BODY = envNumber('DOWNLOAD_MAX_BODY_MB', 25, { min: 1 }) * 1024 * 1024;
const TIMEOUT = envNumber('DOWNLOAD_TIMEOUT_MS', 30000, { min: 5000 });
const MAX_ATTEMPTS = envNumber('DOWNLOAD_MAX_ATTEMPTS', 4, { min: 1, int: true });

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

async function downloadOne(url, dest, opts = {}) {
  const attempts = opts.attempts || MAX_ATTEMPTS;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const part = dest + '.part';
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': DEFAULT_UA },
        timeout: opts.timeout || TIMEOUT,
        agent: url.startsWith('http:') ? httpAgent : httpsAgent,
      });

      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 2) * 1000;
        await sleep(Math.min(ra, 30000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = await res.buffer();
      if (buf.length > MAX_BODY) throw new Error(`body too large ${buf.length}`);

      await fs.ensureDir(path.dirname(dest));
      await fs.writeFile(part, buf);
      await fs.move(part, dest, { overwrite: true });
      return { ok: true, bytes: buf.length, path: dest };
    } catch (e) {
      lastErr = e;
      try { await fs.remove(part); } catch {}
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  return { ok: false, error: lastErr && lastErr.message };
}

async function downloadAll(urls, assetsDir, opts = {}) {
  await fs.ensureDir(assetsDir);
  const results = { ok: 0, failed: 0, http429: 0, bytes: 0, files: [] };

  for (const url of urls || []) {
    const name = path.basename(String(url).split('?')[0]);
    if (!name) continue;
    const dest = path.join(assetsDir, name);
    const r = await downloadOne(url, dest, opts);
    if (r.ok) {
      results.ok++;
      results.bytes += r.bytes || 0;
      results.files.push(name);
    } else {
      results.failed++;
      if (r.error && /429/.test(r.error)) results.http429++;
    }
  }
  return results;
}

module.exports = { downloadOne, downloadAll };
