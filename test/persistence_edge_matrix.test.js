'use strict';

/**
 * Matrice de fiabilité pour les primitives locales de persistence.
 * Tous les fichiers temporaires sont créés sous os.tmpdir() puis supprimés;
 * aucune connexion réseau, attente ou mutation de données du dépôt n'est faite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { writeJsonAtomic, writeFileAtomic, envInt } = require('../src/lib/atomic');

async function inTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistence-edge-'));
  try {
    await fn(dir);
  } finally {
    await fs.remove(dir);
  }
}

function envCase(name, raw, expected, { fallback = 5, min = 1, max = 10 } = {}) {
  test(`envInt — ${name}`, () => {
    const key = 'PERSISTENCE_EDGE_MATRIX_ENV_INT';
    const previous = process.env[key];
    try {
      if (raw === undefined) delete process.env[key];
      else process.env[key] = raw;
      assert.equal(envInt(key, fallback, min, max), expected);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
}

const envCases = [
  ['variable absente utilise le fallback', undefined, 5],
  ['chaîne vide utilise le fallback', '', 5],
  ['entier au-dessus du maximum', '42', 10],
  ['entier négatif sous le minimum', '-3', 1],
  ['texte alphabétique invalide', 'abc', 5],
  ['fraction décimale invalide', '2.5', 5],
  ['zéro est borné au minimum', '0', 1],
  ['minimum exact', '1', 1],
  ['maximum exact', '10', 10],
  ['valeur juste au-dessus du maximum', '11', 10],
  ['valeur juste sous le minimum', '-1', 1],
  ['espaces autour d’un entier', ' 7 ', 7],
  ['espaces seuls se convertissent en zéro puis sont bornés', '   ', 1],
  ['signe plus explicite', '+7', 7],
  ['zéros initiaux', '007', 7],
  ['notation scientifique entière', '1e1', 10],
  ['exposant négatif zéro', '1e-0', 1],
  ['notation hexadécimale valide', '0x10', 10],
  ['notation binaire valide', '0b10', 2],
  ['notation octale valide', '0o10', 8],
  ['Infinity textuel non fini', 'Infinity', 5],
  ['moins Infinity textuel non fini', '-Infinity', 5],
  ['NaN textuel', 'NaN', 5],
  ['séparateur numérique interdit', '1_000', 5],
  ['préfixe hexadécimal incomplet', '0x', 5],
  ['chiffre binaire invalide', '0b2', 5],
  ['décimal avec fraction nulle', '01.0', 1],
  ['fraction avec zéros décimaux', '3.000', 3],
  ['fraction non entière', '3.1', 5],
  ['débordement positif converti en infini', '1e309', 5],
  ['débordement négatif converti en infini', '-1e309', 5],
  ['sous-débordement arrondi à zéro', '1e-999', 1],
  ['espaces ASCII autour du nombre', '\n4\t', 4],
  ['signe moins de zéro borné', '-0', 1],
  ['signe plus de zéro borné', '+0', 1],
  ['signe plus précédé d’espaces', '  +5', 5],
  ['espace final', '5 ', 5],
  ['décimale terminée par zéro', '5.0', 5],
  ['notation scientifique de cinq', '5e0', 5],
  ['zéro décimal borné', '0.0', 1],
  ['petite fraction reste invalide', '0.1', 5],
  ['fraction proche du maximum reste invalide', '9.999', 5],
  ['maximum en notation décimale', '10.0', 10],
  ['fraction après maximum est invalide', '10.1', 5],
  ['puissance entière au-dessus du maximum', '1e2', 10],
  ['puissance négative sous le minimum', '-1e2', 1],
  ['nombre entier avec nombreux zéros initiaux', '00000000000000000002', 2],
  ['exposant positif explicite', '2e+0', 2],
  ['tabulation et espaces internes valides aux bords', '\t 8 \n', 8],
  ['fallback personnalisé conservé pour une valeur invalide', 'invalid', 17, { fallback: 17, min: 2, max: 6 }],
];
for (const [name, raw, expected, options] of envCases) envCase(name, raw, expected, options);

const jsonValues = [
  ['null JSON', null],
  ['booléen vrai', true],
  ['booléen faux', false],
  ['zéro', 0],
  ['entier négatif', -37],
  ['entier supérieur à la précision sûre', Number.MAX_SAFE_INTEGER + 1],
  ['fraction négative finie', -12.75],
  ['plus petit nombre normalisé positif', Number.MIN_VALUE],
  ['valeur maximale finie', Number.MAX_VALUE],
  ['chaîne vide', ''],
  ['chaîne Unicode multilingue', 'été — 東京 — مرحبا — 🙂'],
  ['chaîne contenant guillemets et antislash', 'citation: "oui"\\non'],
  ['chaîne avec retours de ligne', 'ligne 1\nligne 2\r\nfin'],
  ['chaîne contenant caractères de contrôle', '\u0000\u0001\t'],
  ['chaîne ressemblant à du JSON', '{"x":[1,true,null]}'],
  ['tableau vide', []],
  ['tableau contenant des valeurs JSON primitives', [null, true, false, 0, 'x']],
  ['tableau imbriqué rectangulaire', [[1, 2], [3, 4]]],
  ['tableau imbriqué irrégulier', [[], [1], [2, [3, 4]]]],
  ['tableau de chaînes Unicode', ['é', '漢字', '🧭']],
  ['objet vide', {}],
  ['objet à un champ', { enabled: true }],
  ['objet imbriqué à plusieurs niveaux', { a: { b: { c: 3 } } }],
  ['objet avec tableau et null', { rows: [1, null, { ok: false }] }],
  ['clés contenant espaces et ponctuation', { 'a b': 1, 'x/y': 2, 'q"': 3 }],
  ['clé spéciale __proto__ conservée comme donnée', JSON.parse('{"__proto__":{"safe":true},"constructor":4}')],
  ['objet avec propriété Unicode', { 'clé-é': 'valeur-漢' }],
  ['valeurs numériques zéro signées sérialisées', [-0, 0]],
  ['NaN sérialisé en null selon JSON', NaN],
  ['Infinity sérialisé en null selon JSON', Infinity],
  ['tableau comportant trous sérialisés en null', [1, , 3]],
  ['propriété undefined omise par JSON', { kept: 1, omitted: undefined }],
  ['Date sérialisée en chaîne ISO', new Date('2024-02-29T12:34:56.789Z')],
  ['Buffer sérialisé selon sa représentation JSON', Buffer.from([0, 127, 255])],
  ['Map sérialisée en objet JSON vide', new Map([['k', 1]])],
  ['Set sérialisé en tableau vide', new Set([1, 2])],
  ['RegExp sérialisée en objet vide', /ab+c/gi],
  ['objet avec toJSON personnalisé', { value: 1, toJSON() { return { replaced: 'yes' }; } }],
  ['tableau de grandeurs distinctes', [1, 10, 100, 1000, 10000]],
  ['objet comportant une chaîne volumineuse', { payload: 'p'.repeat(8192) }],
];
for (const [name, value] of jsonValues) {
  test(`writeJsonAtomic — ${name}`, async () => inTempDir(async (dir) => {
    const file = path.join(dir, 'nested', 'state.json');
    await writeJsonAtomic(file, value);
    const expected = JSON.parse(JSON.stringify(value));
    assert.deepEqual(await fs.readJson(file), expected);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((x) => x.includes('.tmp-')), []);
  }));
}

const jsonPolicies = [
  ['indentation par défaut sur objet', { a: 1 }, undefined, /\n  "a": 1\n/],
  ['indentation zéro compacte', { a: 1 }, 0, /^\{"a":1\}\n$/],
  ['indentation d’un espace', { a: 1 }, 1, /\n "a": 1\n/],
  ['indentation de quatre espaces', { a: 1 }, 4, /\n    "a": 1\n/],
  ['espaces null utilise l’écriture fs-extra sans option d’indentation', { a: 1 }, null, /^\{"a":1\}\n$/],
  ['espaces définis à deux', [1, 2], 2, /\n  1,\n  2\n/],
  ['écrasement atomique du contenu existant', { new: 2 }, undefined, null],
  ['valeur BigInt rejetée sans altérer la destination', { value: 1n }, undefined, null],
  ['échec avec BigInt ne laisse pas de temporaire', { value: 1n }, undefined, null],
  ['chemin relatif avec sous-dossiers créés', { relative: true }, undefined, null],
  ['nom de destination contenant des espaces', { space: true }, undefined, null],
  ['tableau JSON vide au chemin existant', [], undefined, null],
];
for (const [name, value, spaces, pattern] of jsonPolicies) {
  test(`writeJsonAtomic — politique: ${name}`, async () => inTempDir(async (dir) => {
    const file = name === 'chemin relatif avec sous-dossiers créés'
      ? path.join(dir, 'one', 'two', 'state.json')
      : path.join(dir, name === 'nom de destination contenant des espaces' ? 'state with spaces.json' : 'state.json');
    const isFailure = name.startsWith('échec') || name.startsWith('valeur BigInt');
    if (name === 'écrasement atomique du contenu existant' || isFailure) {
      await writeJsonAtomic(file, { original: true });
    }
    if (isFailure) {
      await assert.rejects(() => writeJsonAtomic(file, value, spaces));
      assert.deepEqual(await fs.readJson(file), { original: true });
    } else {
      await writeJsonAtomic(file, value, spaces);
      if (pattern) assert.match(await fs.readFile(file, 'utf8'), pattern);
      if (name === 'écrasement atomique du contenu existant') assert.deepEqual(await fs.readJson(file), value);
    }
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((x) => x.includes('.tmp-')), []);
  }));
}

const filePayloads = [
  ['buffer vide', Buffer.alloc(0)],
  ['un octet nul', Buffer.from([0])],
  ['un octet maximum', Buffer.from([255])],
  ['octets couvrant les limites binaires', Buffer.from([0, 1, 127, 128, 254, 255])],
  ['séquence contenant plusieurs octets nuls', Buffer.from([0, 0, 0, 1, 0])],
  ['texte ASCII minimal', Buffer.from('x')],
  ['texte ASCII avec espaces', Buffer.from('  persist  ')],
  ['texte UTF-8 accentué', Buffer.from('crème brûlée', 'utf8')],
  ['texte UTF-8 CJK', Buffer.from('保存状態', 'utf8')],
  ['texte UTF-8 emoji', Buffer.from('🧪🧭🛠️', 'utf8')],
  ['texte avec LF', Buffer.from('a\nb\n', 'utf8')],
  ['texte avec CRLF', Buffer.from('a\r\nb\r\n', 'utf8')],
  ['texte sans saut final', Buffer.from('last line', 'utf8')],
  ['guillemets et antislash bruts', Buffer.from('"quoted"\\path', 'utf8')],
  ['octets arbitraires au milieu du flux', Buffer.from([12, 34, 56, 78, 90])],
  ['payload de 256 octets déterministe', Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
  ['payload de 4096 octets répétitifs', Buffer.alloc(4096, 0xa5)],
  ['payload de 65536 octets déterministe', Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251))],
  ['chaîne vide native', ''],
  ['chaîne Unicode native', 'état prêt — 🟢'],
  ['chaîne native avec NUL', 'avant\u0000après'],
  ['Uint8Array', new Uint8Array([3, 1, 4, 1, 5])],
  ['Uint8Array sous-vue avec offsets', new Uint8Array([90, 8, 6, 7, 90]).subarray(1, 4)],
  ['Int8Array transmise comme tableau typé', new Int8Array([-1, 0, 1, 127])],
  ['Uint16Array encodée selon sa représentation mémoire', new Uint16Array([1, 513, 65535])],
  ['DataView sur une fenêtre de buffer', new DataView(Uint8Array.from([9, 8, 7, 6]).buffer, 1, 2)],
  ['Buffer créé à partir de base64', Buffer.from('AP+A/w==', 'base64')],
  ['Buffer créé à partir de hexadécimal', Buffer.from('deadbeef', 'hex')],
  ['UTF-8 incluant un caractère combiné', Buffer.from('e\u0301', 'utf8')],
  ['caractères ASCII de contrôle', Buffer.from('\t\n\r\u0000', 'utf8')],
  ['chaîne avec plusieurs séparateurs de ligne', 'a\nb\rc\r\nd'],
  ['long texte répétitif', 'reliable-state/'.repeat(1024)],
  ['buffer avec signature binaire', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['payload intégral constitué de zéros', Buffer.alloc(128)],
  ['payload alternant tous les bits', Buffer.from([0x55, 0xaa, 0x55, 0xaa])],
  ['fichier terminé par un octet nul', Buffer.from([65, 66, 0])],
  ['séquence UTF-8 avec plusieurs scripts', Buffer.from('éλληνικά-日本語-العربية', 'utf8')],
  ['retours et tabulations dans une chaîne native', 'x\t\r\ny'],
];
for (const [name, payload] of filePayloads) {
  test(`writeFileAtomic — ${name}`, async () => inTempDir(async (dir) => {
    const file = path.join(dir, 'payload.bin');
    await writeFileAtomic(file, payload);
    const actual = await fs.readFile(file);
    const expected = typeof payload === 'string'
      ? Buffer.from(payload)
      : Buffer.from(payload.buffer || payload, payload.byteOffset || 0, payload.byteLength);
    assert.deepEqual(actual, expected);
    assert.deepEqual((await fs.readdir(dir)).filter((x) => x.includes('.tmp-')), []);
  }));
}

const filePolicies = [
  ['crée plusieurs niveaux de dossier', 'a/b/c/data.bin', Buffer.from('nested')],
  ['écrase le fichier existant sans suffixe résiduel', 'state.bin', Buffer.from('replacement')],
  ['remplace une seconde fois le même chemin', 'state.bin', Buffer.from([9, 8, 7])],
  ['chemin avec espaces et accents', 'données locales/état final.bin', Buffer.from('ok')],
  ['nom de fichier commençant par un point', '.hidden-state', Buffer.from('hidden')],
  ['destination sans extension', 'snapshot', Buffer.from('snapshot')],
  ['nom de destination avec plusieurs points', 'state.backup.json.bin', Buffer.from('bytes')],
  ['remplace le lien symbolique sans modifier sa cible', 'link.bin', Buffer.from('new target')],
  ['entrée invalide BigInt échoue et nettoie le temporaire', 'bad.bin', 1n],
  ['entrée invalide objet échoue et nettoie le temporaire', 'bad.bin', { bytes: true }],
  ['destination répertoire provoque un échec propre', 'existing-directory', Buffer.from('cannot replace directory')],
  ['parent existant comme fichier échoue avant écriture', 'parent/child.bin', Buffer.from('blocked')],
  ['remplacement conserve exactement les octets non UTF-8', 'existing.bin', Buffer.from([0, 255, 1])],
  ['fichier dans répertoire courant temporaire isolé', 'local.bin', Buffer.from('local')],
];
for (const [name, relative, payload] of filePolicies) {
  test(`writeFileAtomic — frontière: ${name}`, async () => inTempDir(async (dir) => {
    const file = path.join(dir, relative);
    const invalid = name.startsWith('entrée invalide');
    const directoryTarget = name.startsWith('destination répertoire');
    const blockedParent = name.startsWith('parent existant');
    if (name.startsWith('écrase') || name.startsWith('remplace une seconde') || name.startsWith('remplacement conserve')) {
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, 'old content');
    } else if (directoryTarget) {
      await fs.ensureDir(file);
    } else if (blockedParent) {
      await fs.writeFile(path.join(dir, 'parent'), 'not a directory');
    } else if (name.startsWith('remplace le lien')) {
      const target = path.join(dir, 'real-target.bin');
      await fs.writeFile(target, 'original target');
      await fs.symlink(target, file);
    }
    if (invalid || directoryTarget || blockedParent) {
      await assert.rejects(() => writeFileAtomic(file, payload));
      if (invalid) {
        assert.equal(await fs.pathExists(file), false);
        assert.deepEqual((await fs.readdir(dir)).filter((x) => x.includes('.tmp-')), []);
      }
      if (blockedParent) assert.equal(await fs.readFile(path.join(dir, 'parent'), 'utf8'), 'not a directory');
    } else {
      await writeFileAtomic(file, payload);
      if (name.startsWith('remplace le lien')) {
        assert.equal(await fs.readFile(file, 'utf8'), 'new target');
        assert.equal(await fs.readFile(path.join(dir, 'real-target.bin'), 'utf8'), 'original target');
        assert.equal((await fs.lstat(file)).isFile(), true);
      } else {
        const expected = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        assert.deepEqual(await fs.readFile(file), expected);
      }
    }
    if (!directoryTarget && !blockedParent) {
      const parent = path.dirname(file);
      if (await fs.pathExists(parent) && (await fs.stat(parent)).isDirectory()) {
        assert.deepEqual((await fs.readdir(parent)).filter((x) => x.includes('.tmp-')), []);
      }
    }
  }));
}

assert.equal(envCases.length + jsonValues.length + jsonPolicies.length + filePayloads.length + filePolicies.length, 154,
  'La matrice doit déclarer exactement 154 tests');
