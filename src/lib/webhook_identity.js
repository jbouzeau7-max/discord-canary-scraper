'use strict';

// Les avatars sont servis par Twemoji, pas par l’ancien dépôt public devenu
// indisponible. Le dépôt cible reste privé et ne sert donc pas d’URL d’image.
const EMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/';

const LABELS = Object.freeze({
  experiments: ['Expériences', '1f9ea'],
  strings: ['Textes', '1f4ac'],
  routes: ['Routes', '1f9ed'],
  dismissible: ['Contenus', '1f4e6'],
  apex: ['Rollouts serveurs', '1f4c8'],
  userRollouts: ['Rollouts utilisateurs', '1f465'],
  gistRollouts: ['Rollouts Gist', '1f4ca'],
  blog: ['Blog & aide', '1f4f0'],
  alerts: ['Alertes', '1f6a8'],
  newsMonde: ['Actus · Monde', '1f30d'],
  newsSocial: ['Actus · Réseaux sociaux', '1f4f1'],
  newsFoot: ['Actus · Foot', '26bd'],
  newsTech: ['Actus · iPhone & Android', '1f4f1'],
  newsSpotify: ['Actus · Spotify', '1f3b5'],
  newsGaming: ['Actus · Jeux vidéo', '1f3ae'],
  newsCinema: ['Actus · Cinéma & séries', '1f3ac'],
  newsF1: ['Actus · F1', '1f3ce'],
  newsBasket: ['Actus · Basket & NBA', '1f3c0'],
  newsScience: ['Actus · Science & espace', '1f52c'],
  newsCrypto: ['Actus · Crypto', '1fa99'],
  newsRap: ['Actus · Rap & musique', '1f3a4'],
  newsIa: ['Actus · IA', '1f916'],
  newsAnime: ['Actus · Anime & manga', '1f4fa'],
  newsTennis: ['Actus · Tennis', '1f3be'],
  newsMma: ['Actus · MMA & boxe', '1f94a'],
  newsAuto: ['Actus · Auto', '1f697'],
  mobile: ['Mobile', '1f4f1'],
  quests: ['Quêtes', '1f451'],
  shop: ['Boutique', '1f6cd'],
});

const IDENTITIES = Object.freeze(Object.fromEntries(
  Object.entries(LABELS).map(([key, [label, emoji]]) => [
    key,
    [label, `${EMOJI}${emoji}.png`],
  ]),
));

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES };
