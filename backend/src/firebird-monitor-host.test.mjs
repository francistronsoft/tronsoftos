import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createFirebirdMonitorGate, firebirdScriptClass } from './firebird-monitor-gate.mjs';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const hostFunction = source.slice(source.indexOf('let firebirdMonitorSlowAlert ='), source.indexOf('async function hostNetworkStatus('));
function harness(execute) {
  const calls = [], files = new Set(), events = [];
  const context = vm.createContext({
    createFirebirdMonitorGate, firebirdScriptClass,
    assertInternalToken: req => { if (req.token !== 'test') throw new Error('unauthorized'); },
    readBody: async req => req.body, ensureStateDir: () => {}, path,
    fs: { writeFileSync: file => files.add(file), rmSync: file => files.delete(file) },
    privilegedRun: async (cmd, args, options) => { calls.push({ args, options }); return execute(); },
    commandErrorPayload: err => ({ ok: false, exitCode: err.code, error: 'test-error' }),
    parseJsonLinesBestEffort: () => [], stripTerminalNoise: String,
    appendEvent: (type, details) => events.push({ type, details }), process: { env: {} }
  });
  vm.runInContext(hostFunction, context);
  return { context, calls, files, events };
}
const request = (extra = {}) => ({ token: 'test', body: { script: '# TronFire host Firebird script\nprintf OK\n', operationClass: 'monitor', origin: 'backend', timeoutMs: 20000, ...extra } });

test('host authenticates and validates before creating any script', async () => {
  const h = harness(async () => ({ stdout: '', stderr: '' }));
  await assert.rejects(h.context.hostFirebirdScript({ ...request(), token: 'bad' }));
  await assert.rejects(h.context.hostFirebirdScript(request({ script: 'unsigned' })));
  await assert.rejects(h.context.hostFirebirdScript(request({ timeoutMs: 'invalid' })));
  assert.equal(h.files.size, 0);
  assert.equal(h.calls.length, 0);
});

test('host applies bounded monitor deadline while keeping legacy manual deadlines', async () => {
  const h = harness(async () => ({ stdout: 'OK', stderr: '' }));
  assert.equal((await h.context.hostFirebirdScript(request({ timeoutMs: 999999 }))).ok, true);
  assert.equal(h.calls[0].args[2], 'monitor');
  assert.equal(h.calls[0].args[3], '90');
  assert.equal(h.calls[0].options.timeout, 97000);
  assert.equal(h.files.size, 0);
  await h.context.hostFirebirdScript(request({ operationClass: 'manual', timeoutMs: 14400000 }));
  assert.equal(h.calls[1].options.timeout, 14400000);
});

test('host converts inter-process flock contention into deferral and cleans scripts', async () => {
  const h = harness(async () => { const e = new Error('busy'); e.code = 75; throw e; });
  const result = await h.context.hostFirebirdScript(request());
  assert.equal(result.deferred, true);
  assert.equal(h.files.size, 0);
  assert.ok(!h.events.some(e => e.type === 'FIREBIRD_HOST_SCRIPT_FAILED'));
});

test('host shares one execution across clients and reuses the subsequent snapshot', async () => {
  let resolve;
  const wait = new Promise(r => { resolve = r; });
  const h = harness(() => wait);
  const first = h.context.hostFirebirdScript(request());
  const second = h.context.hostFirebirdScript(request({ origin: 'worker' }));
  resolve({ stdout: 'OK', stderr: '' });
  await first;
  assert.equal((await second).shared, true);
  assert.equal((await h.context.hostFirebirdScript(request())).cached, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.files.size, 0);
});
