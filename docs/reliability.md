# Garanties de collecte et de livraison

- **Pourcentages utilisateur.** Le modèle de plages travaille sur les positions distinctes de l'espace de hash. Une position répétée ne valide ni le seuil de 20 positions ni un îlot isolé. La marge autour d'une frontière arrondie couvre ses deux extrêmes compatibles. Elle est conditionnelle au modèle de plages : elle ne mesure pas les populations non observées. Si le modèle est rejeté, l'estimation par échantillonnage reste disponible.
- **Collecte Webpack.** Les clés numériques `3` et `1e3` désignent deux chunks distincts. Le collecteur de scripts et le résolveur de la locale `en-US` utilisent la même table de correspondance.
- **Notifications.** Dans la fenêtre de déduplication, un échec tardif ne remplace pas une livraison déjà confirmée. Une interruption entre l'acceptation du message par Discord et son enregistrement local reste ambiguë : la livraison exactement une fois n'est pas garantie.
- **Déclencheur Python.** Pour un build inchangé, le contrôle périodique respecte le délai de relance configuré. Les tests utilisent une horloge et un dispatch simulés ; ils ne publient aucun message.

Aucune migration de données n'est nécessaire pour ces changements. Les tests de régression utilisent les fixtures et les états temporaires du dépôt, pas les webhooks de production.
