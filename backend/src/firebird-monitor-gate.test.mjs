import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebirdMonitorGate, firebirdScriptClass } from './firebird-monitor-gate.mjs';

const probe = { script: 'probe-db-a', operationClass: 'monitor', origin: 'backend' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('coalesces equivalent backend and worker probes', async () => {
  const gate = createFirebirdMonitorGate();
  const job = deferred();
  let executions = 0;
  const first = gate(probe, () => { executions++; return job.promise; });
  const second = gate({ ...probe, origin: 'worker' }, () => { executions++; });
  job.resolve({ ok: true, stdout: 'snapshot' });
  assert.equal((await first).stdout, 'snapshot');
  assert.equal((await second).shared, true);
  assert.equal(executions, 1);
});

test('defers different concurrent probes without executing or queuing them', async () => {
  const gate = createFirebirdMonitorGate();
  const job = deferred();
  const first = gate(probe, () => job.promise);
  const result = await gate({ ...probe, script: 'other' }, () => assert.fail('must not execute'));
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  job.resolve({ ok: true });
  await first;
});

test('reuses short-lived cache and refreshes after expiration', async () => {
  let clock = 0, executions = 0;
  const gate = createFirebirdMonitorGate({ now: () => clock });
  const execute = async () => ({ ok: true, stdout: String(++executions) });
  await gate(probe, execute);
  assert.equal((await gate(probe, execute)).cached, true);
  clock = 5001;
  assert.equal((await gate(probe, execute)).stdout, '2');
});

test('does not cache failures or contention and releases after thrown errors', async () => {
  const gate = createFirebirdMonitorGate();
  await assert.rejects(gate(probe, async () => { throw new Error('failure'); }));
  await gate(probe, async () => ({ ok: false, deferred: true }));
  await gate(probe, async () => ({ ok: false, exitCode: 124 }));
  assert.equal((await gate(probe, async () => ({ ok: true, stdout: 'recovered' }))).stdout, 'recovered');
});

test('manual, backup, validation and sweep do not compete with monitoring', async () => {
  const gate = createFirebirdMonitorGate();
  const job = deferred();
  const first = gate(probe, () => job.promise);
  for (const operationClass of ['manual', 'backup', 'validation', 'sweep']) {
    assert.equal((await gate({ ...probe, operationClass }, async () => ({ ok: true }))).ok, true);
  }
  job.resolve({ ok: true });
  await first;
});

test('alerts after two slow probes without recording SQL or secrets', async () => {
  let clock = 0;
  const events = [];
  const gate = createFirebirdMonitorGate({ now: () => clock, emit: (type, data) => events.push({ type, data }) });
  const execute = async () => { clock += 11000; return { ok: true }; };
  await gate(probe, execute);
  const result = await gate({ ...probe, script: 'second-secret' }, execute);
  assert.equal(result.monitorSlowFailures, 2);
  assert.equal(events.filter(e => e.type === 'FIREBIRD_MONITOR_SLOW').length, 1);
  assert.ok(!JSON.stringify(events).includes('second-secret'));
});

test('validates operation classes', () => {
  assert.equal(firebirdScriptClass(), 'manual');
  assert.throws(() => firebirdScriptClass('monitor; reboot'));
});

test('does not retain oversized monitor output in cache', async () => {
  const gate = createFirebirdMonitorGate();
  let executions = 0;
  const execute = async () => { executions++; return { ok: true, stdout: 'x'.repeat(1024 * 1024) }; };
  await gate(probe, execute);
  await gate(probe, execute);
  assert.equal(executions, 2);
});
