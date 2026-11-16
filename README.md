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

## Données

- `data/` — état (build, experiments, strings, routes…)
- `assets/` — JS/CSS téléchargés (non versionnés)
- `builds/` — archives par build
- `chunks/` / `css/` — publication plate

## Notes

Ce dépôt a été reconstruit progressivement à partir du ZIP source. Certains modules secondaires (`src/quests.js`, `src/shop.js`, etc.) et le README/workflows originaux complets peuvent encore être complétés.

## Licence

Voir le dépôt.
