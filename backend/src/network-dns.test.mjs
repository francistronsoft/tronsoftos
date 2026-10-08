import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeDns, sameDns } from './network-dns.mjs';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const statusSource = source.slice(source.indexOf('async function hostNetworkStatus('), source.indexOf('async function clusterNetworkImpact('));
const payloadSource = source.slice(source.indexOf('function assertNetworkPayload('), source.indexOf('function assertVipPayload('));

test('DNS normalizes spaces, commas, arrays and duplicates preserving order', () => {
  for (const value of ['1.1.1.1, 8.8.8.8 1.1.1.1', ['1.1.1.1', '8.8.8.8']]) assert.equal(normalizeDns(value), '1.1.1.1 8.8.8.8');
  for (const value of ['999.1.1.1', '1.1.1.1;reboot', '01.1.1.1', 'dns.example']) assert.throws(() => normalizeDns(value));
  assert.equal(normalizeDns('1.1.1.1,fe80::1%eth0 2001:4860:4860::8888'), '1.1.1.1 fe80::1 2001:4860:4860::8888');
  assert.equal(sameDns('1.1.1.1 fe80::1%eth0', 'fe80::1 1.1.1.1'), true);
});

test('network payload validates all DNS before privileged changes', () => {
  const context = vm.createContext({ normalizeDns });
  vm.runInContext(payloadSource, context);
  const body = { interfaceName: 'eth0', addressCidr: '192.168.1.10/24', gateway: '192.168.1.1', dns: '1.1.1.1,8.8.8.8' };
  assert.equal(context.assertNetworkPayload(body).dns, '1.1.1.1 8.8.8.8');
  assert.throws(() => context.assertNetworkPayload({ ...body, dns: '1.1.1.1 256.1.1.1' }));
});

for (const manager of ['nm', 'networkd']) {
  test(`network status reads fresh saved DNS and distinguishes active DNS (${manager})`, async () => {
    const context = vm.createContext({
      process: { env: { HOST_STATIC_IP_DNS: '9.9.9.9' } }, normalizeDns, sameDns,
      readHostNetworkSettings: async () => ({ HOST_STATIC_IP_INTERFACE: 'eth0', HOST_STATIC_IP_DNS: '1.1.1.1 8.8.8.8' }),
      fs: { readFileSync: file => file.includes('resolv.conf') ? 'nameserver 9.9.9.9\n' : '[Network]\nDNS=1.1.1.1\nDNS=8.8.8.8\n' },
      run: async (command, args) => {
        if (command === 'ip') return { stdout: args.includes('addr') ? '[]' : '[{"dev":"eth0"}]' };
        if (command === 'resolvectl' || manager === 'networkd') throw new Error('unavailable');
        return { stdout: args.includes('NAME,DEVICE') ? 'Wired:eth0\n' : args.includes('IP4.DNS,IP6.DNS') ? '9.9.9.9\n' : '1.1.1.1,8.8.8.8\n' };
      }
    });
    vm.runInContext(statusSource, context);
    const status = await context.hostNetworkStatus();
    assert.equal(status.configured.dns, '1.1.1.1 8.8.8.8');
    assert.equal(status.dnsState.persisted, '1.1.1.1 8.8.8.8');
    assert.equal(status.dnsState.active, '9.9.9.9');
    assert.equal(status.dnsState.pending, true);
  });
}

test('saving network requires persistent DNS readback before success', async () => {
  let persisted = '1.1.1.1 8.8.8.8', events = 0;
  const context = vm.createContext({
    assertNetworkPayload: body => body, appRoot: '/opt/test', sameDns,
    privilegedRun: async () => ({ stdout: '{"ok":true}', stderr: '' }), parseJsonLines: text => [JSON.parse(text)],
    hostNetworkStatus: async () => ({ configured: { dns: '1.1.1.1 8.8.8.8' }, dnsState: { persisted } }),
    appendEvent: () => { events++; }
  });
  vm.runInContext(source.slice(source.indexOf('async function hostNetworkStatic('), source.indexOf('async function hostNetworkVip(')), context);
  const body = { dns: '1.1.1.1 8.8.8.8' };
  assert.equal((await context.hostNetworkStatic(body)).ok, true);
  persisted = '1.1.1.1';
  await assert.rejects(context.hostNetworkStatic(body), /confirmar/);
  assert.equal(events, 1);
});
