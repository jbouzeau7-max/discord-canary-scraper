# Avatars des webhooks

Le dossier `webhook-avatars/` contient 29 PNG distincts de 512 × 512 px, un par identité de webhook. Dix sont des illustrations personnalisées générées dans le style de médaillon bleu-violet fourni en référence. Les dix-neuf autres reprennent un emoji Twemoji propre à chaque rubrique, intégré dans le même médaillon. Ce sont des pictogrammes, pas des portraits de personnes.

Les illustrations Twemoji proviennent de la version 15.1.0. Le projet Twemoji indique que ses dessins sont sous licence Creative Commons Attribution 4.0 (CC BY 4.0) et accepte une mention dans le README du projet. Sources : [dépôt Twemoji](https://github.com/jdecked/twemoji) et [licence des illustrations](https://github.com/jdecked/twemoji/blob/master/LICENSE-GRAPHICS).

Les 29 PNG sont hébergés sur des URL publiques pour que Discord puisse les charger même si le dépôt du scraper reste privé. Les associations nom/avatar sont centralisées dans `src/lib/webhook_identity.js`. Une variable d’environnement `WEBHOOK_AVATAR_<NOM_DU_SYSTEME>` peut remplacer l’avatar d’une identité précise, par exemple `WEBHOOK_AVATAR_NEWS_FOOT`.
