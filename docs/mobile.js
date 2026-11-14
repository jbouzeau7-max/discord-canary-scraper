async function load() {
  const el = document.getElementById('grid');
  try {
    const res = await fetch('./data/mobile_versions.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const data = await res.json();
    el.innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
  } catch {
    el.innerHTML = '<p>Pas de data/mobile_versions.json</p>';
  }
}
load();
