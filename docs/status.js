async function load() {
  const el = document.getElementById('status');
  try {
    const res = await fetch('./data/last_run_meta.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  } catch {
    el.textContent = 'Pas de last_run_meta.json — lance node src/index.js';
  }
}
load();
