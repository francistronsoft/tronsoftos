import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { activatePairingRuntime } from './pairing-runtime.mjs';

const token = 'test-only-token';
const hash = crypto.createHash('sha256').update(token).digest('hex');
function harness({ status = 'OK', digest = hash, composeFailure = false } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'compose') {
      if (composeFailure) throw new Error('private-token-in-error');
      return { stdout: '', stderr: '' };
    }
    return { stdout: args.at(-1).includes('createHash') ? digest : status, stderr: '' };
  };
  const activate = () => activatePairingRuntime({ appRoot: '/opt/tronsoftos', token, execMode: 'host', env: {}, run, sleep: async () => {} });
  return { calls, activate, run };
}

test('pairing recreates only backend and worker and verifies both without exposing token', async () => {
  const h = harness();
  const result = await h.activate();
  assert.equal(result.verified, true);
  assert.deepEqual(result.containers, ['tronfire_backend', 'tronfire_worker']);
  const compose = h.calls[0];
  assert.deepEqual(compose.args.slice(-2), ['backend', 'worker']);
  for (const flag of ['--no-deps', '--no-build', '--force-recreate']) assert.ok(compose.args.includes(flag));
  assert.ok(compose.args.includes('docker-compose.host-firebird.yml'));
  assert.equal(compose.options.cwd, path.join('/opt/tronsoftos', 'apps/tronfire'));
  assert.ok(!JSON.stringify(h.calls).includes(token));
});

for (const [status, reason] of [['AUTH_FAILED', /autenticacao/], ['TOOLS_MISSING', /realmente ausentes/], ['DEFERRED', /adiada/], ['HOST_FAILED', /execucao/], ['UNREACHABLE', /indisponivel/]]) {
  test(`pairing does not report success for ${status}`, async () => {
    await assert.rejects(harness({ status }).activate(), reason);
  });
}

test('pairing rejects divergent loaded token before host probe', async () => {
  const h = harness({ digest: 'wrong' });
  await assert.rejects(h.activate(), /token carregado diverge/);
  assert.equal(h.calls.length, 2);
});

test('pairing sanitizes compose failure and never recreates database dependencies', async () => {
  const h = harness({ composeFailure: true });
  await assert.rejects(h.activate(), e => !e.message.includes('private-token') && /Repita/.test(e.message));
  assert.equal(h.calls.length, 1);
});

test('pairing rejects container Firebird mode before any command', async () => {
  const h = harness();
  await assert.rejects(activatePairingRuntime({ appRoot: '/opt/test', token, execMode: 'container', run: h.run }), /host/);
  assert.equal(h.calls.length, 0);
});

test('container verification uses its own loaded credentials and a monitor-only filesystem probe', async () => {
  const h = harness();
  await h.activate();
  const code = h.calls.find(call => call.args.at(-1).includes('async')).args.at(-1);
  let request, output;
  await vm.runInNewContext(code, {
    process: { env: { TRONSOFTOS_API_URL: 'http://host.test:8080', TRONSOFTOS_INTERNAL_TOKEN: token } },
    AbortSignal,
    console: { log: value => { output = value; } },
    fetch: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ ok: true, stdout: '' }) }; }
  });
  assert.equal(output, 'OK');
  assert.equal(request.options.headers['x-tronsoftos-token'], token);
  const body = JSON.parse(request.options.body);
  assert.equal(body.operationClass, 'monitor');
  assert.ok(body.script.startsWith('# TronFire host Firebird script\n'));
  assert.match(body.script, /test -x/);
  assert.ok(!body.script.includes('isql -'));
});
