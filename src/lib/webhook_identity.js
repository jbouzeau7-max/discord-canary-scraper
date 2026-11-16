'use strict';

const { DEFAULT_AVATAR_URL } = require('./utils');

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

// Chaque système possède son propre PNG public, pour que Discord puisse le
// charger sans accès au dépôt privé et sans dépendre d’un CDN tiers à l’exécution.
const AVATAR_URLS = Object.freeze({
  experiments: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/PUTusJUIuYaqrqNA.png',
  strings: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/LxlKORbaZRdSaexE.png',
  routes: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/IzqsCUhWeqmPEcdf.png',
  dismissible: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/tuNygTjQquPDRodm.png',
  apex: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/wixPHAtLrWCfrdJK.png',
  userRollouts: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/BQpKYroTNtjpyfVw.png',
  gistRollouts: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/AjDmiUvgRmEvAMAO.png',
  blog: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/tFkkEVNyDXwdQSkn.png',
  alerts: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/vVrRffJQQcdBEwcr.png',
  newsMonde: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/MByWjfLkFflUIhDP.png',
  newsSocial: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/RqDDadJOHtUNbevm.png',
  newsFoot: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/RyvKulpgPtgdXPYG.png',
  newsTech: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/uANByQBAAJOVYzcX.png',
  newsSpotify: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/vyeNvZGCpXAAMVUJ.png',
  newsGaming: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/cGufWOdZLIvIYASt.png',
  newsCinema: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/TWimBzYGZcLYLbmM.png',
  newsF1: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/OmNcYHLHkzXdSbRu.png',
  newsBasket: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/ouHyxZCJOwMityZl.png',
  newsScience: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/eAoNgSBewxrrbAzA.png',
  newsCrypto: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/GdZwbeZkcEUbcgPw.png',
  newsRap: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/iacwZeyqeoctMxaG.png',
  newsIa: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/PmDNMnUbnYbGeVlV.png',
  newsAnime: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/MHeMxdUpYBXhhNpV.png',
  newsTennis: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/UQMyNAuxSqQVMUPe.png',
  newsMma: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/CPHEwysCQfbnzcoU.png',
  newsAuto: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/ELULRRSyPTcjHqZu.png',
  mobile: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/XfXzRBihOPeGILmf.png',
  quests: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/idPQTgyHDcSbyDyn.png',
  shop: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519664084355346/WNhDgXIYJNrXzLAZ.png',
});

function avatarEnvName(key) {
  return `WEBHOOK_AVATAR_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

const IDENTITIES = Object.freeze(Object.fromEntries(
  Object.entries(LABELS).map(([key, label]) => [
    key,
    [label, process.env[avatarEnvName(key)] || AVATAR_URLS[key] || DEFAULT_AVATAR_URL],
  ]),
));

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES, AVATAR_URLS };
