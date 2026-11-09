import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the production orchestration with fake effects; never start a worker,
// connect to Firebird or import Prisma in this regression suite.
const worker = fs.readFileSync(new URL('../../apps/tronfire/worker/src/worker.js', import.meta.url), 'utf8');
const sweep = worker.slice(worker.indexOf('async function runFirebirdSweep('), worker.indexOf('function scheduleSweepRetry('));
const scheduled = worker.slice(worker.indexOf('async function runScheduledSweeps('), worker.indexOf('function resetScheduledSweepRetries('));
function context(overrides = {}) {
  return vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    FIREBIRD_SWEEP_ENABLED: true, isPrimaryNode: () => true,
    haSyncActive: () => false, backupRunning: false,
    scheduledSweepRunning: false, scheduledSweepRetryCount: 0,
    clearExpiredDatabaseOperation: async db => db,
    databaseOperationActive: db => db.operationStatus === 'RUNNING',
    databaseInPostRestoreGrace: () => false, databaseRoutineActive: () => false,
    firebirdCircuitOpen: () => false,
    backupStamp: () => 'fixture', shQuote: value => value,
    firebirdDbConnect: value => value, FIREBIRD_BIN: '/fixture',
    FIREBIRD_PASSWORD: 'fixture', FIREBIRD_SWEEP_TIMEOUT_MINUTES: 180,
    FIREBIRD_SWEEP_TIMEOUT_MS: 10800000, firebirdTimeoutCommand: () => 'timeout',
    dockerExec: async () => assert.fail('must not run a competing sweep'),
    resolveActiveAlertsByType: async () => {}, createAlertOnce: async () => {},
    ...overrides,
  });
}

test('active restore validation defers the sweep before invoking Firebird', async () => {
  const c = context(); vm.runInContext(sweep, c);
  c.db = { alias: 'fixture', operationStatus: 'RUNNING', operationKind: 'VALIDATION' };
  const result = await vm.runInContext('runFirebirdSweep(db)', c);
  assert.equal(result.status, 'postponed'); assert.match(result.reason, /VALIDATION/);
});

test('validation routine acquired during sweep preparation prevents execution', async () => {
  let routineAttempts = 0;
  const c = context({ withDatabaseRoutineLock: async () => { routineAttempts++; return null; } });
  vm.runInContext(sweep, c);
  c.db = { alias: 'fixture', filePath: '/fixture.fdb', operationStatus: 'IDLE' };
  const result = await vm.runInContext('runFirebirdSweep(db)', c);
  assert.equal(result.status, 'postponed'); assert.equal(routineAttempts, 1);
});

test('backup and HA contention schedule a retry without dispatching any sweep', async () => {
  for (const busy of ['backup', 'ha']) {
    const reasons = [];
    const c = context({ backupRunning: busy === 'backup', haSyncActive: () => busy === 'ha',
      scheduleSweepRetry: reason => reasons.push(reason),
      prisma: { managedDatabase: { findMany: async () => assert.fail('must defer before dispatch') } },
    });
    vm.runInContext(scheduled, c);
    assert.equal(await vm.runInContext('runScheduledSweeps()', c), false);
    assert.equal(reasons.length, 1);
  }
});

test('overrunning validation is retried and a later free slot executes normally', async () => {
  const reasons = []; let busy = true, sweeps = 0;
  const c = context({
    prisma: { managedDatabase: { findMany: async () => [{ id: 'fixture', alias: 'fixture' }] }, backupJob: { count: async () => 0 } },
    markOrphanedRunningBackupsFailed: async () => {}, markStaleRunningBackupsFailed: async () => {},
    runFirebirdSweep: async () => { if (busy) return { status: 'postponed', reason: 'validation' }; sweeps++; return { status: 'ok' }; },
    scheduleSweepRetry: reason => reasons.push(reason),
  });
  vm.runInContext(scheduled, c);
  assert.equal(await vm.runInContext('runScheduledSweeps()', c), false);
  assert.equal(c.scheduledSweepRunning, false); assert.equal(reasons.length, 1);
  busy = false;
  assert.equal(await vm.runInContext('runScheduledSweeps("retry")', c), true);
  assert.equal(sweeps, 1); assert.equal(c.scheduledSweepRunning, false);
});
