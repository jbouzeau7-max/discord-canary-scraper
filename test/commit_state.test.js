'use strict';

/**
 * Test d'intégration de scripts/commit-state.sh avec de vrais dépôts git temporaires.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'commit-state.sh');

function sh(cwd, cmd, env = {}) {
  return execFileSync('bash', ['-c', cmd], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(cwd, cmd, env = {}) {
  return spawnSync('bash', ['-c', cmd], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8',
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-state-'));
  const cfg = 'git config user.name t && git config user.email t@t';
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git a 2>/dev/null');
  const a = path.join(root, 'a');
  sh(a, `${cfg} && mkdir -p data builds/1 && echo '{"v":0}' > data/s.json && echo base > other.txt && echo 1 > builds/1/f && git add . && git commit -qm init && git push -q origin HEAD:main`);
  sh(root, 'git clone -q origin.git b');
  const b = path.join(root, 'b');
  sh(b, cfg);
  return { a, b };
}

test('aucun changement → exit 0 sans commit', () => {
  const { a } = setup();
  const out = sh(a, `${SCRIPT} "noop" data/s.json`);
  assert.match(out, /aucun changement/);
});

test('push simple + suppression dans un dossier', () => {
  const { a, b } = setup();
  sh(a, `echo '{"v":1}' > data/s.json && rm -rf builds/1 && mkdir -p builds/2 && echo 2 > builds/2/f`);
  sh(a, `${SCRIPT} "state" data/s.json builds`);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":1}');
  assert.ok(!fs.existsSync(path.join(b, 'builds/1')));
  assert.ok(fs.existsSync(path.join(b, 'builds/2/f')));
});

test('ne commit que le périmètre demandé et préserve les chemins déjà staged', () => {
  const { a } = setup();
  sh(a, `echo staged > unrelated.txt && git add unrelated.txt && echo '{"v":1}' > data/state.json`);

  const output = sh(a, `${SCRIPT} "state" data/state.json`);
  assert.match(output, /push OK/);
  assert.deepEqual(
    sh(a, 'git diff-tree --no-commit-id --name-only -r HEAD').trim().split('\n'),
    ['data/state.json'],
  );
  assert.deepEqual(
    sh(a, 'git diff --cached HEAD^ --name-only').trim().split('\n'),
    ['unrelated.txt'],
  );
  assert.equal(sh(a, 'git show :unrelated.txt').trim(), 'staged');
});

test('réindexe une écriture tardive dans un fichier du périmètre', () => {
  const { a, b } = setup();
  const hook = path.join(a, '.git', 'hooks', 'pre-commit');
  const marker = path.join(a, '.git', 'late-write-done');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${marker}" ]; then\n  : > "${marker}"\n  printf '{"v":2}\\n' > data/s.json\nfi\n`);
  fs.chmodSync(hook, 0o755);
  sh(a, `echo '{"v":1}' > data/s.json`);

  const output = sh(a, `${SCRIPT} "state" data/s.json`);
  assert.match(output, /push OK/);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":2}');
});

test('autostash permet le rebase si un fichier hors périmètre reste unstaged', () => {
  const { a, b } = setup();
  const hook = path.join(a, '.git', 'hooks', 'pre-commit');
  const marker = path.join(a, '.git', 'late-write-done');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${marker}" ]; then\n  : > "${marker}"\n  echo late > other.txt\nfi\n`);
  fs.chmodSync(hook, 0o755);
  sh(a, `echo '{"v":1}' > data/s.json`);

  const output = sh(a, `${SCRIPT} "state" data/s.json`);
  assert.match(output, /push OK/);
  assert.equal(fs.readFileSync(path.join(a, 'other.txt'), 'utf8').trim(), 'late');
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":1}');
  assert.equal(fs.readFileSync(path.join(b, 'other.txt'), 'utf8').trim(), 'base');
});

test('conflit sur le même fichier : échec fermé, état distant conservé', () => {
  const { a, b } = setup();
  const recoveryPatch = path.join(path.dirname(a), 'recovery.patch');
  sh(b, `echo '{"v":"remote"}' > data/s.json && echo remote > other.txt && git commit -qam remote && git push -q`);
  sh(a, `echo '{"v":"local"}' > data/s.json`);
  const result = run(a, `${SCRIPT} "state" data/s.json`, {
    COMMIT_RECOVERY_PATCH: recoveryPatch,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /conflit/i);
  assert.match(result.stdout + result.stderr, /data\/s\.json/);
  assert.ok(fs.existsSync(recoveryPatch), 'le commit local doit laisser un patch récupérable');
  assert.match(fs.readFileSync(recoveryPatch, 'utf8'), /"local"/);
  assert.equal(fs.readFileSync(path.join(a, 'data/s.json'), 'utf8').trim(), '{"v":"local"}');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":"remote"}');
  assert.equal(fs.readFileSync(path.join(b, 'other.txt'), 'utf8').trim(), 'remote');
});

test('conflit avec un chemin dossier : ne supprime jamais un fichier distant ajouté', () => {
  const { a, b } = setup();
  sh(b, `echo '{"v":"remote"}' > data/s.json && echo remote > data/remote.json && git add data && git commit -qm remote && git push -q`);
  sh(a, `echo '{"v":"local"}' > data/s.json && echo local > data/local.json`);
  const result = run(a, `${SCRIPT} "state" data`);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /conflit/i);
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":"remote"}');
  assert.equal(fs.readFileSync(path.join(b, 'data/remote.json'), 'utf8').trim(), 'remote');
  assert.ok(!fs.existsSync(path.join(b, 'data/local.json')));
});

test('commit concurrent sur un autre fichier → simple rebase', () => {
  const { a, b } = setup();
  sh(b, `echo remote > other.txt && git commit -qam remote && git push -q`);
  sh(a, `echo '{"v":2}' > data/s.json`);
  sh(a, `${SCRIPT} "state" data/s.json`);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'other.txt'), 'utf8').trim(), 'remote');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":2}');
});

test('les workflows n’ignorent pas les échecs de persistance d’état', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!source.includes('scripts/commit-state.sh')) continue;
    assert.ok(!source.includes('COMMIT_SOFT_FAIL'), `${file} ne doit pas masquer un conflit`);
    assert.doesNotMatch(source, /^\s+env:\s*\n\s+run:/m, `${file} ne doit pas contenir un env vide`);
    for (const line of source.split('\n').filter((row) => row.includes('scripts/commit-state.sh'))) {
      assert.ok(!line.includes('|| true'), `${file} ne doit pas ignorer l'échec de commit-state`);
    }
  }
  const scrape = fs.readFileSync(path.join(dir, 'scrape.yml'), 'utf8');
  assert.match(scrape, /COMMIT_RECOVERY_PATCH:/);
  // Version tolérante : dependabot met les actions à jour, l'important est
  // que l'artefact de récupération d'état reste uploadé.
  assert.match(scrape, /actions\/upload-artifact@v\d+/);
  assert.match(scrape, /scrape-state-recovery-\$\{\{ github\.run_id \}\}/);
  assert.match(scrape, /scrape-state-recovery\.patch\*/);
});
