'use strict';

/**
 * Actus — filtre anti-politique, plafonds anti-spam, parsing RSS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPolitical, pickItems, parseRssItems, normalizeTitle } = require('../src/news');

test('isPolitical : blocklist globale, tolérante aux faux positifs', () => {
  assert.equal(isPolitical('Le Congrès américain vote une loi sur les tech', '', 'social'), true);
  assert.equal(isPolitical('Elections en Allemagne : les résultats', '', 'monde'), true);
  assert.equal(isPolitical('Le gouvernement dévoile son budget', '', 'monde'), true);
  assert.equal(isPolitical('WhatsApp change sa politique de confidentialité', '', 'social'), false);
  assert.equal(isPolitical('PSG : le président du club annonce un recrutement', '', 'foot'), false);
  assert.equal(isPolitical('Le président du club annonce un recrutement', '', 'monde'), true);
});

test('pickItems : plafonds par run, catégorie et source', () => {
  const mk = (i, cat, sourceId) => ({ i, cat, sourceId });
  const items = [
    mk(1, 'foot', 'a'),
    mk(2, 'foot', 'a'),
    mk(3, 'foot', 'a'), // source « a » plafonnée à 2
    mk(4, 'foot', 'b'),
    mk(5, 'foot', 'b'), // catégorie foot plafonnée à 3
    mk(6, 'tech', 'c'),
    mk(7, 'spotify', 'd'),
  ];
  const picked = pickItems(items, { maxPerRun: 10, maxPerCategory: 3, maxPerSource: 2 });
  assert.deepEqual(
    picked.map((p) => p.i),
    [1, 2, 4, 6, 7],
  );
  const cappedRun = pickItems(items, { maxPerRun: 2, maxPerCategory: 3, maxPerSource: 2 });
  assert.deepEqual(
    cappedRun.map((p) => p.i),
    [1, 2],
  );
});

test('parseRssItems : RSS avec CDATA, entités et item sans lien ignoré', () => {
  const xml = [
    '<rss><channel><item><title><![CDATA[Spotify lance un nouveau abonnement]]></title>',
    '<link>https://example.com/a?utm_source=x</link>',
    '<pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate>',
    '<description>&lt;b&gt;Test&lt;/b&gt; description</description>',
    '<source>Le Monde</source></item>',
    '<item><title>Sans lien</title><description>x</description></item></channel></rss>',
  ].join('');
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.ok(items[0].title.includes('Spotify'));
  assert.equal(items[0].desc, 'Test description');
  assert.equal(items[0].sourceTag, 'Le Monde');
});

test('normalizeTitle : clé stable sans accents', () => {
  assert.equal(normalizeTitle('Élections en Allemagne'), normalizeTitle('elections en allemagne'));
});

const { buildItem, buildComponents, cleanDesc, dedupeSimilar, similarity, fetchAll, pickImage } = require('../src/news');

test('pickImage : media:content le plus large, BBC upgradé, vidéo/svg ignorés', () => {
  assert.equal(
    pickImage('<media:content url="https://a/s.jpg" width="200"/><media:content url="https://a/l.jpg" width="900"/>'),
    'https://a/l.jpg',
  );
  assert.equal(
    pickImage('<media:thumbnail width="240" url="https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/x.jpg"/>'),
    'https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/x.jpg',
  );
  assert.equal(pickImage('<enclosure url="https://a/v.mp4" type="video/mp4"/>'), null);
  assert.equal(pickImage('<description>&lt;img src="https://a/logo.svg"&gt;</description>'), null);
  assert.equal(pickImage('<enclosure url="https://a/p.jpg" type="image/jpeg"/>'), 'https://a/p.jpg');
});

test('cleanDesc : vide si répète le titre, retire « Lire la suite », coupe proprement', () => {
  assert.equal(cleanDesc('Spotify lance X', 'Spotify lance X'), '');
  assert.equal(cleanDesc('Un résumé utile. Lire la suite', 'Titre'), 'Un résumé utile.');
  const long = 'Phrase un assez longue pour le test. '.repeat(12);
  const d = cleanDesc(long, 'Titre');
  assert.ok(d.length <= 281 && d.endsWith('.'));
});

test('buildItem : préfixe « 🔴 En direct : » → breaking, date future rejetée', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const src = { id: 's', cat: 'monde', name: 'S' };
  const it = buildItem({ title: '🔴 En direct : Séisme au Japon', link: 'https://x/a', dateRaw: '2026-11-08T11:00:00Z', desc: '' }, src, now);
  assert.equal(it.breaking, true);
  assert.equal(it.title, 'Séisme au Japon');
  assert.equal(buildItem({ title: 'T', link: 'https://x/b', dateRaw: '2026-11-09T12:00:00Z' }, src, now), null);
});

test('dedupeSimilar : même info de deux sources fusionnée', () => {
  assert.ok(similarity('Real Madrid signs Mbappe on five-year deal', 'Mbappe signs five-year deal with Real Madrid') >= 0.6);
  const { kept, dropped } = dedupeSimilar([
    { title: 'Real Madrid signs Mbappe on five-year deal' },
    { title: 'Mbappe signs five-year deal with Real Madrid' },
    { title: 'Spotify raises prices in France' },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1);
});

test('buildComponents : container + titre lien + image + bouton, markdown échappé', () => {
  const comps = buildComponents({
    cat: 'tech', sourceName: '9to5Mac', title: 'iOS 27 *beta* [2]', url: 'https://x/a_(b)',
    desc: 'Résumé', image: 'https://x/i.jpg', date: Date.parse('2026-11-08T12:00:00Z'), breaking: true, alsoBy: ['Frandroid'],
  });
  assert.equal(comps[0].type, 17);
  assert.equal(comps[0].accent_color, 0xed4245);
  const texts = comps[0].components.filter((c) => c.type === 10).map((c) => c.content).join('\n');
  assert.ok(texts.includes('URGENT'));
  assert.ok(texts.includes('\\*beta\\*'));
  assert.ok(texts.includes('%28b%29'));
  assert.ok(texts.includes('<t:1794139200:R>'));
  assert.ok(texts.includes('Frandroid'));
  assert.ok(comps[0].components.some((c) => c.type === 12));
  assert.equal(comps[1].components[0].style, 5);
});

test('fetchAll : parallèle, ordre des sources conservé, source en échec isolée', async () => {
  const srcs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = await fetchAll(0, srcs, async (s) => {
    await new Promise((r) => setTimeout(r, s.id === 'a' ? 30 : 1));
    return s.id === 'b' ? [] : [s.id];
  });
  assert.deepEqual(out, ['a', 'c']);
});
