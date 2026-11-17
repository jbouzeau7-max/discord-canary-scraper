# discord-canary-scraper

Datamining du client Discord Canary : builds, expériences, strings, routes, rollouts, quêtes, boutique, blog, versions mobiles, veille X.

Les nouveautés sont postées sur Discord via webhooks.

## Démarrage rapide

```bash
npm ci
node src/index.js
```

Variables d’environnement utiles :

- `WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` — notifications Discord
- Aucune authentification par compte Discord n’est utilisée ; seules les sources publiques et les webhooks configurés sont employés.
- `NEWS_WEBHOOK_URL`, `SHOP_WEBHOOK_URL`, `QUEST_WEBHOOK_URL`, etc.

## Scripts npm

| Commande | Description |
|----------|-------------|
| `npm start` / `npm run scrape` | Scrape Canary (build + extract) |
| `npm run quests` | Suivi des quêtes |
| `npm run mobile` | Versions mobiles |
| `npm run mirrors` | Versions beta/alpha Android depuis APKMirror (navigateur) |
| `npm run shop` | Boutique |
| `npm run news` | Actus RSS |
| `npm test` | Tests unitaires |
| `npm run lint` | ESLint |
| `npm run verify` | check + lint + test |

## Architecture

- `src/index.js` — entrypoint scrape
- `src/lib/canary.js` — fetch HTML + BUILD_NUMBER + assets
- `src/lib/download.js` — téléchargement robuste
- `src/lib/extract.js` — expériences / routes / strings
- `src/lib/notify.js` + `webhook*.js` — notifications Discord
- `src/lib/state.js` / `atomic.js` — persistance
- `scripts/` — triggers Python, commit-state, utilitaires
- `.github/workflows/` — jobs planifiés (scrape, news, shop, quests, mobile, pages…)

## Versions mobiles (stable / beta / alpha)

Sources réellement disponibles :

| Canal | Source | Remarque |
|-------|--------|----------|
| iOS stable | iTunes lookup | OK |
| iOS beta | page publique TestFlight + repli `external_versions.json` | la page n'expose une version que si la bêta accepte des testeurs ; sinon `beta is full` |
| Android stable | OTA `discord.com/android/{v}/manifest.json` + stores | OK |
| Android alpha | commits de `Wumpus-Central/discord-mobile-datamining` | OK (track 2) |
| Android beta | APKMirror / Aptoide | pages derrière Cloudflare : un fetch HTTP reçoit 403 |

Le manifeste OTA de Discord ne publie **que** les builds stables : il n'existe
aucun `discord.com/android/{v}/manifest.json` pour un build beta/alpha, donc le
décodage du track depuis l'OTA ne peut rien trouver. Les miroirs
(APKMirror, Aptoide) sont la seule source beta, et ils bloquent les fetches
automatisés.

Trois façons de récupérer les betas :

1. `MOBILE_SCRAPE_PROXY` — relais qui renvoie le HTML rendu (Worker, etc.).
   `{url}` est remplacé par l'URL encodée : `https://proxy.exemple/?url={url}`.
2. `npm run mirrors` — lit APKMirror avec un vrai navigateur
   (`npm i -D playwright && npx playwright install chromium`, puis
   `xvfb-run -a node scripts/mobile_mirrors.js` sans écran) et fusionne
   beta/alpha dans `data/external_versions.json`. Le script lit aussi la page
   TestFlight (iOS beta quand la bêta est ouverte).
3. Édition manuelle de `data/external_versions.json` (`android.beta`,
   `android.alpha`, `ios.beta`) : le fichier sert de repli et ne régresse jamais.

L'état `data/mobile_versions.json` expose `sources.health` (`ok`, `blocked`,
`full`, `error`) pour chaque source : si un canal est vide, c'est lisible
directement dans l'état.

## Données

- `data/` — état (build, experiments, strings, routes…)
- `assets/` — JS/CSS téléchargés (non versionnés)
- `builds/` — archives par build
- `chunks/` / `css/` — publication plate

## Notes

Ce dépôt a été reconstruit progressivement à partir du ZIP source. Certains modules secondaires (`src/quests.js`, `src/shop.js`, etc.) et le README/workflows originaux complets peuvent encore être complétés.

## Licence

Voir le dépôt.
