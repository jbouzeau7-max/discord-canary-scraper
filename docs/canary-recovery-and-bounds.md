# Canary : interpréter les mesures et reprendre après interruption

Le déclencheur Python autonome conserve le dernier numéro de build pour lequel GitHub a accepté le dispatch. Une réponse CDN plus ancienne ne rembobine pas cet état. Si le dispatch échoue, le numéro n'avance pas : le même build reste éligible au prochain passage. Cela ne reconstitue pas un build intermédiaire que le collecteur n'a jamais observé.

Dans les bornes par position, `knownInPct` ne compte que les positions réellement observées dedans. `minPct` et `maxPct` supposent des plages contiguës entre observations ; `estPct` en est le milieu arrondi, y compris aux extrémités de l'espace. Ce milieu n'est ni un taux mesuré sur la population Discord ni un intervalle de confiance. Avec une seule position positive sur 10 000, l'intervalle reste 0,01–100 %. Sans position positive, le comportement historique (`estPct: null`) reste inchangé.

L'utilitaire `dedupe-sent-only` préserve les acquittements historiques numériques et les statuts `sent`/`done` horodatés. Les entrées `pending`, `failed`, nulles ou sans horodatage utilisable ne sont pas une preuve de livraison. Après une interruption entre l'acceptation d'un webhook et la sauvegarde de son acquittement, une relivraison reste possible.

Les régressions hors ligne sont couvertes par `test/test_canary_trigger.py`, `test/position_edges.test.js` et `test/recovery_receipts.test.js`. Elles n'utilisent ni webhook réel, ni jeton, ni écriture dans les données de production.
