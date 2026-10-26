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
  context.troncomandaImageTagEnv = branch => ({ API_IMAGE_TAG: `:${branch}` });
  context.ensureTroncomandaRegistryLogin = async () => {};
  vm.runInContext(extract('const TRONCOMANDA_OPTIONAL_SERVICES =', 'async function httpAccessCheck('), context);
  context.verifyTroncomandaKdsApi = async () => {};
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
  assert.equal(h.env.API_IMAGE_TAG, ':qa');
  for (const key of ['tableRequired', 'cardapioLiteEnabled', 'retaguardaWebEnabled', 'gerenteWebEnabled', 'kdsWebEnabled']) assert.equal(result[key], true);
  assert.equal(result.networks.ok, true);
  const up = h.commands.find(call => call.args.includes('kds-web'));
  assert.ok(up.args.includes('up'));
  assert.ok(up.args.includes('web'));
  assert.ok(up.args.includes('qr'));
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

test('missing registry access fails before changing any settings or containers', async () => {
  const h = harness();
  h.context.ensureTroncomandaRegistryLogin = async () => { throw new Error('registry unavailable'); };
  await assert.rejects(h.context.writeTroncomandaSettings({ kdsWebEnabled: true }), /GHCR/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.commands.length, 0);
});

test('saving unrelated settings on QA preserves a customized frontend image', async () => {
  const h = harness('kds');
  h.env.API_IMAGE_TAG = ':qa';
  h.env.KDS_WEB_IMAGE_TAG = '@sha256:custom';
  await h.context.writeTroncomandaSettings({ tableRequired: false });
  assert.equal(h.env.API_IMAGE_TAG, ':qa');
  assert.equal(h.env.KDS_WEB_IMAGE_TAG, '@sha256:custom');
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

test('QA uses unified API and published main frontends, with no nonexistent QA tags', () => {
  const context = vm.createContext({});
  vm.runInContext(extract('function troncomandaImageTagEnv(', 'function appActionSteps('), context);
  const tags = context.troncomandaImageTagEnv('qa');
  assert.equal(tags.API_IMAGE_TAG, ':qa');
  assert.equal(tags.TRONCOMANDA_BRANCH, 'qa');
  assert.equal(tags.TRONCOMANDA_GERENTE_API_URL, 'http://api:9000');
  for (const key of ['QR_IMAGE_TAG', 'KDS_WEB_IMAGE_TAG', 'TSGERENTE_WEB_IMAGE_TAG', 'RETAGUARDA_API_IMAGE_TAG', 'CARDAPIO_IMAGE_TAG']) assert.equal(tags[key], ':main');
  assert.equal(context.troncomandaImageTagEnv('main').TRONCOMANDA_GERENTE_API_URL, 'http://tsgerente-api:9002');
});

test('KDS blocks incompatible downgrade but still permits stop and restart', () => {
  const context = vm.createContext({
    path, appRoot: '/opt/test', troncomandaBranch: () => 'qa',
    normalizedProfiles: value => new Set(value.split(',')), parseEnvFile: () => ({ COMPOSE_PROFILES: 'kds' }),
    troncomandaEnvPath: () => '/opt/test/.env'
  });
  vm.runInContext(extract('function troncomandaImageTagEnv(', 'function appActionCommand('), context);
  const app = { name: 'troncomanda', type: 'compose', composeFile: 'compose.yml' };
  for (const branch of ['main', 'dev']) assert.throws(() => context.appActionSteps(app, 'up', { branch }), /KDS Web requer/);
  assert.doesNotThrow(() => context.appActionSteps(app, 'stop'));
  assert.doesNotThrow(() => context.appActionSteps(app, 'restart'));
  const steps = context.appActionSteps(app, 'pull');
  assert.equal(steps[0].env.API_IMAGE_TAG, ':qa');
  assert.ok(steps[1].args.includes('up'));
});

test('KDS API readiness requires both login and stations routes before success', async () => {
  let calls = 0;
  const context = vm.createContext({
    parseEnvFile: () => ({ TRONCOMANDA_API_PORT: '9000' }), troncomandaEnvPath: () => 'env',
    AbortSignal, setTimeout: callback => callback(),
    fetch: async () => { calls++; return { ok: true, json: async () => ({ paths: {} }) }; }
  });
  vm.runInContext(extract('async function verifyTroncomandaKdsApi(', 'async function writeTroncomandaSettings('), context);
  await assert.rejects(context.verifyTroncomandaKdsApi(), /sem as rotas KDS/);
  assert.equal(calls, 12);
  context.fetch = async () => ({ ok: true, json: async () => ({ paths: { '/auth/user/token/': {}, '/kds/stations/': {} } }) });
  await assert.doesNotReject(context.verifyTroncomandaKdsApi());
});

test('compose failures are actionable and do not record database passwords', async () => {
  const h = harness();
  const events = [];
  h.context.appendEvent = (type, details) => events.push({ type, details });
  h.context.run = async () => { throw { code: 1, stderr: 'failure firebird://user:private-value@localhost/database' }; };
  await assert.rejects(h.context.runTroncomandaCompose(['up', '-d']), error => error.statusCode === 502);
  assert.equal(events[0].type, 'TRONCOMANDA_COMPOSE_FAILED');
  assert.ok(!events[0].details.detail.includes('private-value'));
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
