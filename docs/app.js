const DATA_URLS = ['./data/experiments.json', './data/findings.json'];
const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const metaEl = document.getElementById('meta');
let all = [];
let filter = 'all';

async function loadData() {
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      return await res.json();
    } catch {}
  }
  return { experiments: [] };
}

function normalize(raw) {
  const list = Array.isArray(raw?.experiments) ? raw.experiments : Array.isArray(raw) ? raw : [];
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id ?? entry.name ?? 'unknown').slice(0, 1000),
      type: String(entry.type || 'unknown').toLowerCase().slice(0, 80),
    }));
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function render() {
  if (!grid) return;
  const q = (searchInput?.value || '').trim().toLowerCase();
  const list = all.filter((entry) => {
    if (filter !== 'all' && entry.type !== filter) return false;
    if (!q) return true;
    return entry.id.toLowerCase().includes(q);
  });
  if (metaEl) metaEl.textContent = list.length + ' / ' + all.length;
  setText('stat-total', all.length);
  setText('stat-user', all.filter((entry) => entry.type === 'user').length);
  setText('stat-guild', all.filter((entry) => entry.type === 'guild').length);

  const cards = list.map((entry) => {
    const article = document.createElement('article');
    article.className = 'card';
    const title = document.createElement('h3');
    title.textContent = entry.id;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = entry.type;
    article.append(title, badge);
    return article;
  });

  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Aucun experiment.';
    cards.push(empty);
  }
  grid.replaceChildren(...cards);
}

loadData().then((raw) => {
  all = normalize(raw);
  render();
}).catch(() => {
  if (metaEl) metaEl.textContent = 'Données indisponibles';
  if (grid) {
    const message = document.createElement('p');
    message.textContent = 'Pas de data/experiments.json pour le moment.';
    grid.replaceChildren(message);
  }
});

searchInput?.addEventListener('input', render);
document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((button) => button.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter || 'all';
    render();
  });
});
