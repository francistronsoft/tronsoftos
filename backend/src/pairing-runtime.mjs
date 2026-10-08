import crypto from 'node:crypto';
import path from 'node:path';

const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex');
const tokenCheck = 'console.log(require("node:crypto").createHash("sha256").update(process.env.TRONSOFTOS_INTERNAL_TOKEN || "").digest("hex"))';
const hostCheck = `
(async () => {
  const script = '# TronFire host Firebird script\\nfor bin in gbak gfix gstat isql; do test -x /usr/local/firebird/bin/$bin || printf "MISSING:%s\\\\n" "$bin"; done\\n';
  try {
    const response = await fetch(process.env.TRONSOFTOS_API_URL + '/api/host/firebird/script', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { 'content-type': 'application/json', 'x-tronsoftos-token': process.env.TRONSOFTOS_INTERNAL_TOKEN },
      body: JSON.stringify({script, operationClass: 'monitor', origin: 'pairing', timeoutMs: 5000})
    });
    if (response.status === 401 || response.status === 403) { console.log('AUTH_FAILED'); return; }
    if (!response.ok) { console.log('HOST_FAILED'); return; }
    const result = await response.json();
    console.log(result.deferred ? 'DEFERRED' : !result.ok ? 'HOST_FAILED' : /MISSING:/.test(result.stdout || '') ? 'TOOLS_MISSING' : 'OK');
  } catch { console.log('UNREACHABLE'); }
})();`;

export async function activatePairingRuntime({ appRoot, token, execMode, run, env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (execMode !== 'host') throw new Error('Pareamento automatico requer Firebird no host. Nenhum servico foi recriado.');
  const cwd = path.join(appRoot, 'apps/tronfire');
  const deadline = Date.now() + 60000;
  try {
    await run('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.host-firebird.yml',
      'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'backend', 'worker'],
    { cwd, env, timeout: 45000 });
  } catch {
    throw new Error('Segredos salvos, mas nao foi possivel recriar backend e worker. Repita a importacao.');
  }
  const verified = [];
  for (const container of ['tronfire_backend', 'tronfire_worker']) {
    let status = 'UNREACHABLE';
    for (let attempt = 0; attempt < 15; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const check = await run('docker', ['exec', container, 'node', '-e', tokenCheck], { env, timeout: Math.max(1, Math.min(10000, deadline - Date.now())) });
        if (check.stdout.trim() !== fingerprint(token)) throw new Error('TOKEN_MISMATCH');
        const probe = await run('docker', ['exec', container, 'node', '-e', hostCheck], { env, timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
        status = probe.stdout.trim();
      } catch (err) {
        status = err.message === 'TOKEN_MISMATCH' ? 'TOKEN_MISMATCH' : 'UNREACHABLE';
      }
      if (status === 'OK') break;
      if (['TOKEN_MISMATCH', 'AUTH_FAILED', 'TOOLS_MISSING'].includes(status)) break;
      if (attempt < 14) await sleep(500);
    }
    if (status !== 'OK') {
      const reasons = {
        TOKEN_MISMATCH: 'token carregado diverge do token salvo', AUTH_FAILED: 'autenticacao recusada pelo host',
        TOOLS_MISSING: 'utilitarios Firebird realmente ausentes', DEFERRED: 'verificacao adiada por monitoramento em andamento',
        HOST_FAILED: 'falha na execucao do verificador', UNREACHABLE: 'host ou container indisponivel'
      };
      throw new Error(`Pareamento ainda nao validado em ${container}: ${reasons[status] || 'resposta inesperada'}. Segredos salvos; repita a importacao.`);
    }
    verified.push(container);
  }
  return { verified: true, containers: verified, hostAuthenticated: true };
}
