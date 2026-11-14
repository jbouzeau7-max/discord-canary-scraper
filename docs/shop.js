function showText(el, text, tag = 'p') {
  const node = document.createElement(tag);
  node.textContent = text;
  el.replaceChildren(node);
}

async function load() {
  const el = document.getElementById('grid');
  if (!el) return;
  try {
    const res = await fetch('./data/shop_items.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length) showText(el, JSON.stringify(items.slice(0, 50), null, 2), 'pre');
    else showText(el, 'Aucun item boutique pour le moment.');
  } catch {
    showText(el, 'Pas de data/shop_items.json');
  }
}
load();
