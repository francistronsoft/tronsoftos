import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.TRONSOFTOS_APP_DIR || path.resolve(__dirname, '../..');
const port = Number(process.env.TRONSOFTOS_PORT || 8080);
const configPath = process.env.MANAGED_APPS_CONFIG || path.join(appRoot, 'config/managed-apps.json');
const fallbackConfigPath = path.join(appRoot, 'config/managed-apps.example.json');
const stateDir = process.env.TRONSOFTOS_STATE_DIR || path.join(appRoot, 'state');
const clusterLockPath = process.env.TRONSOFTOS_CLUSTER_LOCK || path.join(stateDir, 'cluster-lock.json');
const clusterSecretsPath = process.env.TRONSOFTOS_CLUSTER_SECRETS || path.join(stateDir, 'cluster-secrets.env');
const eventLogPath = process.env.TRONSOFTOS_EVENT_LOG || path.join(stateDir, 'events.jsonl');
const frontendDist = process.env.TRONSOFTOS_FRONTEND_DIST || path.join(appRoot, 'frontend/dist');

function json(reply, status, body) {
  const payload = JSON.stringify(body, null, 2);
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  reply.end(payload);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
}

function appendEvent(type, details = {}) {
  ensureStateDir();
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    details,
    node: process.env.TRONSOFTOS_NODE_NAME || null,
    createdAt: new Date().toISOString()
  };
  fs.appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`);
  return event;
}

function readEvents(limit = 100) {
  try {
    return fs.readFileSync(eventLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map(line => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
}

function managedConfig() {
  return readJson(configPath, readJson(fallbackConfigPath, { apps: [] }));
}

function publicApp(app) {
  return {
    name: app.name,
    type: app.type,
    enabled: !!app.enabled,
    projectName: app.projectName,
    composeFiles: app.composeFiles || (app.composeFile ? [app.composeFile] : []),
    healthUrl: app.healthUrl,
    containers: app.containers || [],
    haAware: !!app.haAware
  };
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd || appRoot,
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 3
  });
  return { stdout, stderr };
}

async function privilegedRun(command, args, options = {}) {
  if (process.getuid && process.getuid() !== 0) {
    return run('sudo', [command, ...args], options);
  }
  return run(command, args, options);
}

async function commandExists(command) {
  try {
    if (process.platform === 'win32') await run('where', [command], { timeout: 5000 });
    else await run('/bin/sh', ['-lc', `command -v ${command}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function parseEnvFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .reduce((acc, line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
        acc[key] = value;
        return acc;
      }, {});
  } catch {
    return {};
  }
}

function fileCheck(label, filePath, kind = 'file') {
  try {
    const stat = fs.statSync(filePath);
    const ok = kind === 'dir' ? stat.isDirectory() : kind === 'symlink' ? fs.lstatSync(filePath).isSymbolicLink() : stat.isFile();
    return {
      label,
      path: filePath,
      ok,
      status: ok ? 'ok' : 'error',
      detail: ok ? `${kind} encontrado` : `nao e ${kind}`,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch (err) {
    return { label, path: filePath, ok: false, status: 'error', detail: err.message };
  }
}

async function containerStatus(names = []) {
  if (!names.length) return [];
  if (!(await commandExists('docker'))) {
    return names.map(name => ({ name, status: 'unknown', detail: 'docker unavailable' }));
  }
  try {
    const { stdout } = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 20_000, maxBuffer: 1024 * 1024 * 5 });
    const rows = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return names.map(name => {
      const row = rows.find(item => item.Names === name);
      return row
        ? { name, status: row.State || 'unknown', detail: row.Status || '' }
        : { name, status: 'missing', detail: 'container not found' };
    });
  } catch (err) {
    return names.map(name => ({ name, status: 'error', detail: err.message }));
  }
}

async function fetchHealth(url) {
  if (!url) return { ok: null, status: 'not-configured' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: response.ok, status: response.status, url };
  } catch (err) {
    return { ok: false, status: 'offline', url, error: err.message };
  }
}

function checkSeverity(ok, warn = false) {
  if (ok) return 'ok';
  return warn ? 'warning' : 'error';
}

async function tcpListenCheck(portToCheck) {
  try {
    const { stdout } = await run('ss', ['-ltnp'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).filter(line => line.includes(`:${portToCheck}`));
    return {
      ok: lines.length > 0,
      status: lines.length > 0 ? 'ok' : 'error',
      detail: lines[0] || `porta ${portToCheck} nao esta ouvindo`,
      port: portToCheck
    };
  } catch (err) {
    return { ok: false, status: 'warning', detail: err.message, port: portToCheck };
  }
}

function firebirdAuthFailed(text) {
  return /Your user name and password are not defined|SQLSTATE\s*=\s*28000|unable to open database/i.test(text || '');
}

async function validateFirebirdPassword() {
  const bin = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
  const password = process.env.FIREBIRD_PASSWORD || 'masterkey';
  const storageRoot = process.env.STORAGE_ROOT || '/opt/tronfire-storage';
  const candidates = [
    `${storageRoot}/firebird/templates/template.fdb`,
    '/firebird/templates/template.fdb'
  ];
  const dbPath = candidates.find(item => fs.existsSync(item));
  if (!dbPath) {
    return { ok: false, status: 'warning', detail: 'template.fdb nao encontrado para teste de login', dbPath: null };
  }
  try {
    const script = `printf 'select 1 from rdb$database;\\nquit;\\n' | FIREBIRD=/usr/local/firebird LD_LIBRARY_PATH=/usr/local/firebird/lib:$LD_LIBRARY_PATH ${bin}/isql -user SYSDBA -password '${password.replace(/'/g, "'\\''")}' 127.0.0.1:${dbPath}`;
    const out = await run('/bin/sh', ['-lc', script], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const text = `${out.stdout || ''}${out.stderr || ''}`;
    const ok = !firebirdAuthFailed(text) && /CONSTANT|1|SQL>/i.test(text);
    return { ok, status: ok ? 'ok' : 'error', detail: ok ? 'SYSDBA/masterkey validado via isql' : text.trim(), dbPath };
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    return { ok: false, status: 'error', detail: text.trim(), dbPath };
  }
}

async function appsStatus() {
  const config = managedConfig();
  const apps = [];
  for (const app of config.apps || []) {
    const [containers, health] = await Promise.all([
      containerStatus(app.containers || []),
      fetchHealth(app.healthUrl)
    ]);
    const running = containers.filter(item => item.status === 'running').length;
    apps.push({
      ...publicApp(app),
      containers,
      health,
      status: app.enabled === false ? 'disabled' : health.ok ? 'online' : running > 0 ? 'degraded' : 'offline'
    });
  }
  return apps;
}

function clusterStatus() {
  const lock = readJson(clusterLockPath, null);
  return {
    mode: process.env.TRONSOFTOS_DEPLOYMENT_MODE || 'simple',
    nodeName: process.env.TRONSOFTOS_NODE_NAME || 'local',
    nodeRole: process.env.TRONFIRE_NODE_ROLE || process.env.TRONSOFTOS_NODE_ROLE || 'primary',
    vip: process.env.HA_VIP || null,
    lockPath: clusterLockPath,
    lock,
    keepalived: {
      enabled: process.env.TRONSOFTOS_KEEPALIVED_ENABLED === 'true',
      interface: process.env.HA_INTERFACE || null,
      routerId: process.env.HA_ROUTER_ID || null
    }
  };
}

function backupStatus() {
  const backupDir = process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups';
  const files = [];
  try {
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(gbk|fbk|gbk\.gz|fbk\.gz|manifest\.json)$/i.test(entry.name)) continue;
      const filePath = path.join(backupDir, entry.name);
      const stat = fs.statSync(filePath);
      files.push({ name: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  } catch {
    // Directory may not exist before install.
  }
  files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return {
    backupDir,
    rclone: {
      bin: process.env.RCLONE_BIN || '/usr/bin/rclone',
      config: process.env.RCLONE_CONFIG || '/opt/tronsoftos/config/rclone/rclone.conf',
      remote: process.env.RCLONE_REMOTE || null,
      path: process.env.RCLONE_BACKUP_PATH || null,
      uploadOnlyRole: process.env.RCLONE_UPLOAD_ONLY_ROLE || 'primary'
    },
    recentFiles: files.slice(0, 20)
  };
}

function cloudflareStatus() {
  return {
    recordName: process.env.CLOUDFLARE_RECORD_NAME || null,
    recordType: process.env.CLOUDFLARE_RECORD_TYPE || 'A',
    targetIp: process.env.CLOUDFLARE_TARGET_IP || process.env.HA_VIP || null,
    tokenConfigured: !!process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN !== 'change-me'
  };
}

async function hostFirebirdStatus() {
  const service = process.env.FIREBIRD_SERVICE || 'firebird';
  let status = 'unknown';
  let details = '';
  try {
    const { stdout } = await run('systemctl', ['is-active', service], { timeout: 10_000 });
    status = stdout.trim() || status;
  } catch (err) {
    status = 'inactive';
    details = err.message;
  }
  let logs = '';
  try {
    const out = await run('journalctl', ['-u', service, '-n', '120', '--no-pager'], { timeout: 15_000, maxBuffer: 1024 * 1024 * 2 });
    logs = `${out.stdout || ''}${out.stderr || ''}`.trim();
  } catch {
    try {
      const out = await run('systemctl', ['status', service, '--no-pager'], { timeout: 15_000, maxBuffer: 1024 * 1024 * 2 });
      logs = `${out.stdout || ''}${out.stderr || ''}`.trim();
    } catch (err) {
      logs = `Nao foi possivel ler logs/status do Firebird host: ${err.message}`;
    }
  }
  return { mode: 'host', service, status, details, logs };
}

async function hostFirebirdAction(action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('invalid action');
  const service = process.env.FIREBIRD_SERVICE || 'firebird';
  const out = await privilegedRun('/usr/bin/systemctl', [action, service], { timeout: action === 'restart' ? 120_000 : 60_000, maxBuffer: 1024 * 1024 * 2 });
  appendEvent(`FIREBIRD_HOST_${action.toUpperCase()}`, { service, stdout: out.stdout, stderr: out.stderr });
  return { ok: true, mode: 'host', service, action };
}

function assertInternalToken(req) {
  const expected = process.env.TRONSOFTOS_INTERNAL_TOKEN || '';
  if (!expected) return;
  const received = String(req.headers['x-tronsoftos-token'] || '');
  if (received !== expected) {
    const error = new Error('Token interno TronSoftOS invalido');
    error.statusCode = 403;
    throw error;
  }
}

async function hostFirebirdAliases(req) {
  assertInternalToken(req);
  const body = await readBody(req);
  const content = String(body.content || '');
  if (!content.includes('Managed by TronFire')) throw new Error('aliases.conf invalido');
  if (content.length > 1024 * 256) throw new Error('aliases.conf muito grande');
  ensureStateDir();
  const tmpPath = `/tmp/tronsoftos-aliases-${Date.now()}-${Math.random().toString(16).slice(2)}.conf`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', ['install-firebird-aliases', tmpPath], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const result = parseJsonLines(out.stdout).at(-1) || { ok: true };
    appendEvent('FIREBIRD_ALIASES_UPDATED', { target: result.target });
    return { ...result, stderr: out.stderr };
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

async function hostNetworkStatus() {
  let interfaces = [];
  try {
    const { stdout } = await run('ip', ['-j', '-4', 'addr', 'show', 'scope', 'global'], { timeout: 10_000, maxBuffer: 1024 * 1024 * 2 });
    interfaces = JSON.parse(stdout).map(item => ({
      name: item.ifname,
      addresses: (item.addr_info || []).map(addr => ({
        address: addr.local,
        prefixLength: addr.prefixlen,
        cidr: `${addr.local}/${addr.prefixlen}`
      }))
    }));
  } catch (err) {
    interfaces = [{ name: 'erro', addresses: [], error: err.message }];
  }

  let defaultRoute = null;
  try {
    const { stdout } = await run('ip', ['-j', 'route', 'show', 'default'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    defaultRoute = JSON.parse(stdout)[0] || null;
  } catch {
    defaultRoute = null;
  }

  let dns = [];
  try {
    dns = fs.readFileSync('/etc/resolv.conf', 'utf8')
      .split(/\r?\n/)
      .map(line => line.match(/^nameserver\s+(\S+)/)?.[1])
      .filter(Boolean);
  } catch {
    dns = [];
  }

  return {
    interfaces,
    defaultInterface: defaultRoute?.dev || interfaces[0]?.name || null,
    gateway: defaultRoute?.gateway || null,
    dns,
    configured: {
      enabled: process.env.HOST_STATIC_IP_ENABLED === 'true',
      interface: process.env.HOST_STATIC_IP_INTERFACE || null,
      addressCidr: process.env.HOST_STATIC_IP_ADDRESS_CIDR || null,
      gateway: process.env.HOST_STATIC_IP_GATEWAY || null,
      dns: process.env.HOST_STATIC_IP_DNS || null
    }
  };
}

function assertNetworkPayload(body) {
  const payload = {
    interfaceName: String(body.interfaceName || '').trim(),
    addressCidr: String(body.addressCidr || '').trim(),
    gateway: String(body.gateway || '').trim(),
    dns: Array.isArray(body.dns) ? body.dns.join(' ') : String(body.dns || '').trim(),
    applyNow: body.applyNow === true
  };
  if (!/^[A-Za-z0-9_.:-]+$/.test(payload.interfaceName)) throw new Error('interface invalida');
  if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(payload.addressCidr)) throw new Error('ip/cidr invalido');
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(payload.gateway)) throw new Error('gateway invalido');
  if (!payload.dns) throw new Error('dns nao informado');
  return payload;
}

async function hostNetworkStatic(body) {
  const payload = assertNetworkPayload(body);
  const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', [
    'apply-static',
    payload.interfaceName,
    payload.addressCidr,
    payload.gateway,
    payload.dns,
    payload.applyNow ? 'true' : 'false',
    appRoot
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 * 2 });
  const result = parseJsonLines(out.stdout).at(-1) || { ok: true };
  appendEvent('HOST_NETWORK_STATIC_CONFIGURED', { ...payload, result });
  return {
    ...result,
    reloadRequired: true,
    reloadHint: 'Reinicie TronSoftOS e containers TronFire para carregar os envs atualizados.',
    stderr: out.stderr
  };
}

function exportPairingFile(reply) {
  if (!fs.existsSync(clusterSecretsPath)) {
    return json(reply, 404, { error: 'cluster-secrets.env not found' });
  }
  reply.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="cluster-secrets.env"',
    'cache-control': 'no-store'
  });
  fs.createReadStream(clusterSecretsPath).pipe(reply);
}

async function dashboard() {
  const [apps] = await Promise.all([appsStatus()]);
  const cluster = clusterStatus();
  const backups = backupStatus();
  const alerts = [];
  if (apps.some(app => app.status === 'offline' && app.enabled)) alerts.push({ severity: 'critical', message: 'App gerenciado offline' });
  if (cluster.mode === 'ha' && !cluster.lock) alerts.push({ severity: 'warning', message: 'Cluster HA sem cluster-lock' });
  if (!backups.rclone.remote) alerts.push({ severity: 'warning', message: 'Remote rclone nao configurado' });
  return {
    generatedAt: new Date().toISOString(),
    cluster,
    apps,
    backups,
    cloudflare: cloudflareStatus(),
    alerts
  };
}

async function diagnostics() {
  const tronfireEnvPath = path.join(appRoot, 'apps/tronfire/.env');
  const tronfireEnv = parseEnvFile(tronfireEnvPath);
  const [apps, firebird, network, firebirdPort, firebirdLogin] = await Promise.all([
    appsStatus(),
    hostFirebirdStatus(),
    hostNetworkStatus(),
    tcpListenCheck(Number(process.env.FIREBIRD_PORT || tronfireEnv.FIREBIRD_PORT || 3050)),
    validateFirebirdPassword()
  ]);
  const tronfire = apps.find(app => app.name === 'tronfire') || null;
  const expectedMode = tronfireEnv.FIREBIRD_EXEC_MODE || process.env.FIREBIRD_EXEC_MODE || 'host';
  const storageRoot = tronfireEnv.STORAGE_ROOT || process.env.STORAGE_ROOT || '/opt/tronfire-storage';
  const checks = [
    {
      id: 'tronsoftos-health',
      label: 'TronSoftOS',
      status: 'ok',
      ok: true,
      detail: `porta ${port}`
    },
    {
      id: 'tronfire-health',
      label: 'TronFire',
      status: checkSeverity(tronfire?.health?.ok),
      ok: !!tronfire?.health?.ok,
      detail: tronfire?.health?.ok ? tronfire.health.url : tronfire?.health?.error || tronfire?.status || 'nao encontrado'
    },
    {
      id: 'firebird-service',
      label: 'Firebird host',
      status: checkSeverity(firebird.status === 'active'),
      ok: firebird.status === 'active',
      detail: `${firebird.service}: ${firebird.status}`
    },
    {
      id: 'firebird-port',
      label: 'Porta Firebird',
      ...firebirdPort
    },
    {
      id: 'firebird-login',
      label: 'SYSDBA/masterkey',
      ...firebirdLogin
    },
    {
      id: 'tronfire-mode',
      label: 'Modo TronFire',
      status: checkSeverity(expectedMode === 'host'),
      ok: expectedMode === 'host',
      detail: `FIREBIRD_EXEC_MODE=${expectedMode}`
    },
    fileCheck('Binario isql', '/usr/local/firebird/bin/isql'),
    fileCheck('security2.fdb', '/opt/firebird/security2.fdb'),
    fileCheck('Storage /firebird', '/firebird', 'dir'),
    fileCheck('Template Firebird', `${storageRoot}/firebird/templates/template.fdb`),
    fileCheck('Diretorio bancos', `${storageRoot}/firebird/data`, 'dir'),
    fileCheck('Diretorio backups', `${storageRoot}/firebird/backups`, 'dir')
  ];
  const containers = tronfire?.containers || [];
  const summary = {
    ok: checks.every(check => check.status === 'ok') && containers.every(container => container.status === 'running'),
    errors: checks.filter(check => check.status === 'error').length + containers.filter(container => ['error', 'missing', 'exited'].includes(container.status)).length,
    warnings: checks.filter(check => check.status === 'warning').length
  };
  return {
    generatedAt: new Date().toISOString(),
    summary,
    checks,
    apps,
    tronfire: {
      envPath: tronfireEnvPath,
      firebirdExecMode: expectedMode,
      panelPort: tronfireEnv.TRONFIRE_PANEL_PORT || tronfireEnv.PORT || null,
      healthUrl: tronfire?.healthUrl || null,
      containers
    },
    firebird,
    network,
    backups: backupStatus()
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function findApp(name) {
  return (managedConfig().apps || []).find(app => app.name === name);
}

async function appAction(app, action) {
  if (!['up', 'stop', 'restart', 'pull'].includes(action)) throw new Error('invalid action');
  if (app.type !== 'compose') throw new Error('only compose apps are supported');
  const composeFiles = app.composeFiles || (app.composeFile ? [app.composeFile] : []);
  if (!composeFiles.length) throw new Error('compose file not configured');
  const args = ['compose', '-p', app.projectName || app.name];
  for (const composeFile of composeFiles) {
    args.push('-f', path.resolve(appRoot, composeFile));
  }
  if (action === 'up') args.push('up', '-d');
  else if (action === 'restart') args.push('restart');
  else args.push(action);
  const out = await run('docker', args, { timeout: 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 10 });
  appendEvent(`APP_${action.toUpperCase()}`, { app: app.name, stdout: out.stdout, stderr: out.stderr });
  return out;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, reply) {
  const url = new URL(req.url, 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(frontendDist, `.${requested}`);
  const safeRoot = path.resolve(frontendDist);
  const finalPath = filePath.startsWith(safeRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(safeRoot, 'index.html');
  if (!fs.existsSync(finalPath)) return json(reply, 404, { error: 'frontend not built' });
  reply.writeHead(200, { 'content-type': contentTypeFor(finalPath) });
  fs.createReadStream(finalPath).pipe(reply);
}

async function handleApi(req, reply, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(reply, 200, { ok: true, app: 'TronSoftOS', version: '0.1.0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(reply, 200, await dashboard());
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') return json(reply, 200, await diagnostics());
  if (req.method === 'GET' && url.pathname === '/api/apps') return json(reply, 200, { apps: await appsStatus() });
  if (req.method === 'GET' && url.pathname === '/api/cluster') return json(reply, 200, clusterStatus());
  if (req.method === 'GET' && url.pathname === '/api/backups') return json(reply, 200, backupStatus());
  if (req.method === 'GET' && url.pathname === '/api/cloudflare') return json(reply, 200, cloudflareStatus());
  if (req.method === 'GET' && url.pathname === '/api/events') return json(reply, 200, { events: readEvents(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'GET' && url.pathname === '/api/cluster/pairing-file') return exportPairingFile(reply);
  if (req.method === 'GET' && url.pathname === '/api/host/firebird') return json(reply, 200, await hostFirebirdStatus());
  if (req.method === 'POST' && url.pathname === '/api/host/firebird/aliases') return json(reply, 200, await hostFirebirdAliases(req));
  if (req.method === 'GET' && url.pathname === '/api/host/network') return json(reply, 200, await hostNetworkStatus());
  if (req.method === 'POST' && url.pathname === '/api/host/network/static') return json(reply, 200, await hostNetworkStatic(await readBody(req)));
  const hostFirebirdMatch = url.pathname.match(/^\/api\/host\/firebird\/(start|stop|restart)$/);
  if (req.method === 'POST' && hostFirebirdMatch) return json(reply, 200, await hostFirebirdAction(hostFirebirdMatch[1]));
  const actionMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/(up|stop|restart|pull)$/);
  if (req.method === 'POST' && actionMatch) {
    await readBody(req).catch(() => ({}));
    const app = findApp(actionMatch[1]);
    if (!app) return json(reply, 404, { error: 'app not found' });
    const out = await appAction(app, actionMatch[2]);
    return json(reply, 200, { ok: true, stdout: out.stdout, stderr: out.stderr });
  }
  return json(reply, 404, { error: 'not found' });
}

const server = http.createServer(async (req, reply) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      return await handleApi(req, reply, url);
    }
    return serveStatic(req, reply);
  } catch (err) {
    return json(reply, err.statusCode || 500, { error: err.message || 'internal error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  ensureStateDir();
  appendEvent('TRONSOFTOS_STARTED', { port });
  console.log(`TronSoftOS listening on 0.0.0.0:${port}`);
});
