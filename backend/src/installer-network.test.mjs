import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const wizard = await fs.readFile(path.join(root, 'scripts/configure-wizard.sh'), 'utf8');
const helper = await fs.readFile(path.join(root, 'infra/sbin/tronsoftos-network'), 'utf8');
const dnsLibrary = path.join(root, 'scripts/network-dns.sh');
const enabled = process.platform === 'linux';
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

for (const [mode, role, name] of [['ha', 'primary', 'servidor-01'], ['ha', 'standby', 'servidor-02'], ['simple', 'primary', 'servidor-01']]) {
  test(`wizard asks HA, role then name (${mode}/${role}) and preserves custom cluster ID`, { skip: !enabled }, async () => {
    const block = extract(wizard, 'DEPLOYMENT_MODE="simple"', 'NODE_ID="$(new_uuid)"');
    const prelude = `yes_no() { [ '${mode}' = ha ]; }; choose_node_role() { echo '${role}'; }; ask() { echo "$1 [$2]" >&2; if [ "$1" = 'ID do cluster/cliente' ]; then echo custom-cluster; else echo "$2"; fi; };`;
    const out = await exec('bash', ['-c', `${prelude}\n${block}\nprintf '%s|%s|%s' "$NODE_ROLE" "$NODE_NAME" "$CLUSTER_ID"`]);
    assert.equal(out.stdout, `${role}|${name}|custom-cluster`);
    assert.match(out.stderr, new RegExp(`Nome deste servidor/no \\[${name}\\]`));
    assert.ok(block.indexOf('choose_node_role') < block.indexOf('Nome deste servidor/no'));
  });
}

test('shell DNS normalizer rejects every invalid address before writes', { skip: !enabled }, async () => {
  const run = value => exec('bash', ['-c', '. "$1"; normalize_dns "$2"', 'test', dnsLibrary, value]);
  assert.equal((await run('1.1.1.1, 8.8.8.8 1.1.1.1')).stdout.trim(), '1.1.1.1 8.8.8.8');
  assert.equal((await run('1.1.1.1, fe80::1%eth0')).stdout.trim(), '1.1.1.1 fe80::1');
  for (const value of ['999.1.1.1', '1.1.1.1;reboot', '01.1.1.1', '1.1.1.1 256.2.3.4']) await assert.rejects(run(value));
});

for (const origin of ['wizard', 'helper']) for (const manager of ['nm', 'networkd']) for (const applyNow of [false, true]) {
  test(`${origin} persists both DNS with ${manager}, apply=${applyNow}`, { skip: !enabled }, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tronsoftos-network-test-'));
    try {
      const functions = origin === 'helper' ? extract(helper, 'apply_static() {', 'install_firebird_aliases() {') : extract(wizard, 'configure_static_ip() {', 'line() {');
      const sandboxed = functions.replaceAll('/etc/systemd/network', temp).replace('. /usr/local/lib/tronsoftos-network-dns.sh', '. "$DNS_LIBRARY"');
      const stubs = `fail() { echo "$1" >&2; exit 1; }; valid_iface() { return 0; }; valid_cidr() { return 0; }; valid_ipv4() { return 0; }; json_escape() { printf '%s' "$1"; }; command_exists() { command -v "$1" >/dev/null; }; disable_iface_dhcp_sources() { :; }; stop_iface_dhcp_client() { :; }; remove_dynamic_ipv4_addresses() { :; }; sync_ip_envs() { printf '%s' "$5" > "$TEST_DIR/saved-env"; }; systemctl() { echo "systemctl $*" >> "$TEST_DIR/calls"; }; networkctl() { echo "networkctl $*" >> "$TEST_DIR/calls"; };`;
      const nm = manager === 'nm' ? `nmcli() { echo "$*" >> "$TEST_DIR/calls"; case "$*" in *'ipv4.dns,ipv6.dns'*|*'IP4.DNS,IP6.DNS'*) echo '1.1.1.1 8.8.8.8 2001:4860:4860::8888' ;; *'connection show'*) echo Wired:eth-test ;; esac; };` : 'command() { if [ "$*" = "-v nmcli" ]; then return 1; else builtin command "$@"; fi; };';
      const dns = origin === 'helper' ? '1.1.1.1,8.8.8.8,2001:4860:4860::8888' : '1.1.1.1 8.8.8.8 2001:4860:4860::8888';
      await exec('bash', ['-c', `set -euo pipefail\n. "$DNS_LIBRARY"\n${stubs}\n${nm}\n${sandboxed}\n${origin === 'helper' ? 'apply_static' : 'configure_static_ip'} eth-test 192.168.1.10/24 192.168.1.1 '${dns}' '${applyNow}' /opt/test`], { env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, DNS_LIBRARY: dnsLibrary, TEST_DIR: temp } });
      const calls = await fs.readFile(path.join(temp, 'calls'), 'utf8');
      if (manager === 'nm') {
        assert.match(calls, /ipv4.dns 1\.1\.1\.1 8\.8\.8\.8/);
        assert.match(calls, /ipv4.ignore-auto-dns yes/);
        assert.match(calls, /ipv6.dns 2001:4860:4860::8888/);
        assert.equal(calls.includes('connection up'), applyNow);
      } else {
        const saved = await fs.readFile(path.join(temp, '10-tronsoftos-eth-test.network'), 'utf8');
        assert.match(saved, /DNS=1\.1\.1\.1\nDNS=8\.8\.8\.8\nDNS=2001:4860:4860::8888/);
        assert.equal(/restart|reconfigure/.test(calls), applyNow);
      }
      if (origin === 'helper') assert.equal(await fs.readFile(path.join(temp, 'saved-env'), 'utf8'), '1.1.1.1 8.8.8.8 2001:4860:4860::8888');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
}
