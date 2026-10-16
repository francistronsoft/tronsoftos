import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function harness(profiles = 'cardapio,retaguarda,gerente') {
  const env = { COMPOSE_PROFILES: profiles }, writes = [], commands = [];
  const context = vm.createContext({
    path, appRoot: '/opt/test', parseEnvFile: file => file.replaceAll('\\', '/').endsWith('qr-static/.env') ? { TABLE_REQUERID: '1' } : { ...env },
    containerStatus: async names => names.map(name => ({ name, status: 'running' })),
    writeEnvValuesPrivileged: async (file, values) => { writes.push({ file, values }); if (file.includes('apps')) Object.assign(env, values); },
    dockerEnv: () => ({}), run: async (command, args) => { commands.push({ command, args }); return { stdout: '', stderr: '' }; },
    reconcileCloudflareManagedNetworks: async () => ({ ok: true }), appendEvent: () => {}
  });
  vm.runInContext(extract('const TRONCOMANDA_OPTIONAL_SERVICES =', 'async function httpAccessCheck('), context);
  return { context, env, writes, commands };
}

test('KDS defaults disabled and appears in container status', async () => {
  const h = harness();
  const settings = await h.context.troncomandaSettings();
  assert.equal(settings.kdsWebEnabled, false);
  assert.equal(settings.tableRequired, true);
  assert.ok(settings.containers.some(container => container.name === 'kds-web'));
});

test('KDS enable preserves existing options and Cloudflare reconciliation', async () => {
  const h = harness();
  const result = await h.context.writeTroncomandaSettings({ kdsWebEnabled: true });
  assert.equal(h.env.COMPOSE_PROFILES, 'cardapio,retaguarda,gerente,kds');
  for (const key of ['tableRequired', 'cardapioLiteEnabled', 'retaguardaWebEnabled', 'gerenteWebEnabled', 'kdsWebEnabled']) assert.equal(result[key], true);
  assert.equal(result.networks.ok, true);
  const up = h.commands.find(call => call.args.includes('kds-web'));
  assert.ok(up.args.includes('up'));
  assert.ok(!h.commands.some(call => call.args.includes('firebird') || call.args.includes('postgres') || call.args.includes('redis')));
});

test('KDS disable stops its service while preserving other enabled profiles', async () => {
  const h = harness('cardapio,retaguarda,gerente,kds');
  const result = await h.context.writeTroncomandaSettings({ kdsWebEnabled: false });
  assert.equal(result.kdsWebEnabled, false);
  assert.equal(h.env.COMPOSE_PROFILES, 'cardapio,retaguarda,gerente');
  const stop = h.commands.find(call => call.args.includes('stop'));
  assert.deepEqual(Array.from(stop.args.slice(-2)), ['stop', 'kds-web']);
});

test('an older client saving table settings does not silently disable existing KDS', async () => {
  const h = harness('kds');
  const result = await h.context.writeTroncomandaSettings({ tableRequired: false });
  assert.equal(result.kdsWebEnabled, true);
  assert.equal(h.env.COMPOSE_PROFILES, 'kds');
});

test('KDS image tag follows both main and dev with existing image tags unchanged', () => {
  const context = vm.createContext({});
  vm.runInContext(extract('function troncomandaImageTagEnv(', 'function appActionSteps('), context);
  for (const branch of ['main', 'dev']) {
    const tags = context.troncomandaImageTagEnv(branch);
    assert.equal(tags.KDS_WEB_IMAGE_TAG, `:${branch}`);
    assert.equal(tags.API_IMAGE_TAG, `:${branch}`);
    assert.equal(tags.TSGERENTE_WEB_IMAGE_TAG, `:${branch}`);
  }
});

test('existing managed configurations include KDS without losing custom settings or duplicates', () => {
  const config = { custom: true, apps: [{ name: 'troncomanda', containers: ['troncomanda_web'], healthUrl: 'custom' }, { name: 'tronfire', containers: ['tronfire_backend'] }] };
  const context = vm.createContext({ configPath: 'config', fallbackConfigPath: 'fallback', readJson: () => config });
  vm.runInContext(extract('function managedConfig(', 'function publicApp('), context);
  const migrated = context.managedConfig();
  assert.equal(migrated.custom, true);
  assert.equal(migrated.apps[0].healthUrl, 'custom');
  assert.deepEqual(Array.from(migrated.apps[0].containers), ['troncomanda_web', 'kds-web']);
  assert.deepEqual(config.apps[0].containers, ['troncomanda_web']);
  config.apps[0].containers.push('kds-web');
  assert.equal(context.managedConfig().apps[0].containers.filter(name => name === 'kds-web').length, 1);
});
