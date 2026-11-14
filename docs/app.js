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
  return list.map((e) => ({
    id: e.id || e.name || 'unknown',
    type: String(e.type || 'unknown').toLowerCase(),
  }));
}

function render() {
  const q = (searchInput?.value || '').trim().toLowerCase();
  const list = all.filter((e) => {
    if (filter !== 'all' && e.type !== filter) return false;
    if (!q) return true;
    return e.id.toLowerCase().includes(q);
  });
  if (metaEl) metaEl.textContent = list.length + ' / ' + all.length;
  document.getElementById('stat-total').textContent = String(all.length);
  document.getElementById('stat-user').textContent = String(all.filter((e) => e.type === 'user').length);
  document.getElementById('stat-guild').textContent = String(all.filter((e) => e.type === 'guild').length);
  grid.innerHTML = list.map((e) => `
    <article class="card">
      <h3>${e.id}</h3>
      <span class="badge">${e.type}</span>
    </article>
  `).join('') || '<p>Aucun experiment.</p>';
}

loadData().then((raw) => {
  all = normalize(raw);
  render();
}).catch(() => {
  if (metaEl) metaEl.textContent = 'Données indisponibles';
  grid.innerHTML = '<p>Pas de data/experiments.json pour le moment.</p>';
});

searchInput?.addEventListener('input', render);
document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter || 'all';
    render();
  });
});
