import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const wizard = fs.readFileSync(path.join(root, 'scripts/configure-wizard.sh'), 'utf8');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('offline mode requires precompiled UI and never builds or pulls containers', () => {
  assert.match(install, /TRONSOFTOS_OFFLINE[^\n]*true.*TRONSOFTOS_SKIP_FRONTEND_BUILD/);
  assert.match(install, /compose_up_flags=\(--no-build --pull never\)/);
  assert.match(install, /up -d "\$\{compose_up_flags\[@\]\}"/);
});

test('offline mode prevents asset downloads and registry authentication', () => {
  assert.match(source('apps/tronfire/scripts/install-assets.sh'), /Arquivo obrigatorio ausente no pacote offline/);
  assert.ok(wizard.indexOf('Instalacao offline: credenciais') < wizard.indexOf('Baixando credenciais privadas'));
  assert.match(wizard, /TRONSOFTOS_OFFLINE[^\n]*!= true.*GHCR_USER/);
});

test('offline APT uses only local indexes and cached packages', { skip: process.platform !== 'linux' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-apt-test-'));
  try {
    const list = path.join(temporary, 'offline.list');
    fs.writeFileSync(list, 'deb [trusted=yes] file:/test ./\n');
    const output = execFileSync('bash', ['-c', `set -euo pipefail; . "$1"; apt-get() { printf '%s\\n' "$@"; }; offline_apt_get install -y git`, 'test', path.join(root, 'scripts/offline-support.sh')], { env: { ...process.env, TRONSOFTOS_OFFLINE_APT_LIST: list, TRONSOFTOS_OFFLINE_PACKAGES: temporary }, encoding: 'utf8' });
    assert.match(output, /Dir::Etc::sourceparts=-/);
    assert.match(output, /--no-download/);
    assert.match(output, /Dir::Cache::archives=/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
