import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/migrate-sweep-schedule.py', import.meta.url));
const supported = process.platform === 'linux';
const key = 'TRONFIRE_FIREBIRD_SWEEP_CRON';

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.env'), backup = path.join(root, 'backups');
  fs.writeFileSync(file, content, { mode: 0o640 });
  const execute = () => spawnSync('python3', [script, '--env', file, '--backup-dir', backup], { encoding: 'utf8' });
  return { root, file, backup, execute };
}

test('old default migrates atomically with exact backup, permissions and idempotence', { skip: !supported }, t => {
  const original = `SECRET_KEY=fixture-value\n${key}="0 6 * * 2,6" # local schedule\nTZ=America/Sao_Paulo\n`;
  const f = fixture(t, original), metadata = fs.statSync(f.file);
  const result = f.execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original.replace('2,6', '2,4,6'));
  const names = fs.readdirSync(f.backup);
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(f.backup, names[0]), 'utf8'), original);
  assert.equal(fs.statSync(path.join(f.backup, names[0])).mode & 0o777, 0o600);
  const after = fs.statSync(f.file);
  assert.equal(after.mode, metadata.mode);
  assert.equal(after.uid, metadata.uid);
  assert.equal(after.gid, metadata.gid);
  assert.equal(f.execute().status, 0);
  assert.equal(fs.readdirSync(f.backup).length, 1);
});

test('unquoted CRLF configuration migrates without damaging other fields or line endings', { skip: !supported }, t => {
  const original = `FIREBIRD_PASSWORD='fixture only'\r\n${key}=0 6 * * 2,6\r\nCUSTOM=preserve`;
  const f = fixture(t, original);
  assert.equal(f.execute().status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original.replace(`${key}=0 6 * * 2,6`, `${key}="0 6 * * 2,4,6"`));
});

test('custom, disabled, preserved, unset and already migrated schedules remain byte-identical', { skip: !supported }, t => {
  for (const content of [
    `${key}="0 4 * * *"\n`,
    `${key}="0 6 * * 2,4,6"\n`,
    `TRONFIRE_FIREBIRD_SWEEP_ENABLED=false\n${key}="0 6 * * 2,6"\n`,
    `TRONFIRE_FIREBIRD_SWEEP_PRESERVE_SCHEDULE=true\n${key}="0 6 * * 2,6"\n`,
    'TZ=America/Sao_Paulo\n'
  ]) {
    const f = fixture(t, content);
    assert.equal(f.execute().status, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
    assert.equal(fs.existsSync(f.backup), false);
  }
});

test('symlinks and duplicate schedule definitions fail before changing any configuration', { skip: !supported }, t => {
  const f = fixture(t, `${key}="0 6 * * 2,6"\n${key}="0 4 * * *"\n`);
  const original = fs.readFileSync(f.file);
  assert.notEqual(f.execute().status, 0);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(fs.existsSync(f.backup), false);
  const target = path.join(f.root, 'target');
  fs.renameSync(f.file, target); fs.symlinkSync(target, f.file);
  assert.notEqual(f.execute().status, 0);
  assert.deepEqual(fs.readFileSync(target), original);
});
