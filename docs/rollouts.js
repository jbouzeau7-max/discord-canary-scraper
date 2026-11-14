function showText(el, text, tag = 'p') {
  const node = document.createElement(tag);
  node.textContent = text;
  el.replaceChildren(node);
}

async function load() {
  const el = document.getElementById('grid');
  if (!el) return;
  try {
    const urls = ['./data/experiment_rollouts.json', './data/user_rollouts.json'];
    for (const url of urls) {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        showText(el, JSON.stringify(data, null, 2).slice(0, 5000), 'pre');
        return;
      }
    }
    showText(el, 'Pas de données rollouts pour le moment.');
  } catch {
    showText(el, 'Erreur de chargement rollouts');
  }
}
load();
