import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../../infra/sbin/tronsoftos-network', import.meta.url));
const enabled = process.platform === 'linux' && process.getuid?.() === 0;
const script = async (name, body) => {
  const path = `/tmp/tronsoftos-firebird-test-${process.pid}-${name}.sh`;
  await fs.writeFile(path, `# TronFire host Firebird script\n${body}\n`, { mode: 0o700 });
  return path;
};

test('host flock defers a second monitor but not a manual class', { skip: !enabled }, async () => {
  const firstPath = await script('first', 'printf "STARTED\\n"; sleep 5');
  const otherPath = await script('other', 'printf "SECOND\\n"');
  const first = spawn('bash', [helper, 'firebird-script', firstPath, 'monitor', '10']);
  const completed = new Promise((resolve, reject) => { first.on('error', reject); first.on('close', code => code === 0 ? resolve() : reject(new Error(`first exit ${code}`))); });
  try {
    await new Promise((resolve, reject) => { first.stdout.once('data', resolve); first.once('error', reject); });
    await assert.rejects(exec('bash', [helper, 'firebird-script', otherPath, 'monitor', '10']), e => e.code === 75 && !e.stdout.includes('SECOND'));
    assert.match((await exec('bash', [helper, 'firebird-script', otherPath, 'manual'])).stdout, /SECOND/);
    await completed;
    assert.match((await exec('bash', [helper, 'firebird-script', otherPath, 'monitor', '10'])).stdout, /SECOND/);
  } finally { first.kill('SIGTERM'); await completed.catch(() => {}); await fs.rm(firstPath, { force: true }); await fs.rm(otherPath, { force: true }); }
});

test('timeout kills only probe descendants and releases flock', { skip: !enabled }, async () => {
  const pidPath = `/tmp/tronsoftos-probe-test-${process.pid}.pid`;
  const stalled = await script('timeout', `sleep 60 &\necho $! > '${pidPath}'\nwait`);
  const next = await script('next', 'printf "RECOVERED\\n"');
  try {
    await assert.rejects(exec('bash', [helper, 'firebird-script', stalled, 'monitor', '1']), e => [124, 137].includes(e.code));
    const child = Number((await fs.readFile(pidPath, 'utf8')).trim());
    const { stdout } = await exec('ps', ['-o', 'stat=', '-p', String(child)]).catch(() => ({ stdout: '' }));
    assert.ok(!stdout.trim() || stdout.trim().startsWith('Z'), `descendant still running: ${stdout}`);
    assert.match((await exec('bash', [helper, 'firebird-script', next, 'monitor', '5'])).stdout, /RECOVERED/);
  } finally { await Promise.all([stalled, next, pidPath].map(path => fs.rm(path, { force: true }))); }
});

test('terminating probe wrapper releases the flock', { skip: !enabled }, async () => {
  const path = await script('signal', 'printf "READY\\n"; sleep 30');
  const next = await script('after-signal', 'printf "RELEASED\\n"');
  const child = spawn('bash', [helper, 'firebird-script', path, 'monitor', '40']);
  const closed = new Promise(resolve => child.on('close', resolve));
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    child.kill('SIGTERM');
    await closed;
    assert.match((await exec('bash', [helper, 'firebird-script', next, 'monitor', '5'])).stdout, /RELEASED/);
  } finally { child.kill('SIGTERM'); await closed; await fs.rm(path, { force: true }); await fs.rm(next, { force: true }); }
});
