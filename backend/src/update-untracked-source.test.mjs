import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../../scripts/update-tronsoftos.sh', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('backup_conflicting_untracked_source()'), source.indexOf('case "$BRANCH" in'));
const enabled = process.platform === 'linux';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-untracked-'));
  const repo = path.join(dir, 'app'), storage = path.join(dir, 'storage');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@local.test', ...args], { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init');
  fs.writeFileSync(path.join(repo, 'VERSION'), 'old'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const write = (file, data) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), data); };
  const incoming = file => {
    write(file, 'upstream'); git('add', file); git('commit', '-m', 'upstream');
    const next = git('rev-parse', 'HEAD'); git('checkout', '--detach', base); return next;
  };
  const run = ref => execFileSync('bash', ['-c', `set -euo pipefail\nlog() { :; }\n${helper}\nbackup_conflicting_untracked_source "$INCOMING"`], {
    cwd: repo, env: { ...process.env, APP_DIR: repo, STORAGE_ROOT: storage, INCOMING: ref }, stdio: 'pipe'
  });
  return { dir, repo, storage, git, write, incoming, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('updater preserves only colliding untracked source before fast-forward', { skip: !enabled }, () => {
  const f = fixture();
  try {
    const ref = f.incoming('backend/src/kds-proxy.mjs');
    f.write('backend/src/kds-proxy.mjs', 'manual patch');
    f.write('state/token', 'preserve'); f.write('backend/src/other.mjs', 'custom');
    f.run(ref);
    const backups = fs.readdirSync(path.join(f.storage, 'update-backups'));
    assert.equal(fs.readFileSync(path.join(f.storage, 'update-backups', backups[0], 'backend/src/kds-proxy.mjs'), 'utf8'), 'manual patch');
    f.git('merge', '--ff-only', ref);
    assert.equal(fs.readFileSync(path.join(f.repo, 'backend/src/kds-proxy.mjs'), 'utf8'), 'upstream');
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/token'), 'utf8'), 'preserve');
    assert.equal(fs.readFileSync(path.join(f.repo, 'backend/src/other.mjs'), 'utf8'), 'custom');
  } finally { f.cleanup(); }
});
test('updater refuses conflicting configuration without moving it', { skip: !enabled }, () => {
  const f = fixture();
  try {
    const ref = f.incoming('config/settings.json'); f.write('config/settings.json', 'local config');
    assert.throws(() => f.run(ref));
    assert.equal(fs.readFileSync(path.join(f.repo, 'config/settings.json'), 'utf8'), 'local config');
  } finally { f.cleanup(); }
});
test('updater refuses source symlinks escaping the application directory', { skip: !enabled }, () => {
  const f = fixture();
  try {
    const ref = f.incoming('backend/src/kds-proxy.mjs');
    const outside = path.join(f.dir, 'outside'); fs.writeFileSync(outside, 'keep');
    fs.mkdirSync(path.join(f.repo, 'backend/src'), { recursive: true });
    fs.symlinkSync(outside, path.join(f.repo, 'backend/src/kds-proxy.mjs'));
    assert.throws(() => f.run(ref));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  } finally { f.cleanup(); }
});
