import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('let pairingImportInProgress ='), source.indexOf('function exportPairingFile('));
function harness({ role = 'standby', serving = false, password = 'test-pg', activate, applyFail = false } = {}) {
  let commands = 0;
  const files = new Set(), events = [];
  const context = vm.createContext({
    path, crypto, Buffer, stateDir: '/opt/test/state', appRoot: '/opt/test', clusterSecretsPath: '/opt/test/state/cluster-secrets.env',
    nodeIdentity: () => ({ deploymentMode: 'ha', nodeRole: role }), clusterGuard: () => ({ canServeProduction: serving }),
    ensureStateDir: () => {}, dockerEnv: () => ({}), process: { env: {} }, run: async () => {},
    normalizePairingContent: () => ({ content: 'normalized', values: { TRONSOFTOS_INTERNAL_TOKEN: 'test-token', POSTGRES_PASSWORD: 'test-pg' } }),
    parseEnvFile: () => ({ FIREBIRD_EXEC_MODE: 'host', POSTGRES_PASSWORD: password }),
    fs: { writeFileSync: file => files.add(file), rmSync: file => files.delete(file) },
    privilegedRun: async () => { commands++; if (applyFail) throw new Error('secret'); return { stdout: '{}', stderr: '' }; },
    parseJsonLines: text => [JSON.parse(text)], appendEvent: (type, data) => events.push({ type, data }),
    activatePairingRuntime: activate || (async () => ({ verified: true }))
  });
  vm.runInContext(functions, context);
  return { context, files, events, commandCount: () => commands, import: () => context.importPairingFile({ content: 'test' }) };
}

test('pairing import reports success only after runtime validation and deletes temporary secrets', async () => {
  const h = harness();
  const result = await h.import();
  assert.equal(result.runtime.verified, true);
  assert.equal(result.reloadRequired, false);
  assert.equal(h.files.size, 0);
  assert.equal(h.context.process.env.TRONSOFTOS_INTERNAL_TOKEN, 'test-token');
  assert.equal(h.events.at(-1).type, 'CLUSTER_PAIRING_IMPORTED');
});

test('failed pairing validation remains retryable and does not emit success', async () => {
  let failed = true;
  const h = harness({ activate: async () => { if (failed) throw new Error('not verified'); return { verified: true }; } });
  await assert.rejects(h.import(), /not verified/);
  assert.equal(h.files.size, 0);
  assert.ok(!h.events.some(event => event.type === 'CLUSTER_PAIRING_IMPORTED'));
  failed = false;
  assert.equal((await h.import()).ok, true);
});

test('pairing refuses primary, promoted standby and divergent PostgreSQL password before mutation', async () => {
  for (const options of [{ role: 'primary' }, { serving: true }, { password: 'other' }]) {
    const h = harness(options);
    await assert.rejects(h.import());
    assert.equal(h.commandCount(), 0);
    assert.equal(h.files.size, 0);
  }
});

test('pairing rejects concurrent imports and always releases import guard', async () => {
  let finish;
  const h = harness({ activate: () => new Promise(resolve => { finish = resolve; }) });
  const first = h.import();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.import(), /andamento/);
  finish({ verified: true });
  assert.equal((await first).ok, true);
});

test('helper failure removes temporary secrets and sanitizes the response', async () => {
  const h = harness({ applyFail: true });
  await assert.rejects(h.import(), e => !e.message.includes('secret'));
  assert.equal(h.files.size, 0);
});

test('pairing route renews the current session signature even on a partial failure', async () => {
  const start = source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/cluster/pairing-file/import') {");
  const end = source.indexOf("  if (req.method === 'GET' && url.pathname === '/api/host/firebird')", start);
  for (const failure of [false, true]) {
    let renewed = 0, token = 'old';
    const expiresAt = Date.now() + 60000;
    const context = vm.createContext({
      url: { pathname: '/api/cluster/pairing-file/import' },
      sessionFromRequest: () => ({ username: 'test', expiresAt }), readBody: async () => ({}),
      importPairingFile: async () => { token = 'new'; if (failure) throw new Error('partial failure'); return { ok: true }; },
      signSession: session => { assert.equal(session.expiresAt, expiresAt); return token; },
      cookieHeader: (req, signature) => { assert.equal(signature, 'new'); return signature; },
      json: (reply, status, result) => result
    });
    vm.runInContext(`async function route(req, reply) {${source.slice(start, end)}}`, context);
    const request = context.route({ method: 'POST' }, { setHeader: () => { renewed++; } });
    if (failure) await assert.rejects(request); else assert.equal((await request).ok, true);
    assert.equal(renewed, 1);
  }
});
