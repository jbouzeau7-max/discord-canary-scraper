/**
 * Extraction pure (sans I/O) du client mobile décompilé
 * (dépôt discord-mobile-datamining : discord_app / discord_common / _runtime).
 *
 *  - Expériences : objets `{ kind, name|id, label, defaultConfig, ... }`
 *    passés à createApexExperiment / createExperiment, avec variations
 *    (apex : `objN[1] = {...}`) ou treatments (legacy : `[{ id: 1, label }]`).
 *  - Strings : clés intl (hash 6 car.) réellement référencées par le code
 *    mobile (`util.t.XXXXXX`, `t["XXXXXX"]`). Les textes anglais compilés ne
 *    sont pas dans le dépôt : la valeur est résolue via les strings Canary.
 *  - Routes : `NAME: "/path"` + fonctions `NAME(a) { return "/x/" + a; }`.
 */
const { extractRoutes } = require('./extract');
const { inferType } = require('./infer_type');

const EXP_ID = '20[2-3]\\d-[0-1]\\d[_-][a-z0-9][a-z0-9_\\-]{2,90}';
const EXP_ID_RE = new RegExp(`^${EXP_ID}$`, 'i');

function isExpId(id) {
  if (typeof id !== 'string' || !EXP_ID_RE.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

/** Index de l'accolade fermante correspondant à `open` (ignore les chaînes). */
function matchBrace(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length && i < open + 20000; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Littéral objet JS simple → valeur JSON (clés non quotées). null si impossible. */
function parseJsLiteral(text) {
  if (typeof text !== 'string' || text.length > 4000) return null;
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    const json = t
      .replace(/'([^'\\]*)'/g, (_, s) => JSON.stringify(s))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*|\d+)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\bundefined\b/g, 'null');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readField(body, name) {
  const re = new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`);
  const m = body.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1][0] === "'" ? JSON.stringify(m[1].slice(1, -1)) : m[1]);
  } catch {
    return m[1].slice(1, -1);
  }
}

function readObjectField(src, body, bodyStart, name) {
  const re = new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*([{\\[])`);
  const m = re.exec(body);
  if (!m) return { value: null, ident: readIdentField(body, name) };
  const open = bodyStart + m.index + m[0].length - 1;
  const close = matchBrace(src, open);
  if (close < 0) return { value: null, ident: null };
  const text = src.slice(open, close + 1);
  return { value: parseJsLiteral(text), text, ident: null };
}

function readIdentField(body, name) {
  const m = body.match(new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*([A-Za-z_$][\\w$]*)\\b`));
  return m && m[1] !== 'null' && m[1] !== 'true' && m[1] !== 'false' ? m[1] : null;
}

/** Valeur d'une variable `const X = {...}` / `let X = [...]` dans le fichier. */
function resolveIdent(src, ident) {
  if (!ident) return null;
  const re = new RegExp(`(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\s*=\\s*([{\\[])`);
  const m = re.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(src, open);
  return close < 0 ? null : parseJsLiteral(src.slice(open, close + 1));
}

/**
 * Variations apex : `const obj2 = { 1: null, 2: null }; obj2[1] = {...};`
 * (ou `obj.variations = { 1: {...} }`). Renvoie { "1": {...}, ... }.
 */
function apexVariations(src, varsIdent, inlineValue) {
  const out = {};
  if (inlineValue && typeof inlineValue === 'object' && !Array.isArray(inlineValue)) {
    for (const [k, v] of Object.entries(inlineValue)) out[k] = v && typeof v === 'object' ? v : {};
  }
  if (!varsIdent) return Object.keys(out).length ? out : null;
  const esc = varsIdent.replace(/\$/g, '\\$');
  const init = resolveIdent(src, varsIdent);
  if (init && typeof init === 'object') for (const k of Object.keys(init)) if (!(k in out)) out[k] = {};
  const re = new RegExp(`\\b${esc}\\[(\\d+)\\]\\s*=\\s*`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[0].length;
    let val = {};
    if (src[at] === '{') {
      const close = matchBrace(src, at);
      if (close > 0) val = parseJsLiteral(src.slice(at, close + 1)) || {};
    }
    out[m[1]] = val;
  }
  return Object.keys(out).length ? out : null;
}

function legacyTreatments(src, ident, inlineValue) {
  const list = Array.isArray(inlineValue) ? inlineValue : resolveIdent(src, ident);
  if (!Array.isArray(list)) {
    // repli : lire les `{ id: N, label: "..." }` du tableau assigné
    if (!ident) return null;
    const m = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*\\[`).exec(src);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) return null;
    const txt = src.slice(open, close + 1);
    const out = [];
    const re = /\{\s*id:\s*(-?\d+)\s*,\s*label:\s*"((?:[^"\\]|\\.)*)"/g;
    let t;
    while ((t = re.exec(txt)) !== null) out.push({ id: Number(t[1]), label: t[2] });
    return out.length ? out : null;
  }
  return list
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({ id: t.id, label: t.label || null, ...(t.config ? { config: t.config } : {}) }));
}

/** Expériences structurées d'un fichier. */
function extractExperimentsFromSource(src, file = null) {
  const found = [];
  if (typeof src !== 'string' || !/20[2-3]\d-[0-1]\d/.test(src)) return found;
  const re = new RegExp(`(?:name|id)\\s*:\\s*["'](${EXP_ID})["']`, 'gi');
  let m;
  const seen = new Set();
  while ((m = re.exec(src)) !== null) {
    const id = m[1];
    if (!isExpId(id) || seen.has(id)) continue;
    // remonter à l'accolade ouvrante de l'objet englobant
    let open = -1;
    for (let i = m.index, depth = 0; i >= 0 && i > m.index - 600; i--) {
      const ch = src[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) { open = i; break; }
        depth--;
      }
    }
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open, close + 1);
    const kindRaw = readField(body, 'kind');
    if (kindRaw !== 'user' && kindRaw !== 'guild') continue;
    seen.add(id);
    const label = readField(body, 'label');
    const dc = readObjectField(src, body, open, 'defaultConfig');
    const defaultConfig = dc.value || (dc.ident ? resolveIdent(src, dc.ident) : null);
    const isApex = /createApexExperiment/.test(src) || /\bname\s*:/.test(body.slice(0, 200));
    const exp = {
      id,
      kind: kindRaw,
      type: kindRaw,
      system: isApex && !/\btreatments\s*:/.test(body) ? 'apex' : 'legacy',
      label: label || null,
      defaultConfig: defaultConfig && typeof defaultConfig === 'object' ? defaultConfig : null,
      source: 'mobile_files',
    };
    // variable de l'objet : `const obj = {` → `obj.variations = obj2`
    const decl = src.slice(Math.max(0, open - 60), open).match(/([A-Za-z_$][\w$]*)\s*=\s*$/);
    const objIdent = decl ? decl[1] : null;
    if (exp.system === 'legacy') {
      const tr = readObjectField(src, body, open, 'treatments');
      let ident = tr.ident;
      if (!tr.value && !ident && objIdent) {
        const a = src.match(new RegExp(`\\b${objIdent}\\.treatments\\s*=\\s*([A-Za-z_$][\\w$]*)`));
        ident = a ? a[1] : null;
      }
      const treatments = legacyTreatments(src, ident, tr.value);
      if (treatments) exp.treatments = treatments;
    } else {
      const vr = readObjectField(src, body, open, 'variations');
      let ident = vr.ident;
      if (!ident && objIdent) {
        const a = src.match(new RegExp(`\\b${objIdent}\\.variations\\s*=\\s*([A-Za-z_$][\\w$]*)`));
        ident = a ? a[1] : null;
      }
      const variations = apexVariations(src, ident, vr.value);
      if (variations) exp.variations = variations;
    }
    if (file) exp.file = file;
    found.push(exp);
  }
  return found;
}

/** Identifiants d'expériences cités hors objet structuré (repli). */
function extractLooseExperimentIds(src) {
  const out = new Set();
  const re = new RegExp(`["'](${EXP_ID})["']`, 'gi');
  let m;
  while ((m = re.exec(src)) !== null) if (isExpId(m[1])) out.add(m[1]);
  return out;
}

const STRING_KEY_RES = [
  /\b(?:t|intlMessages|messages)\.([A-Za-z0-9_$]{6})\b/g,
  /\b(?:t|intlMessages|messages)\[\s*["']([A-Za-z0-9+/_$-]{6})["']\s*\]/g,
];

/** Clés intl utilisées par le code (hash de 6 caractères). */
function extractStringKeys(src, out = new Set()) {
  if (typeof src !== 'string') return out;
  for (const re of STRING_KEY_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const k = m[1];
      if (/^[a-z]+$/.test(k) || /^[A-Z_]+$/.test(k) || /^\d+$/.test(k)) continue; // mots/consts, pas des hash
      out.add(k);
    }
  }
  return out;
}

/** `"/x/" + a + "/y"` → "/x/:param/y". */
function exprToPath(expr) {
  const parts = String(expr).split(/\s*\+\s*/);
  let out = '';
  for (const p of parts) {
    const lit = p.match(/^["'`]([^"'`]*)["'`]$/);
    if (lit) out += lit[1];
    else out += ':param';
  }
  if (!out.startsWith('/')) return null;
  out = out.replace(/(:param)+/g, ':param');
  return /^\/[A-Za-z0-9_\-./@:?=&%]*$/.test(out) && out.length <= 300 ? out : null;
}

/** Routes/endpoints : littéraux + fonctions retournant un chemin. */
function extractMobileRoutes(src, out = {}) {
  if (typeof src !== 'string') return out;
  // Fonctions d'abord : `NAME(a) { return "/x/" + a; }` → "/x/:param"
  // (sinon le littéral partiel "/x/" était retenu par extractRoutes).
  const re = /\b([A-Z][A-Z0-9_]{2,100})(?:\s*=\s*function\s+[\w$]*)?\s*\(([^()]*)\)\s*\{\s*return\s+([^;{}]+);\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const p = exprToPath(m[3].trim());
    if (p && out[m[1]] === undefined) out[m[1]] = p;
  }
  const lit = {};
  extractRoutes(src, lit);
  for (const [k, v] of Object.entries(lit)) if (out[k] === undefined) out[k] = v;
  return out;
}

/**
 * Scan complet d'une liste de contenus { file, content }.
 * @returns {{experiments:object[], stringKeys:Set<string>, routes:object}}
 */
function scanContents(items) {
  const exps = new Map();
  const loose = new Set();
  const stringKeys = new Set();
  const routes = {};
  for (const { file, content } of items) {
    if (!content) continue;
    for (const e of extractExperimentsFromSource(content, file)) if (!exps.has(e.id)) exps.set(e.id, e);
    for (const id of extractLooseExperimentIds(content)) loose.add(id);
    extractStringKeys(content, stringKeys);
    extractMobileRoutes(content, routes);
  }
  for (const id of loose) {
    if (exps.has(id)) continue;
    const t = inferType(id);
    exps.set(id, { id, kind: t, type: t, system: 'unknown', label: null, source: 'mobile_files_ref' });
  }
  const sortedRoutes = {};
  for (const k of Object.keys(routes).sort()) sortedRoutes[k] = routes[k];
  return {
    experiments: [...exps.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stringKeys,
    routes: sortedRoutes,
  };
}

/** Map clé → texte (Canary si connu, sinon la clé elle-même). */
function resolveStrings(keys, dictionary) {
  const dict = dictionary && typeof dictionary === 'object' ? dictionary : {};
  const out = {};
  for (const k of [...keys].sort()) {
    out[k] = Object.prototype.hasOwnProperty.call(dict, k) && typeof dict[k] === 'string' ? dict[k] : `[${k}]`;
  }
  return out;
}

module.exports = {
  isExpId,
  matchBrace,
  parseJsLiteral,
  extractExperimentsFromSource,
  extractLooseExperimentIds,
  extractStringKeys,
  extractMobileRoutes,
  exprToPath,
  scanContents,
  resolveStrings,
};
