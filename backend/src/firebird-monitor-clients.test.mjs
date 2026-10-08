import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../../apps/tronfire/worker/src/worker.js', import.meta.url), 'utf8');
const backendSource = fs.readFileSync(new URL('../../apps/tronfire/backend/src/server.js', import.meta.url), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('worker passes class metadata and preserves deferred versus failure responses', async () => {
  let response = { ok: true, payload: { ok: false, deferred: true } }, request;
  let alerts = 0;
  const context = vm.createContext({
    internalTokenValue: () => 'test-token', TRONSOFTOS_API_URL: 'http://test',
    shellCommandFromArgs: () => 'simulated-command',
    postJsonLong: async (url, body) => { request = body; return response; },
    createAlertOnce: async () => { alerts++; }, resolveActiveAlertsByType: async () => {},
    stripHostScriptControlOutput: s => s
  });
  vm.runInContext(extract(workerSource, 'async function runHostFirebirdShell(', 'function stripHostScriptControlOutput('), context);
  await assert.rejects(context.runHostFirebirdShell([], 20000, 'monitor'), e => e.deferred === true);
  assert.equal(request.operationClass, 'monitor');
  assert.equal(request.origin, 'worker');
  assert.equal(alerts, 0);
  response = { ok: true, payload: { ok: false, error: 'timeout', monitorSlowFailures: 2 } };
  await assert.rejects(context.runHostFirebirdShell([], 20000, 'monitor'), e => e.deferred === false);
  assert.equal(alerts, 1);
  response = { ok: true, payload: { ok: true, stdout: 'result' } };
  assert.equal((await context.runHostFirebirdShell([], 20000, 'backup')).stdout, 'result');
  assert.equal(request.operationClass, 'backup');
});

test('backend never interprets a deferred monitor as an empty successful snapshot', async () => {
  let result = { ok: false, deferred: true }, request;
  const context = vm.createContext({
    tronsoftosRequest: async (url, options) => { request = JSON.parse(options.body); return result; }
  });
  vm.runInContext(extract(backendSource, 'async function runHostFirebirdScript(', 'async function runFirebirdShellScript('), context);
  await assert.rejects(context.runHostFirebirdScript('script', 10000, 'monitor'), e => e.deferred === true && e.statusCode === 503);
  assert.equal(request.origin, 'backend');
  result = { ok: true, stdout: 'real-snapshot' };
  assert.equal((await context.runHostFirebirdScript('script', 10000, 'monitor')).stdout, 'real-snapshot');
});

test('deferred database checks preserve previous health and do not create offline alerts', async () => {
  let updates = 0, alerts = 0;
  const context = vm.createContext({
    isPrimaryNode: () => true, backupRunning: false,
    prisma: { managedDatabase: { findMany: async () => [{ id: 'db', alias: 'erp', filePath: 'test' }], update: async () => { updates++; } }, backupJob: { count: async () => 0 } },
    clearExpiredDatabaseOperation: async db => db, databaseOperationActive: () => false,
    databaseInPostRestoreGrace: () => false, markOrphanedRunningBackupsFailed: async () => {},
    markStaleRunningBackupsFailed: async () => {}, databaseRoutineActive: () => false,
    firebirdCircuitOpen: () => false, shQuote: String, firebirdDbConnect: String,
    firebirdTimeoutSecondsCommand: () => '', FIREBIRD_BIN: '/test', FIREBIRD_PASSWORD: 'test',
    FIREBIRD_QUERY_TIMEOUT_SECONDS: 20,
    withDatabaseRoutineLock: async () => { const e = new Error('busy'); e.deferred = true; throw e; },
    createAlertOnce: async () => { alerts++; }
  });
  vm.runInContext(extract(workerSource, 'async function checkDatabases(', 'async function checkTools('), context);
  await context.checkDatabases();
  assert.equal(updates, 0);
  assert.equal(alerts, 0);
});

test('deferred session collection does not disconnect sessions or increment failures', async () => {
  let alerts = 0;
  const context = vm.createContext({
    isServingProductionNode: () => true, sessionCollectionRunning: false, lastSessionCollectionAt: 0,
    FIREBIRD_SESSION_INTERVAL_MINUTES: 5, Date,
    prisma: { managedDatabase: { findFirst: async () => ({ id: 'db', alias: 'erp' }) } },
    clearExpiredDatabaseOperation: async db => db, databaseOperationActive: () => false,
    databaseInPostRestoreGrace: () => false, databaseRoutineActive: () => false,
    firebirdCircuitOpen: () => false, queryFirebirdSessions: async () => {},
    withDatabaseRoutineLock: async () => { const e = new Error('busy'); e.deferred = true; throw e; },
    firebirdSessionFailureCounts: new Map(), createAlertOnce: async () => { alerts++; }
  });
  vm.runInContext(extract(workerSource, 'async function collectFirebirdSessionHistory(', 'function firebirdCreateTarget('), context);
  await context.collectFirebirdSessionHistory();
  assert.equal(context.firebirdSessionFailureCounts.size, 0);
  assert.equal(alerts, 0);
  assert.equal(context.sessionCollectionRunning, false);
});

test('deferred routine unlocks without updating the Firebird circuit breaker', async () => {
  let failures = 0, clears = 0;
  const context = vm.createContext({
    circuitKey: () => 'db', activeRoutineLock: () => null, FIREBIRD_ROUTINE_LOCK_KEY: 'global',
    firebirdCircuitOpen: () => false, setDatabaseRoutineLock: () => {},
    clearDatabaseRoutineLock: () => { clears++; }, markFirebirdSuccess: async () => {},
    markFirebirdFailure: async () => { failures++; }
  });
  vm.runInContext(extract(workerSource, 'async function withDatabaseRoutineLock(', 'async function backupToolProcesses('), context);
  await assert.rejects(context.withDatabaseRoutineLock({ alias: 'erp' }, 'test', async () => {
    const e = new Error('busy'); e.deferred = true; throw e;
  }));
  assert.equal(failures, 0);
  assert.equal(clears, 1);
});

test('backup process detection stays independent of the monitor gate', async () => {
  let operationClass;
  const context = vm.createContext({ runFirebirdShellScript: async (cmd, timeout, value) => {
    operationClass = value; return { stdout: '123 gbak -b db file' };
  } });
  vm.runInContext(extract(backendSource, 'async function backupToolProcesses(', 'function staleRunningBackupWhere('), context);
  assert.equal((await context.backupToolProcesses()).length, 1);
  assert.equal(operationClass, undefined);
});
