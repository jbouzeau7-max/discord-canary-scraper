function showText(el, text, tag = 'p') {
  const node = document.createElement(tag);
  node.textContent = text;
  el.replaceChildren(node);
}

async function load() {
  const el = document.getElementById('grid');
  if (!el) return;
  try {
    const res = await fetch('./data/mobile_versions.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const data = await res.json();
    showText(el, JSON.stringify(data, null, 2), 'pre');
  } catch {
    showText(el, 'Pas de data/mobile_versions.json');
  }
}
load();
