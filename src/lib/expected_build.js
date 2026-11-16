'use strict';

// Le déclencheur a vu un build plus récent que celui servi au runner (edges CDN
// désynchronisés) : on re-fetch brièvement au lieu de laisser index.js faire un
// FAST SKIP → sinon le nouveau build n'était traité qu'au cron suivant.
async function awaitExpectedBuild(build, expected, opts = {}) {
  const want = parseInt(String(expected || ''), 10);
  if (!Number.isFinite(want)) return build;
  const fetcher = opts.fetchBuild || require('./canary').fetchBuild;
  const deadline = Date.now() + (opts.maxWaitMs != null ? opts.maxWaitMs : 25000);
  const delay = opts.delayMs != null ? opts.delayMs : 1500;
  let cur = build;
  while ((parseInt(String(cur && cur.buildNumber), 10) || 0) < want && Date.now() < deadline) {
    if (cur) console.log('EXPECTED_BUILD lag', { got: cur.buildNumber, want });
    if (cur) await new Promise((r) => setTimeout(r, delay));
    try {
      const next = await fetcher();
      if (next && next.buildNumber) cur = next;
    } catch (e) {
      console.warn('EXPECTED_BUILD refetch', e.message);
      if (!cur) await new Promise((r) => setTimeout(r, delay));
    }
  }
  return cur;
}

module.exports = { awaitExpectedBuild };

if (require.main === module) {
  awaitExpectedBuild(null, process.env.EXPECTED_BUILD)
    .catch((e) => console.warn('EXPECTED_BUILD', e.message))
    .finally(() => process.exit(0));
}
