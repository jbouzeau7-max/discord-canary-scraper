'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mobile = require('../src/mobile_versions');

// Chaque entrée ci-dessous cible un comportement ou une frontière explicite.
const versionCases = [
  ['version entière', '1', [1, 0, 0]],
  ['version majeure et mineure', '1.2', [1, 2, 0]],
  ['version à trois composantes', '1.2.3', [1, 2, 3]],
  ['préfixe textuel', 'v12.4.7', [12, 4, 7]],
  ['zéros initiaux', '003.04.009', [3, 4, 9]],
  ['suffixe textuel attaché', '12beta4', [12, 4, 0]],
  ['séparateurs répétés', '12..4', [12, 4, 0]],
  ['composante finale vide', '12.4.', [12, 4, 0]],
  ['zéro explicite', '0.0.0', [0, 0, 0]],
  ['quatre composantes conservées', '1.2.3.4', [1, 2, 3, 4]],
  ['aucun chiffre donne des composantes nulles', 'release', [0, 0, 0]],
  ['tiret traité comme séparateur', '-2.5', [2, 5, 0]],
  ['lettres comme séparateurs', '2a0b5', [2, 0, 5]],
  ['mineure zéro', '8.000', [8, 0, 0]],
  ['suffixe rc', '8.2rc3', [8, 2, 3]],
  ['chaîne vide normalisée en zéros', '', [0, 0, 0]],
];
for (const [label, input, expected] of versionCases) {
  test(`parseVersion — ${label}`, () => assert.deepEqual(mobile.parseVersion(input), expected));
}

const comparisonCases = [
  ['égalité', '1.2', '1.2', 0],
  ['majeure supérieure', '2.0', '1.99', 1],
  ['majeure inférieure', '1.99', '2.0', -1],
  ['mineure supérieure', '1.10', '1.9', 1],
  ['mineure inférieure', '1.9', '1.10', -1],
  ['patch supérieur', '1.2.4', '1.2.3', 1],
  ['patch inférieur', '1.2.3', '1.2.4', -1],
  ['zéro manquant équivaut à zéro', '1', '1.0.0', 0],
  ['nombre de composantes supplémentaire', '1.0.0.1', '1.0.0', 1],
  ['zéros initiaux', '01.002', '1.2', 0],
  ['ordre numérique des mineures', '355.10', '355.9', 1],
  ['ordre numérique des majeures', '100.0', '99.99', 1],
  ['valeur textuelle après même version', '3.4-beta', '3.4', 0],
  ['version vide contre zéro', '', '0.0', 0],
  ['valeur non numérique contre version valide', 'beta', '0.1', -1],
  ['composante patch supplémentaire', '4.3.2.1', '4.3.2', 1],
  ['mineure zéro contre une', '4.0', '4.1', -1],
  ['patch zéro omis', '7.2.0', '7.2', 0],
  ['comparaison symétrique majeure', '9.1', '10.0', -1],
  ['comparaison symétrique patch', '6.8.10', '6.8.9', 1],
];
for (const [label, a, b, sign] of comparisonCases) {
  test(`cmpVersion — ${label}`, () => assert.equal(Math.sign(mobile.cmpVersion(a, b)), sign));
}

const buildCases = [
  ['track stable', '35000800463173', { version: '350.8', track: 0, trackName: 'stable' }],
  ['track bêta', '35010800463173', { version: '350.8', track: 1, trackName: 'beta' }],
  ['track alpha', '35020800463173', { version: '350.8', track: 2, trackName: 'alpha' }],
  ['track dev', '35030800463173', { version: '350.8', track: 3, trackName: 'dev' }],
  ['track non catalogué quatre', '35040800463173', { version: '350.8', track: 4, trackName: 'unknown' }],
  ['track non catalogué neuf', '35090800463173', { version: '350.8', track: 9, trackName: 'unknown' }],
  ['majeure minimale à trois chiffres', '10000000000000', { version: '100.0', track: 0, trackName: 'stable' }],
  ['mineure 09 avec majeure maximale', '99930990000000', { version: '999.9', track: 3, trackName: 'dev' }],
  ['mineure zéro préservée dans le décodage', '45610000000000', { version: '456.0', track: 1, trackName: 'beta' }],
  ['mineure 09', '45620900000000', { version: '456.9', track: 2, trackName: 'alpha' }],
  ['mineure 10', '45631000000000', { version: '456.10', track: 3, trackName: 'dev' }],
  ['build de longueur exacte', '32120700000000', { version: '321.7', track: 2, trackName: 'alpha' }],
  ['null', null, null],
  ['undefined', undefined, null],
  ['chaîne vide', '', null],
  ['nombre de chiffres trop court', '3501080046317', null],
  ['nombre de chiffres trop long', '350108004631730', null],
  ['majeure non numérique', '35a10800463173', null],
  ['track non numérique', '350x0800463173', null],
  ['mineure non numérique', '35010x00463173', null],
  ['payload non numérique', '35010800x63173', null],
  ['espaces en préfixe', ' 35010800463173', null],
  ['espaces en suffixe', '35010800463173 ', null],
  ['ponctuation dans le build', '350.10800463173', null],
];
for (const [label, input, expected] of buildCases) {
  test(`decodeAndroidBuild — ${label}`, () => assert.deepEqual(mobile.decodeAndroidBuild(input), expected));
}

const preferCases = [
  ['version candidate supérieure', { version: '1.1' }, { version: '1.2' }, 'candidate'],
  ['version candidate inférieure', { version: '1.2' }, { version: '1.1' }, 'current'],
  ['égalité numérique conserve la source existante', { version: '1.2', source: 'old' }, { version: '1.2', source: 'new' }, 'current'],
  ['current absent accepte candidate', null, { version: '2.0' }, 'candidate'],
  ['current sans version accepte candidate', { source: 'old' }, { version: '2.0' }, 'candidate'],
  ['candidate absente conserve current', { version: '2.0' }, null, 'current'],
  ['candidate sans version conserve current', { version: '2.0' }, { source: 'new' }, 'current'],
  ['deux objets sans versions renvoient null', null, {}, 'null'],
  ['version majeure plus récente gagne', { version: '99.99' }, { version: '100.0' }, 'candidate'],
  ['mineure à deux chiffres comparée numériquement', { version: '5.9' }, { version: '5.10' }, 'candidate'],
  ['objet courant sans version est conservé si candidat vide', {}, {}, 'current'],
  ['candidate zéro n’efface pas version positive', { version: '0.1' }, { version: '0.0' }, 'current'],
];
for (const [label, current, candidate, expected] of preferCases) {
  test(`preferNewerTrackVersion — ${label}`, () => {
    const actual = mobile.preferNewerTrackVersion(current, candidate);
    assert.equal(actual, expected === 'current' ? current : expected === 'candidate' ? candidate : null);
  });
}

const iosFallbackCases = [
  ['fallback plus récent accepté', '1.0', [], { version: '1.1' }, true],
  ['fallback égal rejeté', '1.0', [], { version: '1.0' }, false],
  ['fallback inférieur rejeté', '1.1', [], { version: '1.0' }, false],
  ['stable absente', null, [], { version: '2.0' }, false],
  ['fallback absent', '1.0', [], null, false],
  ['fallback objet sans version', '1.0', [], { source: 'saved' }, false],
  ['OTA supérieure bloque le fallback même plus récent', '1.0', [{ version: '1.2' }], { version: '1.3' }, false],
  ['OTA égale ne bloque pas le fallback en avance', '1.0', [{ version: '1.0' }], { version: '1.1' }, true],
  ['OTA inférieure ne bloque pas le fallback', '1.2', [{ version: '1.1' }], { version: '1.3' }, true],
  ['OTA malformée sans version ignorée', '1.0', [{}], { version: '1.1' }, true],
  ['OTA non-tableau traitée comme vide', '1.0', null, { version: '1.1' }, true],
  ['ordre numérique OTA', '1.0', [{ version: '1.10' }], { version: '1.2' }, false],
];
for (const [label, stable, ota, fallback, accepted] of iosFallbackCases) {
  test(`selectIosBetaFallback — ${label}`, () => {
    const actual = mobile.selectIosBetaFallback(stable, ota, fallback);
    assert.equal(actual, accepted ? fallback : null);
  });
}

const iosClassCases = [
  ['beta indisponible sans OTA', '1.0', [], null, false, null],
  ['stable nulle garde deux entrées indisponibles', null, [], null, false, null],
  ['première OTA en avance est choisie selon ordre fourni', '1.0', [{ version: '1.3' }, { version: '1.4' }], null, true, '1.3'],
  ['OTA égale ne devient pas beta', '1.0', [{ version: '1.0' }], null, false, null],
  ['OTA inférieure ne devient pas beta', '1.0', [{ version: '0.9' }], null, false, null],
  ['OTA avec build conserve sa valeur', '1.0', [{ version: '1.1', build: 'b1' }], null, true, '1.1'],
  ['OTA avec commit conserve sa valeur', '1.0', [{ version: '1.1', commit: 'c1' }], null, true, '1.1'],
  ['fallback beta fourni quand OTA vide', '1.0', [], { version: '1.2' }, true, '1.2'],
  ['fallback source personnalisée conservée', '1.0', [], { version: '1.2', source: 'saved' }, true, '1.2'],
  ['fallback avec build conservé', '1.0', [], { version: '1.2', build: 'b2' }, true, '1.2'],
  ['OTA au-dessus prioritaire au fallback', '1.0', [{ version: '1.1' }], { version: '1.2' }, true, '1.1'],
  ['métadonnées store absentes normalisées', '1.0', [], null, false, null],
  ['liste OTA malformée normalisée vide', '1.0', {}, null, false, null],
  ['fallback égal stable non retenu', '1.0', [], { version: '1.0' }, false, null],
];
for (const [label, stable, ota, fallback, betaAvailable, betaVersion] of iosClassCases) {
  test(`classifyIosChannels — ${label}`, () => {
    const channels = mobile.classifyIosChannels(stable, null, ota, fallback);
    assert.equal(channels.length, 2);
    assert.equal(channels[0].version, stable);
    assert.equal(channels[0].available, !!stable);
    assert.equal(channels[1].available, betaAvailable);
    assert.equal(channels[1].version, betaVersion);
  });
}

const mkBuild = (major, track, minor) => `${String(major).padStart(3, '0')}${track}${String(minor).padStart(2, '0')}00000000`;
const androidCases = [
  ['stable de store sans OTA', '1.0', [], null, null, '1.0', null, null],
  ['absence de store et OTA', null, [], null, null, null, null, null],
  ['stable OTA seule', null, [{ version: '1.0', build: 'x' }], null, null, '1.0', null, null],
  ['beta externe déjà attribuée exclue de alpha inférée', '1.0', [{ version: '1.0' }, { version: '1.1' }], { version: '1.1' }, null, '1.0', '1.1', null],
  ['OTA identique au store complète build', '1.0', [{ version: '1.0', build: 'b' }], null, null, '1.0', null, null],
  ['OTA stable égale sélectionnée comme stable et metadata', '1.0', [{ version: '1.0', commit: 'c' }], null, null, '1.0', null, null],
  ['beta track décodé identifié', '1.0', [{ version: '1.0' }, { version: '1.1', build: mkBuild(1, 1, 1) }], null, null, '1.0', '1.1', null],
  ['alpha track décodé identifié', '1.0', [{ version: '1.0' }, { version: '1.1', build: mkBuild(1, 2, 1) }], null, null, '1.0', null, '1.1'],
  ['track dev ne se classe pas beta/alpha', '1.0', [{ version: '1.0' }, { version: '1.1', build: mkBuild(1, 3, 1) }], null, null, '1.0', null, '1.1'],
  ['beta miroir employée si aucun track beta', '1.0', [{ version: '1.0' }], { version: '1.2' }, null, '1.0', '1.2', null],
  ['alpha miroir employée si aucun track alpha', '1.0', [{ version: '1.0' }], null, { version: '1.2' }, '1.0', null, '1.2'],
  ['track OTA prime sur beta miroir', '1.0', [{ version: '1.0' }, { version: '1.1', build: mkBuild(1, 1, 1) }], { version: '1.2' }, null, '1.0', '1.1', null],
  ['track OTA prime sur alpha miroir', '1.0', [{ version: '1.0' }, { version: '1.1', build: mkBuild(1, 2, 1) }], null, { version: '1.2' }, '1.0', null, '1.1'],
  ['deux OTA en avance infèrent beta à la deuxième', '1.0', [{ version: '1.0' }, { version: '1.3' }, { version: '1.2' }], null, null, '1.0', '1.2', '1.3'],
  ['une seule OTA en avance sans track reste beta inconnue', '1.0', [{ version: '1.0' }, { version: '1.1' }], null, null, '1.0', null, '1.1'],
  ['aucune OTA en avance garde les deux tracks indisponibles', '1.0', [{ version: '1.0' }], null, null, '1.0', null, null],
  ['beta et alpha externes peuvent partager la version', '1.0', [{ version: '1.0' }], { version: '1.2' }, { version: '1.2' }, '1.0', '1.2', '1.2'],
  ['version alpha externe non liée à OTA', '1.0', [], null, { version: '1.4' }, '1.0', null, '1.4'],
  ['external beta possède un source personnalisé', '1.0', [], { version: '1.2', source: 'custom' }, null, '1.0', '1.2', null],
  ['métadonnées OTA récupérées par version miroir', '1.0', [{ version: '1.0' }, { version: '1.2' }, { version: '1.1', build: 'b', commit: 'c' }], { version: '1.1' }, null, '1.0', '1.1', '1.2'],
  ['store avec une version supérieure aux OTA', '1.3', [{ version: '1.2' }], null, null, '1.3', null, null],
  ['OTA majeure devant le store non utilisée sans track', '9.0', [{ version: '9.0' }, { version: '10.0' }], null, null, '9.0', null, '10.0'],
  ['stable OTA reçoit releaseName lorsqu’elle correspond', '1.0', [{ version: '1.0', releaseName: 'r' }], null, null, '1.0', null, null],
  ['version stable store garde la source store quand OTA identifie beta', '1.0', [{ version: '1.1', build: mkBuild(1, 1, 1) }], null, null, '1.0', '1.1', null],
];
for (const [label, store, ota, beta, alpha, stableExpected, betaExpected, alphaExpected] of androidCases) {
  test(`classifyAndroidChannels — ${label}`, () => {
    const channels = mobile.classifyAndroidChannels(store, ota, beta, alpha);
    const byName = Object.fromEntries(channels.map((c) => [c.channel, c]));
    assert.equal(byName.stable.version, stableExpected);
    assert.equal(byName.beta.version, betaExpected);
    assert.equal(byName.alpha.version, alphaExpected);
  });
}

const changeCases = [
  ['premier canal observé', [], { platform: 'ios', channel: 'stable', version: '1.0' }, 'new'],
  ['version supérieure met à jour', [{ platform: 'ios', channel: 'stable', version: '1.0' }], { platform: 'ios', channel: 'stable', version: '1.1' }, 'updated'],
  ['version égale ne change pas', [{ platform: 'ios', channel: 'stable', version: '1.0' }], { platform: 'ios', channel: 'stable', version: '1.0' }, null],
  ['version inférieure ne change pas', [{ platform: 'ios', channel: 'stable', version: '1.1' }], { platform: 'ios', channel: 'stable', version: '1.0' }, null],
  ['version inconnue est ignorée', [], { platform: 'ios', channel: 'stable', version: null }, null],
  ['canal stale ignoré', [{ platform: 'ios', channel: 'stable', version: '1.0' }], { platform: 'ios', channel: 'stable', version: '1.1', stale: true }, null],
  ['fingerprint notifié ignoré', [], { platform: 'ios', channel: 'stable', version: '1.0' }, null, ['ios|stable|1.0']],
  ['même version sur une autre plateforme est distincte', [{ platform: 'ios', channel: 'stable', version: '1.0' }], { platform: 'android', channel: 'stable', version: '1.0' }, 'new'],
  ['même plateforme autre canal distinct', [{ platform: 'android', channel: 'stable', version: '1.0' }], { platform: 'android', channel: 'beta', version: '1.0' }, 'new'],
  ['numérotation mineure comparée numériquement', [{ platform: 'android', channel: 'beta', version: '1.9' }], { platform: 'android', channel: 'beta', version: '1.10' }, 'updated'],
  ['priorité à la dernière entrée précédente du même canal', [{ platform: 'ios', channel: 'stable', version: '1.0' }, { platform: 'ios', channel: 'stable', version: '1.2' }], { platform: 'ios', channel: 'stable', version: '1.1' }, null],
  ['fingerprint de version différente reste éligible', [{ platform: 'ios', channel: 'stable', version: '1.0' }], { platform: 'ios', channel: 'stable', version: '1.1' }, 'updated', ['ios|stable|1.0']],
  ['canal précédent sans version traité nouveau', [{ platform: 'ios', channel: 'beta', version: null }], { platform: 'ios', channel: 'beta', version: '1.1' }, 'new'],
  ['version patch supérieure mise à jour', [{ platform: 'android', channel: 'alpha', version: '2.3.4' }], { platform: 'android', channel: 'alpha', version: '2.3.5' }, 'updated'],
  ['liste snapshot vide sans changement', [], null, null],
  ['fingerprint non correspondant ne masque pas une nouvelle version', [], { platform: 'ios', channel: 'stable', version: '1.0' }, 'new', ['ios|stable|0.9']],
];
for (const [label, prevChannels, channel, expectedType, fingerprints = []] of changeCases) {
  test(`detectChanges — ${label}`, () => {
    const result = mobile.detectChanges(
      { channels: prevChannels, notifiedFingerprints: fingerprints },
      { channels: channel ? [channel] : [] },
    );
    assert.equal(result.changes[0]?.type || null, expectedType);
    if (expectedType) assert.equal(result.changes.length, 1);
    else assert.equal(result.changes.length, 0);
  });
}

const preserveCases = [
  ['canal nul reprend la précédente version en stale', [{ platform: 'ios', channel: 'stable', version: '1.0' }], [{ platform: 'ios', channel: 'stable', version: null }], '1.0', 'No current version from available sources'],
  ['canal absent est réinséré en stale', [{ platform: 'ios', channel: 'beta', version: '1.1' }], [], '1.1', 'Channel missing from current source response'],
  ['version fraîche reste inchangée', [{ platform: 'ios', channel: 'stable', version: '1.0' }], [{ platform: 'ios', channel: 'stable', version: '1.2' }], '1.2', null],
  ['canal nouveau nul est conservé', [], [{ platform: 'android', channel: 'alpha', version: null }], null, null],
  ['canal précédent vide non réinséré', [{ platform: 'ios', channel: 'stable', version: null }], [], null, null],
  ['précédent sans tableau de canaux toléré', [], [{ platform: 'ios', channel: 'stable', version: null }], null, null],
  ['snapshot sans tableau reçoit une liste', [{ platform: 'ios', channel: 'stable', version: '1.0' }], null, '1.0', 'Channel missing from current source response'],
  ['platform différent ne reprend pas la valeur', [{ platform: 'ios', channel: 'stable', version: '1.0' }], [{ platform: 'android', channel: 'stable', version: null }], null, null],
  ['track différent ne reprend pas la valeur', [{ platform: 'android', channel: 'stable', version: '1.0' }], [{ platform: 'android', channel: 'beta', version: null }], null, null],
  ['plusieurs canaux absents sont tous reportés', [{ platform: 'ios', channel: 'stable', version: '1.0' }, { platform: 'android', channel: 'beta', version: '2.0' }], [], '1.0', 'Channel missing from current source response'],
];
for (const [label, previous, current, expectedVersion, expectedReason] of preserveCases) {
  test(`preserveUnavailableChannels — ${label}`, () => {
    const snapshot = { channels: current };
    const result = mobile.preserveUnavailableChannels({ channels: previous }, snapshot);
    assert.equal(result, snapshot);
    if (expectedVersion !== null) {
      const matching = snapshot.channels.find((c) => c.version === expectedVersion);
      assert.ok(matching);
      assert.equal(matching.staleReason || null, expectedReason);
      assert.equal(!!matching.stale, !!expectedReason);
    }
  });
}

const mergeCases = [
  ['deux objets vides', null, null, {}],
  ['sources concaténées sans écraser les anciennes', { sources: { a: 1 } }, { sources: { b: 2 } }, { a: 1, b: 2 }],
  ['android beta existante préservée si mise à jour nulle', { android: { beta: { version: '1.0' } } }, { android: { beta: null } }, { beta: '1.0' }],
  ['android alpha mise à jour valide', { android: { alpha: { version: '1.0' } } }, { android: { alpha: { version: '1.1' } } }, { alpha: '1.1' }],
  ['iOS beta plus récente remplace la précédente', { ios: { beta: { version: '1.0' } } }, { ios: { beta: { version: '1.1' } } }, { ios: '1.1' }],
  ['iOS beta plus ancienne ne fait pas régresser', { ios: { beta: { version: '1.1' } } }, { ios: { beta: { version: '1.0' } } }, { ios: '1.1' }],
  ['champs racine additionnels sont fusionnés', { updatedAt: 'old', marker: true }, { updatedAt: 'new' }, { updatedAt: 'new', marker: true }],
  ['update non objet ne remplace pas les tracks', { android: { beta: { version: '2.0' } } }, 'invalid', { beta: '2.0' }],
];
for (const [label, previous, update, expected] of mergeCases) {
  test(`mergeExternalVersionData — ${label}`, () => {
    const actual = mobile.mergeExternalVersionData(previous, update);
    if (expected.sources) assert.deepEqual(actual.sources, expected.sources);
    if (expected.beta) assert.equal(actual.android.beta.version, expected.beta);
    if (expected.alpha) assert.equal(actual.android.alpha.version, expected.alpha);
    if (expected.ios) assert.equal(actual.ios.beta.version, expected.ios);
    if (expected.updatedAt) assert.equal(actual.updatedAt, expected.updatedAt);
    if ('marker' in expected) assert.equal(actual.marker, expected.marker);
  });
}

const helperCases = [
  ['bumpKind traverse major', () => mobile.bumpKind('1.99', '2.0'), 'major'],
  ['bumpKind classe le bump positif intra-majeur', () => mobile.bumpKind('2.1', '2.2'), 'minor'],
  ['bumpKind ignore une régression', () => mobile.bumpKind('2.2', '2.1'), null],
  ['discordTime écarte une date invalide', () => mobile.discordTime('no-date'), null],
  ['discordTime produit les deux formats', () => mobile.discordTime('1970-01-01T00:00:01Z'), '<t:1:f> · <t:1:R>'],
  ['discordTime sans relatif', () => mobile.discordTime('1970-01-01T00:00:02Z', false), '<t:2:f>'],
  ['colorFor choisit accent alpha', () => mobile.colorFor('alpha'), 0xfee75c],
  ['trimText garde le texte court sans ellipse', () => mobile.trimText('  short  ', 20), 'short'],
];
for (const [label, fn, expected] of helperCases) {
  test(`helpers mobiles — ${label}`, () => assert.equal(fn(), expected));
}
