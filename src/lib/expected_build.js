'use strict';

// Des edges CDN peuvent renvoyer des builds dans le désordre. Garder le plus
// récent observé et ne jamais lancer une nouvelle sonde après l'échéance.
async function awaitExpectedBuild(build, expected, opts = {}) {
  const number = (v) => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : 0;
  const want = number(expected);
  if (!want) return build;
  const fetcher = opts.fetchBuild || require('./canary').fetchBuild;
  const deadline = Date.now() + (opts.maxWaitMs ?? 25000);
  const delay = Math.max(1, opts.delayMs ?? 1500);
  let cur = build;
  let pause = Boolean(cur);
  while (number(cur?.buildNumber) < want && Date.now() < deadline) {
    if (pause) {
      await new Promise((r) => setTimeout(r, Math.min(delay, deadline - Date.now())));
      if (Date.now() >= deadline) break;
    }
    pause = true;
    try {
      const next = await fetcher();
      if (number(next?.buildNumber) > number(cur?.buildNumber)) cur = next;
    } catch (e) {
      console.warn('EXPECTED_BUILD refetch', e.message);
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
