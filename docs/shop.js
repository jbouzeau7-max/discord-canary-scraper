async function load() {
  const el = document.getElementById('grid');
  try {
    const res = await fetch('./data/shop_items.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const data = await res.json();
    const items = data.items || [];
    el.innerHTML = items.length
      ? `<pre>${JSON.stringify(items.slice(0, 50), null, 2)}</pre>`
      : '<p>Aucun item boutique pour le moment.</p>';
  } catch {
    el.innerHTML = '<p>Pas de data/shop_items.json</p>';
  }
}
load();
