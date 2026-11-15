'use strict';

const { DEFAULT_AVATAR_URL } = require('./utils');
const AVATAR_URL = process.env.WEBHOOK_AVATAR_URL || DEFAULT_AVATAR_URL;

const LABELS = Object.freeze({
  experiments: 'Expériences',
  strings: 'Textes',
  routes: 'Routes',
  dismissible: 'Contenus',
  apex: 'Rollouts serveurs',
  userRollouts: 'Rollouts utilisateurs',
  gistRollouts: 'Rollouts Gist',
  blog: 'Blog & aide',
  alerts: 'Alertes',
  newsMonde: 'Actus · Monde',
  newsSocial: 'Actus · Réseaux sociaux',
  newsFoot: 'Actus · Foot',
  newsTech: 'Actus · iPhone & Android',
  newsSpotify: 'Actus · Spotify',
  newsGaming: 'Actus · Jeux vidéo',
  newsCinema: 'Actus · Cinéma & séries',
  newsF1: 'Actus · F1',
  newsBasket: 'Actus · Basket & NBA',
  newsScience: 'Actus · Science & espace',
  newsCrypto: 'Actus · Crypto',
  newsRap: 'Actus · Rap & musique',
  newsIa: 'Actus · IA',
  newsAnime: 'Actus · Anime & manga',
  newsTennis: 'Actus · Tennis',
  newsMma: 'Actus · MMA & boxe',
  newsAuto: 'Actus · Auto',
  mobile: 'Mobile',
  quests: 'Quêtes',
  shop: 'Boutique',
});

const IDENTITIES = Object.freeze(Object.fromEntries(
  Object.entries(LABELS).map(([key, label]) => [
    key,
    [label, AVATAR_URL],
  ]),
));

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES };
