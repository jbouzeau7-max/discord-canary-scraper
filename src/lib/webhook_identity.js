'use strict';

// Les avatars du dépôt sont des illustrations vectorielles simples, pas des portraits IA.
const MEDIA = 'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@2600f26572392c44397e72766660521332ce56ee/media/';
const EMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/';

// Couronne des quêtes : GIF fourni par l'utilisateur (media/IMG_2645.gif),
// épinglé au commit 1d93da0 pour la stabilité du CDN, comme MEDIA.
const QUEST_CROWN =
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@' + '1d93da0f47075cbd461d35a7887f8cdda7d3e48e' + '/media/IMG_2645.gif';

// Photos de profil Actus « néon glass » (scripts/gen_news_avatars.py) :
// régénérées par le workflow news-avatars.yml → servies depuis main pour que
// chaque nouvelle version soit prise en compte sans changer le code.
const NEWS_MEDIA = 'https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/media/news-';

const IDENTITIES = Object.freeze({
  experiments: ['Expériences', MEDIA + 'avatar-experiments.png'],
  strings: ['Textes', MEDIA + 'datamining-avatar.png'],
  routes: ['Routes', MEDIA + 'avatar-dismissible.png'],
  dismissible: ['Contenus', MEDIA + 'avatar-dismissible.png'],
  apex: ['Rollouts serveurs', MEDIA + 'avatar-apex-rollouts.png'],
  userRollouts: ['Rollouts utilisateurs', MEDIA + 'avatar-gist-rollouts.png'],
  gistRollouts: ['Rollouts Gist', MEDIA + 'avatar-gist-rollouts.png'],
  blog: ['Blog & aide', MEDIA + 'avatar-blog.png'],
  alerts: ['Alertes', MEDIA + 'avatar-alerts.png'],
  newsMonde: ['Actus · Monde', NEWS_MEDIA + 'monde.png'],
  newsSocial: ['Actus · Réseaux sociaux', NEWS_MEDIA + 'social.png'],
  newsFoot: ['Actus · Foot', NEWS_MEDIA + 'foot.png'],
  newsTech: ['Actus · iPhone & Android', NEWS_MEDIA + 'tech.png'],
  newsSpotify: ['Actus · Spotify', NEWS_MEDIA + 'spotify.png'],
  newsGaming: ['Actus · Jeux vidéo', NEWS_MEDIA + 'gaming.png'],
  newsCinema: ['Actus · Cinéma & séries', NEWS_MEDIA + 'cinema.png'],
  newsF1: ['Actus · Formule 1', NEWS_MEDIA + 'f1.png'],
  newsBasket: ['Actus · Basket & NBA', NEWS_MEDIA + 'basket.png'],
  newsScience: ['Actus · Science & espace', NEWS_MEDIA + 'science.png'],
  newsCrypto: ['Actus · Crypto', NEWS_MEDIA + 'crypto.png'],
  newsRap: ['Actus · Rap & musique', NEWS_MEDIA + 'rap.png'],
  newsIa: ['Actus · IA', NEWS_MEDIA + 'ia.png'],
  newsAnime: ['Actus · Anime & manga', NEWS_MEDIA + 'anime.png'],
  newsTennis: ['Actus · Tennis', NEWS_MEDIA + 'tennis.png'],
  newsMma: ['Actus · MMA & boxe', NEWS_MEDIA + 'mma.png'],
  newsAuto: ['Actus · Auto', NEWS_MEDIA + 'auto.png'],
  mobile: ['Mobile', EMOJI + '1f4f1.png'],
  quests: ['Quêtes', QUEST_CROWN],
  shop: ['Boutique', EMOJI + '1f6cd.png'],
});

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES };
