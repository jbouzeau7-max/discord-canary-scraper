async function load() {
  const el = document.getElementById('grid');
  try {
    const urls = ['./data/experiment_rollouts.json', './data/user_rollouts.json'];
    for (const url of urls) {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        el.innerHTML = `<pre>${JSON.stringify(data, null, 2).slice(0, 5000)}</pre>`;
        return;
      }
    }
    el.innerHTML = '<p>Pas de données rollouts pour le moment.</p>';
  } catch {
    el.innerHTML = '<p>Erreur de chargement rollouts</p>';
  }
}
load();
