import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const smtpSettingsPath = process.env.TRONSOFTOS_SMTP_SETTINGS || path.join(stateDir, 'smtp-settings.json');
const rcloneSettingsPath = process.env.TRONSOFTOS_RCLONE_SETTINGS || path.join(stateDir, 'rclone-settings.json');
const googleCredentialsPath = process.env.TRONSOFTOS_GOOGLE_CREDENTIALS || path.join(stateDir, 'google-drive-credentials.json');
const googleOauthDir = process.env.TRONSOFTOS_GOOGLE_OAUTH_DIR || path.join(stateDir, 'google-oauth');
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

function publicSmtpSettings(settings) {
  return {
    enabled: settings.enabled === true,
    host: settings.host || '',
    port: settings.port || 587,
    secure: settings.secure === true,
    user: settings.user || '',
    passwordConfigured: !!settings.password,
    from: settings.from || '',
    to: settings.to || '',
    subjectPrefix: settings.subjectPrefix || '[TronSoftOS]'
  };
}

function smtpSettings() {
  return publicSmtpSettings(readJson(smtpSettingsPath, {}));
}

function normalizeSmtpSettings(body) {
  const current = readJson(smtpSettingsPath, {});
  const next = {
    enabled: body.enabled === true,
    host: String(body.host || '').trim(),
    port: Number(body.port || 587),
    secure: body.secure === true,
    user: String(body.user || '').trim(),
    password: body.password ? String(body.password) : current.password || '',
    from: String(body.from || '').trim(),
    to: String(body.to || '').trim(),
    subjectPrefix: String(body.subjectPrefix || '[TronSoftOS]').trim()
  };
  if (next.enabled) {
    if (!next.host) throw new Error('host SMTP nao informado');
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('porta SMTP invalida');
    if (!next.from) throw new Error('remetente SMTP nao informado');
    if (!next.to) throw new Error('destinatario SMTP nao informado');
  }
  return next;
}

function writeSmtpSettings(body) {
  ensureStateDir();
  const settings = normalizeSmtpSettings(body);
  fs.writeFileSync(smtpSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  appendEvent('SMTP_SETTINGS_UPDATED', { enabled: settings.enabled, host: settings.host, port: settings.port, to: settings.to });
  return publicSmtpSettings(settings);
}

function defaultRcloneConfigPath() {
  return process.env.RCLONE_CONFIG || path.join(appRoot, 'config/rclone/rclone.conf');
}

function rawRcloneSettings() {
  return {
    enabled: false,
    bin: process.env.RCLONE_BIN || '/usr/bin/rclone',
    config: defaultRcloneConfigPath(),
    remote: process.env.RCLONE_REMOTE || '',
    path: process.env.RCLONE_BACKUP_PATH || 'tronsoftos/backups',
    uploadOnlyRole: process.env.RCLONE_UPLOAD_ONLY_ROLE || 'primary',
    ...readJson(rcloneSettingsPath, {})
  };
}

function publicRcloneSettings(settings = rawRcloneSettings()) {
  return {
    enabled: settings.enabled === true,
    bin: settings.bin || '/usr/bin/rclone',
    config: settings.config || defaultRcloneConfigPath(),
    configConfigured: fs.existsSync(settings.config || defaultRcloneConfigPath()),
    remote: settings.remote || '',
    path: settings.path || 'tronsoftos/backups',
    uploadOnlyRole: settings.uploadOnlyRole || 'primary'
  };
}

function normalizeRcloneSettings(body) {
  const current = rawRcloneSettings();
  const next = {
    enabled: body.enabled === true,
    bin: String(body.bin || current.bin || '/usr/bin/rclone').trim(),
    config: String(body.config || current.config || defaultRcloneConfigPath()).trim(),
    remote: String(body.remote || '').trim(),
    path: String(body.path || '').trim() || 'tronsoftos/backups',
    uploadOnlyRole: String(body.uploadOnlyRole || 'primary').trim()
  };
  if (!next.bin.startsWith('/')) throw new Error('caminho do rclone deve ser absoluto');
  if (!next.config.startsWith('/')) throw new Error('caminho do rclone.conf deve ser absoluto');
  if (next.enabled && !next.remote) throw new Error('remote rclone nao informado');
  if (!['primary', 'standby', 'recovery', 'any'].includes(next.uploadOnlyRole)) throw new Error('role de upload invalida');
  return next;
}

function writeRcloneSettings(body) {
  ensureStateDir();
  const settings = normalizeRcloneSettings(body);
  if (typeof body.configContent === 'string' && body.configContent.trim()) {
    fs.mkdirSync(path.dirname(settings.config), { recursive: true });
    fs.writeFileSync(settings.config, body.configContent.trimEnd() + '\n', { mode: 0o600 });
  }
  fs.writeFileSync(rcloneSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  appendEvent('RCLONE_SETTINGS_UPDATED', { enabled: settings.enabled, remote: settings.remote, path: settings.path, uploadOnlyRole: settings.uploadOnlyRole });
  return publicRcloneSettings(settings);
}

function requestBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`;
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

function googleOauthStatePath(state) {
  return path.join(googleOauthDir, `${state}.json`);
}

function normalizeRemoteName(value) {
  const remote = String(value || 'gdrive').trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(remote)) throw new Error('remote deve usar apenas letras, numeros, _ ou -');
  return remote;
}

function rawGoogleCredentials() {
  return {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token',
    redirectUris: [],
    ...readJson(googleCredentialsPath, {})
  };
}

function publicGoogleCredentials(settings = rawGoogleCredentials()) {
  return {
    configured: !!(settings.clientId && settings.clientSecret),
    clientId: settings.clientId || '',
    authUri: settings.authUri || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: settings.tokenUri || 'https://oauth2.googleapis.com/token',
    redirectUris: Array.isArray(settings.redirectUris) ? settings.redirectUris : []
  };
}

function normalizeGoogleCredentials(body) {
  let payload = body;
  if (typeof body.content === 'string' && body.content.trim()) {
    try {
      payload = JSON.parse(body.content);
    } catch {
      throw new Error('JSON de credenciais Google invalido');
    }
  }
  const source = payload.web || payload.installed || payload;
  const clientId = String(source.client_id || source.clientId || '').trim();
  const clientSecret = String(source.client_secret || source.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('JSON sem client_id/client_secret');
  return {
    clientId,
    clientSecret,
    authUri: String(source.auth_uri || source.authUri || 'https://accounts.google.com/o/oauth2/v2/auth').trim(),
    tokenUri: String(source.token_uri || source.tokenUri || 'https://oauth2.googleapis.com/token').trim(),
    redirectUris: Array.isArray(source.redirect_uris) ? source.redirect_uris : Array.isArray(source.redirectUris) ? source.redirectUris : []
  };
}

function saveGoogleCredentials(body) {
  ensureStateDir();
  const credentials = normalizeGoogleCredentials(body);
  fs.writeFileSync(googleCredentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  appendEvent('GOOGLE_DRIVE_CREDENTIALS_IMPORTED', { clientId: credentials.clientId, redirectUris: credentials.redirectUris.length });
  return publicGoogleCredentials(credentials);
}

function normalizeGoogleOauthInput(body, req) {
  const credentials = rawGoogleCredentials();
  const clientId = String(body.clientId || credentials.clientId || '').trim();
  const clientSecret = String(body.clientSecret || credentials.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('informe client_id e client_secret do OAuth Google para usar o assistente');
  const settings = rawRcloneSettings();
  const remote = normalizeRemoteName(body.remote || settings.remote || 'gdrive');
  const redirectUri = String(body.redirectUri || `${requestBaseUrl(req)}/api/backups/google/callback`).trim();
  if (!/^https?:\/\//i.test(redirectUri)) throw new Error('redirect URI invalido');
  return {
    clientId,
    clientSecret,
    authUri: credentials.authUri || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: credentials.tokenUri || 'https://oauth2.googleapis.com/token',
    remote,
    redirectUri,
    config: String(body.config || settings.config || defaultRcloneConfigPath()).trim(),
    path: String(body.path || settings.path || 'tronsoftos/backups').trim(),
    uploadOnlyRole: String(body.uploadOnlyRole || settings.uploadOnlyRole || 'primary').trim()
  };
}

function googleDriveRcloneConfig({ remote, clientId, clientSecret, token }) {
  const safeToken = JSON.stringify(token);
  const lines = [
    `[${remote}]`,
    'type = drive',
    'scope = drive',
  ];
  if (clientId) lines.push(`client_id = ${clientId}`);
  if (clientSecret) lines.push(`client_secret = ${clientSecret}`);
  lines.push(`token = ${safeToken}`, '');
  return lines.join('\n');
}

function html(reply, status, body) {
  reply.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  reply.end(body);
}

function startGoogleDriveOauth(req, body) {
  const input = normalizeGoogleOauthInput(body, req);
  if (!['primary', 'standby', 'recovery', 'any'].includes(input.uploadOnlyRole)) throw new Error('role de upload invalida');
  ensureStateDir();
  fs.mkdirSync(googleOauthDir, { recursive: true });
  const state = crypto.randomUUID();
  fs.writeFileSync(googleOauthStatePath(state), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  const authUrl = new URL(input.authUri || 'https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', input.clientId);
  authUrl.searchParams.set('redirect_uri', input.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  appendEvent('GOOGLE_DRIVE_OAUTH_STARTED', { remote: input.remote, path: input.path });
  return { authUrl: authUrl.toString(), redirectUri: input.redirectUri, remote: input.remote };
}

function saveGoogleDriveToken(body) {
  const settings = rawRcloneSettings();
  const remote = normalizeRemoteName(body.remote || settings.remote || 'gdrive');
  const rawToken = String(body.token || '').trim();
  if (!rawToken) throw new Error('token OAuth nao informado');
  let token;
  try {
    token = JSON.parse(rawToken);
  } catch {
    throw new Error('token OAuth deve estar em JSON');
  }
  if (!token.access_token && !token.refresh_token) throw new Error('token OAuth invalido');
  const configContent = googleDriveRcloneConfig({
    remote,
    clientId: String(body.clientId || '').trim(),
    clientSecret: String(body.clientSecret || '').trim(),
    token
  });
  const result = writeRcloneSettings({
    enabled: true,
    bin: body.bin || settings.bin || '/usr/bin/rclone',
    config: body.config || settings.config || defaultRcloneConfigPath(),
    remote,
    path: body.path || settings.path || 'tronsoftos/backups',
    uploadOnlyRole: body.uploadOnlyRole || settings.uploadOnlyRole || 'primary',
    configContent
  });
  appendEvent('GOOGLE_DRIVE_TOKEN_IMPORTED', { remote, path: result.path });
  return result;
}

async function completeGoogleDriveOauth(reply, url) {
  const state = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  const error = String(url.searchParams.get('error') || '');
  if (error) return html(reply, 400, `<h1>Falha no Google Drive</h1><p>${error}</p>`);
  if (!state || !code) return html(reply, 400, '<h1>Falha no Google Drive</h1><p>Retorno OAuth incompleto.</p>');
  const statePath = googleOauthStatePath(state);
  const input = readJson(statePath, null);
  if (!input) return html(reply, 400, '<h1>Falha no Google Drive</h1><p>Sessao OAuth expirada ou invalida.</p>');

  const response = await fetch(input.tokenUri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const tokenResponse = await response.json();
  if (!response.ok) {
    return html(reply, 400, `<h1>Falha no Google Drive</h1><pre>${String(tokenResponse.error_description || tokenResponse.error || 'erro OAuth')}</pre>`);
  }

  const token = {
    access_token: tokenResponse.access_token,
    token_type: tokenResponse.token_type || 'Bearer',
    refresh_token: tokenResponse.refresh_token,
    expiry: new Date(Date.now() + Number(tokenResponse.expires_in || 3600) * 1000).toISOString()
  };
  const configContent = googleDriveRcloneConfig({
    remote: input.remote,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    token
  });
  writeRcloneSettings({
    enabled: true,
    bin: rawRcloneSettings().bin || '/usr/bin/rclone',
    config: input.config,
    remote: input.remote,
    path: input.path,
    uploadOnlyRole: input.uploadOnlyRole,
    configContent
  });
  fs.rmSync(statePath, { force: true });
  appendEvent('GOOGLE_DRIVE_OAUTH_CONNECTED', { remote: input.remote, path: input.path });
  return html(reply, 200, '<h1>Google Drive conectado</h1><p>Voce ja pode fechar esta aba e voltar para o TronSoftOS.</p>');
}

function rcloneTarget(settings) {
  const remote = String(settings.remote || '').replace(/:+$/g, '');
  const remotePath = String(settings.path || '').replace(/^\/+|\/+$/g, '');
  return remotePath ? `${remote}:${remotePath}` : `${remote}:`;
}

async function rcloneTest() {
  const settings = rawRcloneSettings();
  if (!settings.remote) throw new Error('remote rclone nao configurado');
  const out = await run(settings.bin || '/usr/bin/rclone', ['lsd', rcloneTarget(settings), '--config', settings.config || defaultRcloneConfigPath()], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 2
  });
  appendEvent('RCLONE_TEST_OK', { remote: settings.remote, path: settings.path });
  return { ok: true, stdout: out.stdout, stderr: out.stderr, target: rcloneTarget(settings) };
}

async function rcloneUploadTest() {
  const settings = rawRcloneSettings();
  if (!settings.remote) throw new Error('remote rclone nao configurado');
  ensureStateDir();
  const testPath = path.join(stateDir, `rclone-upload-test-${Date.now()}.txt`);
  fs.writeFileSync(testPath, `TronSoftOS rclone test ${new Date().toISOString()}\n`);
  try {
    const target = `${rcloneTarget(settings).replace(/\/+$/g, '')}/tronsoftos-upload-test.txt`;
    const out = await run(settings.bin || '/usr/bin/rclone', ['copyto', testPath, target, '--config', settings.config || defaultRcloneConfigPath()], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 2
    });
    appendEvent('RCLONE_UPLOAD_TEST_OK', { target });
    return { ok: true, stdout: out.stdout, stderr: out.stderr, target };
  } finally {
    fs.rmSync(testPath, { force: true });
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
  const rclone = publicRcloneSettings();
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
    rclone,
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
  if (req.method === 'GET' && url.pathname === '/api/backups/rclone') return json(reply, 200, publicRcloneSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/backups/rclone') return json(reply, 200, writeRcloneSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/test') return json(reply, 200, await rcloneTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/upload-test') return json(reply, 200, await rcloneUploadTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/token') return json(reply, 200, saveGoogleDriveToken(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, publicGoogleCredentials());
  if (req.method === 'POST' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, saveGoogleCredentials(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/google/start') return json(reply, 200, startGoogleDriveOauth(req, await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/google/callback') return await completeGoogleDriveOauth(reply, url);
  if (req.method === 'GET' && url.pathname === '/api/cloudflare') return json(reply, 200, cloudflareStatus());
  if (req.method === 'GET' && url.pathname === '/api/settings/smtp') return json(reply, 200, smtpSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/settings/smtp') return json(reply, 200, writeSmtpSettings(await readBody(req)));
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
