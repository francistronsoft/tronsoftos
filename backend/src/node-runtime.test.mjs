import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;

test('host and containers use patched runtime without changing Debian base', () => {
  for (const name of ['backend', 'worker']) {
    assert.match(read(`apps/tronfire/${name}/Dockerfile`), /FROM node:22\.23\.4-bookworm-slim/);
  }
  const installer = read('install.sh');
  assert.match(installer, /ensure_node_runtime\nhash -r/);
  assert.doesNotMatch(installer, /base_packages\+=\(nodejs npm\)/);
  assert.match(read('scripts/node-runtime.sh'), /sha256sum --check/);
});

test('runtime version policy rejects vulnerable, EOL and malformed versions', { skip: !hasBash }, () => {
  const script = fileURLToPath(new URL('scripts/node-runtime.sh', root));
  for (const [version, expected] of [
    ['v12.22.12', false], ['v20.19.2', false], ['v22.23.3', false],
    ['v22.23.4', true], ['v22.24.0', true], ['v24.22.0', false],
    ['v24.22.1', true], ['v26.12.0', false], ['v26.12.1', true],
    ['v28.0.0', false], ['', false], ['v22.23.4-rc.1', false],
  ]) {
    const result = spawnSync('bash', ['-c', 'source "$1"; node_runtime_supported "$2"', 'test', script, version]);
    assert.equal(result.status === 0, expected, version);
  }
});

test('offline rejects vulnerable runtime before any network or filesystem mutation', { skip: !hasBash }, () => {
  const script = fileURLToPath(new URL('scripts/node-runtime.sh', root));
  const result = spawnSync('bash', ['-c', `source "$1"; node() { echo v20.19.2; }; export TRONSOFTOS_OFFLINE=true; ensure_node_runtime`, 'test', script]);
  assert.equal(result.status, 2);
  assert.match(result.stderr.toString(), /atualize o kit offline/);
});

test('patched offline runtime is retained without downloads', { skip: !hasBash }, () => {
  const script = fileURLToPath(new URL('scripts/node-runtime.sh', root));
  const result = spawnSync('bash', ['-c', `source "$1"; node() { echo v22.23.4; }; curl() { exit 99; }; export TRONSOFTOS_OFFLINE=true; ensure_node_runtime`, 'test', script]);
  assert.equal(result.status, 0);
});

test('corrupt archive fails verification before extraction or activation', { skip: !hasBash }, () => {
  const script = fileURLToPath(new URL('scripts/node-runtime.sh', root));
  const result = spawnSync('bash', ['-c', `
    export LC_ALL=C
    source "$1"
    node() { echo v20.19.2; }
    dpkg() { echo amd64; }
    mktemp() { command mktemp -d; }
    curl() { printf bad > "\${@: -1}"; }
    tar() { echo UNSAFE_EXTRACTION >&2; exit 99; }
    mv() { echo UNSAFE_ACTIVATION >&2; exit 99; }
    export TRONSOFTOS_OFFLINE=false
    ensure_node_runtime
  `, 'test', script]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /checksum did NOT match/);
  assert.doesNotMatch(result.stderr.toString(), /UNSAFE_/);
});
