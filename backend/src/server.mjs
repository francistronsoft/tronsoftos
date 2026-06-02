import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.TRONSOFTOS_APP_DIR || path.resolve(__dirname, '../..');
const port = Number(process.env.TRONSOFTOS_PORT || 8080);
const configPath = process.env.MANAGED_APPS_CONFIG || path.join(appRoot, 'config/managed-apps.json');
const fallbackConfigPath = path.join(appRoot, 'config/managed-apps.example.json');
const stateDir = process.env.TRONSOFTOS_STATE_DIR || path.join(appRoot, 'state');
const nodeIdentityPath = process.env.TRONSOFTOS_NODE_IDENTITY || path.join(stateDir, 'node-identity.json');
const clusterLockPath = process.env.TRONSOFTOS_CLUSTER_LOCK || path.join(stateDir, 'cluster-lock.json');
const clusterSecretsPath = process.env.TRONSOFTOS_CLUSTER_SECRETS || path.join(stateDir, 'cluster-secrets.env');
const eventLogPath = process.env.TRONSOFTOS_EVENT_LOG || path.join(stateDir, 'events.jsonl');
const smtpSettingsPath = process.env.TRONSOFTOS_SMTP_SETTINGS || path.join(stateDir, 'smtp-settings.json');
const cloudflareSettingsPath = process.env.TRONSOFTOS_CLOUDFLARE_SETTINGS || path.join(stateDir, 'cloudflare-settings.json');
const rcloneSettingsPath = process.env.TRONSOFTOS_RCLONE_SETTINGS || path.join(stateDir, 'rclone-settings.json');
const haSyncSettingsPath = process.env.TRONSOFTOS_HA_SYNC_SETTINGS || path.join(stateDir, 'ha-sync-settings.json');
const maintenanceStatePath = process.env.TRONSOFTOS_MAINTENANCE_STATE || path.join(stateDir, 'maintenance-state.json');
const googleCredentialsPath = process.env.TRONSOFTOS_GOOGLE_CREDENTIALS || path.join(stateDir, 'google-drive-credentials.json');
const googleOauthDir = process.env.TRONSOFTOS_GOOGLE_OAUTH_DIR || path.join(stateDir, 'google-oauth');
const frontendDist = process.env.TRONSOFTOS_FRONTEND_DIST || path.join(appRoot, 'frontend/dist');
const actionJobs = new Map();
const maxActionLogLength = 1024 * 128;
const dockerConfigDir = process.env.TRONSOFTOS_DOCKER_CONFIG || path.join(stateDir, 'docker-config');
let rcloneQuotaCache = { key: null, checkedAt: 0, value: null };
let haSyncSchedulerTimer = null;
let lastAutoHaSyncStartedAt = 0;
const smtpAlertSentAt = new Map();

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
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    details,
    node: process.env.TRONSOFTOS_NODE_NAME || null,
    createdAt: new Date().toISOString()
  };
  try {
    ensureStateDir();
    fs.appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.error(`Nao foi possivel gravar evento ${type} em ${eventLogPath}: ${err.message}`);
  }
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

function envLike(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function defaultNodeIdentity() {
  const existing = readJson(nodeIdentityPath, {});
  const now = new Date().toISOString();
  return {
    clusterId: existing.clusterId || process.env.TRONSOFTOS_CLUSTER_ID || process.env.CUSTOMER_ID || 'local',
    nodeId: existing.nodeId || crypto.randomUUID(),
    nodeName: existing.nodeName || process.env.TRONSOFTOS_NODE_NAME || 'servidor-01',
    nodeRole: existing.nodeRole || process.env.TRONFIRE_NODE_ROLE || process.env.TRONSOFTOS_NODE_ROLE || 'primary',
    installId: existing.installId || crypto.randomUUID(),
    deploymentMode: existing.deploymentMode || process.env.TRONSOFTOS_DEPLOYMENT_MODE || 'simple',
    createdAt: existing.createdAt || now,
    updatedAt: existing.updatedAt || now
  };
}

function nodeIdentity() {
  const identity = defaultNodeIdentity();
  if (!fs.existsSync(nodeIdentityPath)) {
    ensureStateDir();
    fs.writeFileSync(nodeIdentityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  }
  return identity;
}

function normalizeNodeIdentity(body) {
  const current = nodeIdentity();
  const next = {
    ...current,
    clusterId: envLike(body.clusterId, current.clusterId),
    nodeName: envLike(body.nodeName, current.nodeName),
    nodeRole: envLike(body.nodeRole, current.nodeRole),
    deploymentMode: envLike(body.deploymentMode, current.deploymentMode),
    updatedAt: new Date().toISOString()
  };
  if (!['primary', 'standby', 'recovery'].includes(next.nodeRole)) throw new Error('papel do no invalido');
  if (!['simple', 'ha'].includes(next.deploymentMode)) throw new Error('modo de implantacao invalido');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(next.clusterId)) throw new Error('cluster_id invalido');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(next.nodeName)) throw new Error('nome do no invalido');
  return next;
}

function writeNodeIdentity(body) {
  ensureStateDir();
  const identity = normalizeNodeIdentity(body);
  fs.writeFileSync(nodeIdentityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  appendEvent('NODE_IDENTITY_UPDATED', { clusterId: identity.clusterId, nodeName: identity.nodeName, nodeRole: identity.nodeRole });
  return identity;
}

function defaultClusterLock() {
  const identity = nodeIdentity();
  return {
    cluster: identity.clusterId,
    active_node: identity.nodeRole === 'primary' ? identity.nodeName : '',
    this_node: identity.nodeName,
    allow_promotion: false,
    last_valid_standby: null,
    reason: '',
    updated_at: new Date().toISOString()
  };
}

function clusterLock() {
  return readJson(clusterLockPath, null) || defaultClusterLock();
}

function normalizeClusterLock(body) {
  const current = clusterLock();
  const identity = nodeIdentity();
  const next = {
    ...current,
    cluster: envLike(body.cluster, current.cluster || identity.clusterId),
    active_node: String(body.active_node ?? current.active_node ?? '').trim(),
    this_node: envLike(body.this_node, current.this_node || identity.nodeName),
    allow_promotion: body.allow_promotion === true,
    last_valid_standby: body.last_valid_standby === undefined ? current.last_valid_standby || null : (String(body.last_valid_standby || '').trim() || null),
    reason: String(body.reason ?? current.reason ?? '').trim(),
    updated_at: new Date().toISOString()
  };
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(next.cluster)) throw new Error('cluster invalido');
  if (next.active_node && !/^[A-Za-z0-9_.-]{1,80}$/.test(next.active_node)) throw new Error('active_node invalido');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(next.this_node)) throw new Error('this_node invalido');
  if (next.allow_promotion && !next.reason) throw new Error('informe o motivo para permitir promocao');
  return next;
}

function writeClusterLock(body) {
  ensureStateDir();
  const next = normalizeClusterLock(body);
  fs.writeFileSync(clusterLockPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  appendEvent(next.allow_promotion ? 'CLUSTER_PROMOTION_ALLOWED' : 'CLUSTER_PROMOTION_BLOCKED', {
    cluster: next.cluster,
    activeNode: next.active_node,
    thisNode: next.this_node,
    reason: next.reason
  });
  return next;
}

function blockClusterPromotion(reason = '') {
  return writeClusterLock({ ...clusterLock(), allow_promotion: false, reason: String(reason || 'promocao bloqueada').trim() });
}

function clusterGuard() {
  const identity = nodeIdentity();
  const lock = clusterLock();
  const mode = identity.deploymentMode || 'simple';
  const activeNode = String(lock.active_node || '').trim();
  const thisNode = identity.nodeName;
  const isHa = mode === 'ha';
  const noActiveDefined = !activeNode;
  const isLocalActive = !isHa || activeNode === thisNode || (noActiveDefined && identity.nodeRole === 'primary');
  const returnedFormerPrimary = isHa && identity.nodeRole === 'primary' && activeNode && activeNode !== thisNode;
  const standbyWaiting = isHa && ['standby', 'recovery'].includes(identity.nodeRole) && activeNode !== thisNode;
  const canPromote = isHa && identity.nodeRole === 'standby' && lock.allow_promotion === true && activeNode !== thisNode;
  const canHoldVip = !returnedFormerPrimary && isLocalActive && identity.nodeRole !== 'recovery';
  const canServeProduction = canHoldVip && identity.nodeRole !== 'recovery';
  let status = 'ok';
  let reason = 'nó autorizado';
  if (returnedFormerPrimary) {
    status = 'blocked';
    reason = `nó era primary, mas o ativo atual é ${activeNode}`;
  } else if (identity.nodeRole === 'recovery') {
    status = 'maintenance';
    reason = 'nó em recuperação/ressincronização';
  } else if (standbyWaiting && !canPromote) {
    status = 'standby';
    reason = activeNode ? `standby aguardando ativo ${activeNode}` : 'standby aguardando promoção';
  } else if (canPromote) {
    status = 'promotion-allowed';
    reason = 'promoção autorizada pelo cluster-lock';
  }
  return {
    status,
    reason,
    cluster: lock.cluster || identity.clusterId,
    thisNode,
    nodeRole: identity.nodeRole,
    activeNode,
    allowPromotion: lock.allow_promotion === true,
    canHoldVip,
    canServeProduction,
    canPromote,
    returnedFormerPrimary,
    updatedAt: new Date().toISOString()
  };
}

function activateLocalNode(body = {}) {
  const identity = nodeIdentity();
  const lock = clusterLock();
  const reason = String(body.reason || lock.reason || '').trim();
  const activeNode = String(lock.active_node || '').trim();
  if (identity.deploymentMode === 'ha') {
    if (identity.nodeRole === 'recovery') throw new Error('nó em recuperação não pode ser ativado sem trocar o papel primeiro');
    if (identity.nodeRole === 'primary' && activeNode && activeNode !== identity.nodeName) throw new Error(`outro nó já está ativo: ${activeNode}`);
    if (identity.nodeRole === 'standby' && activeNode !== identity.nodeName && lock.allow_promotion !== true) {
      throw new Error('promoção não autorizada no cluster-lock');
    }
  }
  if (!reason) throw new Error('informe o motivo/confirmacao para ativar este nó');
  const nextLock = writeClusterLock({
    ...lock,
    cluster: identity.clusterId,
    active_node: identity.nodeName,
    this_node: identity.nodeName,
    allow_promotion: false,
    reason
  });
  appendEvent('CLUSTER_LOCAL_NODE_ACTIVATED', { cluster: identity.clusterId, nodeName: identity.nodeName, nodeRole: identity.nodeRole, reason });
  return { lock: nextLock, guard: clusterGuard() };
}

function putLocalNodeInRecovery(body = {}) {
  const identity = writeNodeIdentity({ ...nodeIdentity(), nodeRole: 'recovery' });
  const lock = blockClusterPromotion(String(body.reason || 'nó colocado em recuperação para evitar duplo primary').trim());
  appendEvent('CLUSTER_NODE_RECOVERY_MODE', { cluster: identity.clusterId, nodeName: identity.nodeName, reason: lock.reason });
  return { identity, lock, guard: clusterGuard() };
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((acc, part) => ((acc << 8) >>> 0) + part, 0) >>> 0;
}

function parseIpv4Cidr(value) {
  const match = String(value || '').trim().match(/^((?:\d{1,3}\.){3}\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!match) return null;
  const ipInt = ipv4ToInt(match[1]);
  const prefixLength = Number(match[2] || 32);
  if (ipInt === null || prefixLength < 0 || prefixLength > 32) return null;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return { address: match[1], prefixLength, network: ipInt & mask, mask };
}

function sameIpv4Subnet(left, right) {
  const a = parseIpv4Cidr(left);
  const b = parseIpv4Cidr(right);
  if (!a || !b) return null;
  const prefixLength = Math.min(a.prefixLength, b.prefixLength);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(a.address) & mask) === (ipv4ToInt(b.address) & mask);
}

function rawHaSyncSettings() {
  return {
    enabled: true,
    autoEnabled: true,
    intervalMinutes: 10,
    standbyHost: process.env.HA_SYNC_STANDBY_HOST || '',
    sshUser: process.env.HA_SYNC_SSH_USER || 'tronsoftos',
    sshPort: Number(process.env.HA_SYNC_SSH_PORT || 22),
    remoteBackupDir: process.env.HA_SYNC_REMOTE_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups',
    remoteCatalogDir: process.env.HA_SYNC_REMOTE_CATALOG_DIR || '/opt/tronos/state/tronfire-catalog',
    backupDir: process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups',
    catalogDir: process.env.TRONFIRE_CATALOG_EXPORT_DIR || path.join(stateDir, 'tronfire-catalog'),
    ...readJson(haSyncSettingsPath, {})
  };
}

function publicHaSyncSettings(settings = rawHaSyncSettings()) {
  return {
    enabled: true,
    autoEnabled: true,
    intervalMinutes: Number(settings.intervalMinutes || 10),
    standbyHost: settings.standbyHost || '',
    sshUser: settings.sshUser || 'tronsoftos',
    sshPort: Number(settings.sshPort || 22),
    remoteBackupDir: settings.remoteBackupDir || '/opt/tronfire-storage/firebird/backups',
    remoteCatalogDir: settings.remoteCatalogDir || '/opt/tronos/state/tronfire-catalog',
    backupDir: settings.backupDir || '/opt/tronfire-storage/firebird/backups',
    catalogDir: settings.catalogDir || path.join(stateDir, 'tronfire-catalog')
  };
}

function haSyncStatus() {
  const settings = publicHaSyncSettings();
  const lastEvent = readEvents(200).find(event => ['HA_SYNC_STARTED', 'HA_SYNC_FINISHED', 'HA_SYNC_FAILED'].includes(event.type)) || null;
  const runningJob = [...actionJobs.values()].reverse().find(job => job.app === 'ha-sync' && job.status === 'running') || null;
  const receiverCatalogPath = settings.catalogDir || path.join(stateDir, 'tronfire-catalog');
  const receiverBackupPath = settings.backupDir || '/opt/tronfire-storage/firebird/backups';
  const latestCatalog = latestFileInfo(receiverCatalogPath, /\.(dump)$/i);
  const latestBackup = latestFileInfo(receiverBackupPath, /\.(gbk|fbk|gbk\.gz|fbk\.gz|manifest\.json)$/i);
  const lastExitCode = lastEvent?.details?.exitCode;
  const intervalMinutes = Number(settings.intervalMinutes || 10);
  const lastSyncAtMs = lastEvent?.createdAt ? new Date(lastEvent.createdAt).getTime() : 0;
  const nextRunAt = settings.enabled && settings.autoEnabled && lastSyncAtMs
    ? new Date(lastSyncAtMs + intervalMinutes * 60 * 1000).toISOString()
    : settings.enabled && settings.autoEnabled
      ? new Date().toISOString()
      : null;
  const lastBackupAtMs = latestBackup?.modifiedAt ? new Date(latestBackup.modifiedAt).getTime() : 0;
  const standbyLagMinutes = lastBackupAtMs ? Math.max(0, Math.round((Date.now() - lastBackupAtMs) / 60000)) : null;
  const standbyReady = !!latestCatalog && !!latestBackup && (standbyLagMinutes === null || standbyLagMinutes <= intervalMinutes * 2);
  let status = 'disabled';
  if (runningJob) status = 'running';
  else if (settings.enabled && !settings.standbyHost) status = 'warning';
  else if (settings.enabled && lastEvent?.type === 'HA_SYNC_FINISHED') status = 'success';
  else if (settings.enabled && lastEvent?.type === 'HA_SYNC_FAILED') status = 'failed';
  else if (settings.enabled && lastEvent?.type === 'HA_SYNC_STARTED') status = 'running';
  else if (settings.enabled) status = 'enabled';
  return {
    ...settings,
    status,
    lastEvent: lastEvent ? {
      type: lastEvent.type,
      createdAt: lastEvent.createdAt,
      exitCode: Number.isInteger(lastExitCode) ? lastExitCode : null,
      error: lastEvent.details?.error || null
    } : null,
    runningJobId: runningJob?.id || null,
    nextRunAt,
    standbyLagMinutes,
    standbyReady,
    promotionReady: standbyReady && status !== 'failed',
    receiver: {
      catalogDir: receiverCatalogPath,
      backupDir: receiverBackupPath,
      latestCatalog,
      latestBackup
    }
  };
}

function latestFileInfo(dirPath, pattern) {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => {
        const filePath = path.join(dirPath, entry.name);
        const stat = fs.statSync(filePath);
        return { name: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return files[0] || null;
  } catch {
    return null;
  }
}

function normalizeHaSyncSettings(body) {
  const current = rawHaSyncSettings();
  const next = {
    enabled: true,
    autoEnabled: true,
    intervalMinutes: Number(body.intervalMinutes || current.intervalMinutes || 10),
    standbyHost: String(body.standbyHost || '').trim(),
    sshUser: String(body.sshUser || current.sshUser || 'tronsoftos').trim(),
    sshPort: Number(body.sshPort || current.sshPort || 22),
    remoteBackupDir: String(body.remoteBackupDir || current.remoteBackupDir || '/opt/tronfire-storage/firebird/backups').trim(),
    remoteCatalogDir: String(body.remoteCatalogDir || current.remoteCatalogDir || '/opt/tronos/state/tronfire-catalog').trim(),
    backupDir: String(body.backupDir || current.backupDir || '/opt/tronfire-storage/firebird/backups').trim(),
    catalogDir: String(body.catalogDir || current.catalogDir || path.join(stateDir, 'tronfire-catalog')).trim()
  };
  if (next.enabled && !next.standbyHost) throw new Error('host standby nao informado');
  if (!Number.isInteger(next.intervalMinutes) || next.intervalMinutes < 2 || next.intervalMinutes > 1440) throw new Error('intervalo automatico deve ficar entre 2 e 1440 minutos');
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(next.sshUser)) throw new Error('usuario SSH invalido');
  if (!Number.isInteger(next.sshPort) || next.sshPort < 1 || next.sshPort > 65535) throw new Error('porta SSH invalida');
  for (const key of ['remoteBackupDir', 'remoteCatalogDir', 'backupDir', 'catalogDir']) {
    if (!next[key].startsWith('/')) throw new Error(`${key} deve ser caminho absoluto`);
  }
  return next;
}

function writeHaSyncSettings(body) {
  const guard = clusterGuard();
  if (nodeIdentity().deploymentMode === 'ha' && guard.canServeProduction !== true) {
    throw new Error('Sync HA deve ser configurado no no primary/ativo');
  }
  ensureStateDir();
  const settings = normalizeHaSyncSettings(body);
  fs.writeFileSync(haSyncSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  appendEvent('HA_SYNC_SETTINGS_UPDATED', { enabled: settings.enabled, standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort });
  return publicHaSyncSettings(settings);
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

function smtpReadline(socket, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout SMTP'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = err => {
      cleanup();
      reject(err);
    };
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3}\s/.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpReadline(socket);
  if (!expected.test(response)) throw new Error(`SMTP falhou em ${command || 'greeting'}: ${response.trim()}`);
  return response;
}

async function sendSmtpMessage(settings, subject, body) {
  if (!settings.enabled || !settings.host || !settings.to || !settings.from) return false;
  const socket = settings.secure
    ? tls.connect({ host: settings.host, port: settings.port || 465, servername: settings.host })
    : net.connect({ host: settings.host, port: settings.port || 587 });
  await smtpCommand(socket, null);
  await smtpCommand(socket, `EHLO ${nodeIdentity().nodeName || 'tronsoftos'}`);
  if (!settings.secure && settings.port === 587) {
    await smtpCommand(socket, 'STARTTLS');
    const secureSocket = tls.connect({ socket, servername: settings.host });
    await smtpCommand(secureSocket, `EHLO ${nodeIdentity().nodeName || 'tronsoftos'}`);
    return sendSmtpMessageOnSocket(secureSocket, settings, subject, body);
  }
  return sendSmtpMessageOnSocket(socket, settings, subject, body);
}

async function sendSmtpMessageOnSocket(socket, settings, subject, body) {
  if (settings.user && settings.password) {
    await smtpCommand(socket, 'AUTH LOGIN', /^334/);
    await smtpCommand(socket, Buffer.from(settings.user).toString('base64'), /^334/);
    await smtpCommand(socket, Buffer.from(settings.password).toString('base64'));
  }
  const recipients = String(settings.to).split(',').map(item => item.trim()).filter(Boolean);
  await smtpCommand(socket, `MAIL FROM:<${settings.from.replace(/^.*<|>.*$/g, '')}>`);
  for (const recipient of recipients) await smtpCommand(socket, `RCPT TO:<${recipient.replace(/^.*<|>.*$/g, '')}>`);
  await smtpCommand(socket, 'DATA', /^354/);
  const message = [
    `From: ${settings.from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${settings.subjectPrefix || '[TronSoftOS]'} ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body.replace(/\n\./g, '\n..'),
    '.'
  ].join('\r\n');
  socket.write(`${message}\r\n`);
  await smtpCommand(socket, null);
  await smtpCommand(socket, 'QUIT', /^[23]/).catch(() => null);
  socket.end();
  return true;
}

async function notifyCriticalAlerts(alerts) {
  const settings = readJson(smtpSettingsPath, {});
  if (settings.enabled !== true) return;
  const critical = alerts.filter(alert => ['critical', 'critico', 'danger'].includes(String(alert.severity || '').toLowerCase()));
  for (const alert of critical) {
    const key = `${alert.source || 'TronSoftOS'}:${alert.type || alert.message}`;
    const lastSent = smtpAlertSentAt.get(key) || 0;
    if (Date.now() - lastSent < 30 * 60 * 1000) continue;
    try {
      await sendSmtpMessage(settings, alert.message || 'Alerta critico', [
        `Origem: ${alert.source || 'TronSoftOS'}`,
        `Severidade: ${alert.severity}`,
        `Mensagem: ${alert.message}`,
        `No: ${nodeIdentity().nodeName}`,
        `Quando: ${new Date().toISOString()}`
      ].join('\n'));
      smtpAlertSentAt.set(key, Date.now());
      appendEvent('SMTP_ALERT_SENT', { key, message: alert.message });
    } catch (err) {
      appendEvent('SMTP_ALERT_FAILED', { key, error: err.message });
    }
  }
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

function normalizeRemoteBackupPath(value) {
  const remotePath = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!remotePath || remotePath.includes('..') || remotePath.startsWith('-')) throw new Error('backup remoto invalido');
  if (!/\.(gbk|fbk|gbk\.gz|fbk\.gz|manifest\.json)$/i.test(remotePath)) throw new Error('tipo de backup remoto invalido');
  return remotePath;
}

function rcloneRemoteObject(settings, remotePath) {
  const target = rcloneTarget(settings).replace(/\/+$/g, '');
  return `${target}/${remotePath.replace(/^\/+/, '')}`;
}

async function rcloneRemoteBackups() {
  const settings = rawRcloneSettings();
  if (!settings.remote) throw new Error('remote rclone nao configurado');
  if (!fs.existsSync(settings.config || defaultRcloneConfigPath())) throw new Error('rclone.conf nao encontrado');
  const out = await run(settings.bin || '/usr/bin/rclone', [
    'lsjson',
    rcloneTarget(settings),
    '--files-only',
    '--recursive',
    '--include', '*.gbk',
    '--include', '*.fbk',
    '--include', '*.gbk.gz',
    '--include', '*.fbk.gz',
    '--include', '*.manifest.json',
    '--config', settings.config || defaultRcloneConfigPath()
  ], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 10
  });
  const rows = JSON.parse(out.stdout || '[]');
  const files = Array.isArray(rows) ? rows
    .filter(item => !item.IsDir && /\.(gbk|fbk|gbk\.gz|fbk\.gz|manifest\.json)$/i.test(item.Path || item.Name || ''))
    .map(item => ({
      name: item.Name || path.basename(item.Path || ''),
      path: item.Path || item.Name || '',
      size: Number(item.Size || 0),
      modifiedAt: item.ModTime || null,
      mimeType: item.MimeType || null
    }))
    .sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0)) : [];
  return { target: rcloneTarget(settings), files };
}

function startRcloneRemoteBackupDownload(body = {}) {
  const settings = rawRcloneSettings();
  if (!settings.remote) throw new Error('remote rclone nao configurado');
  if (!fs.existsSync(settings.config || defaultRcloneConfigPath())) throw new Error('rclone.conf nao encontrado');
  const remotePath = normalizeRemoteBackupPath(body.path);
  const backupDir = process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups';
  const localName = path.basename(remotePath).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const localPath = path.join(backupDir, localName);
  fs.mkdirSync(backupDir, { recursive: true });
  return startCommandJob({
    app: 'rclone',
    action: 'download',
    command: settings.bin || '/usr/bin/rclone',
    args: [
      'copyto',
      rcloneRemoteObject(settings, remotePath),
      localPath,
      '--config',
      settings.config || defaultRcloneConfigPath()
    ],
    eventPrefix: 'RCLONE'
  });
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

async function rcloneAbout() {
  const settings = rawRcloneSettings();
  if (!settings.remote || !settings.configConfigured) return null;
  const cacheKey = `${settings.bin || '/usr/bin/rclone'}|${settings.config || defaultRcloneConfigPath()}|${rcloneTarget(settings)}`;
  if (rcloneQuotaCache.key === cacheKey && Date.now() - rcloneQuotaCache.checkedAt < 5 * 60 * 1000) {
    return rcloneQuotaCache.value;
  }
  try {
    const out = await run(settings.bin || '/usr/bin/rclone', ['about', rcloneTarget(settings), '--json', '--config', settings.config || defaultRcloneConfigPath()], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 2
    });
    const quota = JSON.parse(out.stdout || '{}');
    const total = Number(quota.total || 0);
    const used = Number(quota.used || 0);
    const free = Number(quota.free || 0);
    const percentUsed = total > 0 ? Math.round((used / total) * 1000) / 10 : null;
    const value = {
      ok: true,
      target: rcloneTarget(settings),
      total,
      used,
      free,
      percentUsed,
      raw: quota
    };
    rcloneQuotaCache = { key: cacheKey, checkedAt: Date.now(), value };
    return value;
  } catch (err) {
    const value = { ok: false, target: rcloneTarget(settings), error: err.message };
    rcloneQuotaCache = { key: cacheKey, checkedAt: Date.now(), value };
    return value;
  }
}

async function diskUsageForPath(targetPath) {
  if (process.platform === 'win32') return null;
  const dirPath = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);
  try {
    const out = await run('df', ['-Pk', dirPath], { timeout: 10_000, maxBuffer: 256 * 1024 });
    const lines = out.stdout.trim().split(/\r?\n/);
    const columns = lines.at(-1)?.trim().split(/\s+/) || [];
    const sizeKb = Number(columns[1] || 0);
    const usedKb = Number(columns[2] || 0);
    const availableKb = Number(columns[3] || 0);
    const percentUsed = Number(String(columns[4] || '').replace('%', ''));
    return {
      ok: true,
      path: dirPath,
      filesystem: columns[0] || '',
      total: sizeKb * 1024,
      used: usedKb * 1024,
      free: availableKb * 1024,
      percentUsed: Number.isFinite(percentUsed) ? percentUsed : null
    };
  } catch (err) {
    return { ok: false, path: dirPath, error: err.message };
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
    publicUrl: appAccessUrl(app),
    containers: app.containers || [],
    haAware: !!app.haAware
  };
}

function appAccessUrl(app) {
  if (app.name === 'tronfire') {
    return process.env.TRONFIRE_PROXY_PATH || '/tronfire/';
  }
  if (app.publicUrl || app.accessUrl) return app.publicUrl || app.accessUrl;
  if (app.name === 'troncomanda') {
    const env = parseEnvFile(path.join(appRoot, 'apps/troncomanda/.env'));
    if (env.TRONCOMANDA_PUBLIC_URL) return env.TRONCOMANDA_PUBLIC_URL;
    if (env.TRONCOMANDA_LAN_HOST && env.TRONCOMANDA_WEB_PORT) return `http://${env.TRONCOMANDA_LAN_HOST}:${env.TRONCOMANDA_WEB_PORT}`;
  }
  return app.healthUrl ? app.healthUrl.replace(/\/health\/?$/, '/') : null;
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd || appRoot,
    env: options.env || process.env,
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
    return parseEnvText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function internalTokenValue() {
  return process.env.TRONSOFTOS_INTERNAL_TOKEN || parseEnvFile(clusterSecretsPath).TRONSOFTOS_INTERNAL_TOKEN || '';
}

function parseEnvText(text) {
  return String(text || '')
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
}

function normalizePairingContent(content) {
  const env = parseEnvText(content);
  const required = ['SESSION_SECRET', 'TRONSOFTOS_INTERNAL_TOKEN', 'POSTGRES_PASSWORD', 'FIREBIRD_PASSWORD'];
  const normalized = {};
  for (const key of required) {
    const value = String(env[key] || '').trim();
    if (!value) throw new Error(`${key} ausente no arquivo de pareamento`);
    if (!/^[A-Za-z0-9+/=_.:@-]{4,256}$/.test(value)) throw new Error(`${key} possui caracteres invalidos`);
    normalized[key] = value;
  }
  const sshPublicKey = String(env.TRONSOFTOS_SSH_PUBLIC_KEY || '').trim();
  if (sshPublicKey) {
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: [A-Za-z0-9_.@:-]+)?$/.test(sshPublicKey)) {
      throw new Error('TRONSOFTOS_SSH_PUBLIC_KEY invalida');
    }
    normalized.TRONSOFTOS_SSH_PUBLIC_KEY = sshPublicKey;
  }
  if (env.HA_VIP_CIDR || env.HA_VIP || env.HA_ROUTER_ID || env.HA_AUTH_PASS) {
    const rawVipCidr = String(env.HA_VIP_CIDR || '').trim();
    const rawVip = String(env.HA_VIP || '').trim();
    const vipCidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(rawVipCidr)
      ? rawVipCidr
      : /^(\d{1,3}\.){3}\d{1,3}$/.test(rawVip)
        ? `${rawVip}/24`
        : '';
    const vip = String(rawVip || (vipCidr ? vipCidr.split('/')[0] : '')).trim();
    const routerId = String(env.HA_ROUTER_ID || '').trim();
    const authPass = String(env.HA_AUTH_PASS || '').trim();
    const keepalivedComplete = vipCidr && vip && routerId && authPass;
    if (keepalivedComplete) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(vip)) throw new Error('HA_VIP invalido no arquivo de pareamento');
      if (!/^\d{1,3}$/.test(routerId) || Number(routerId) < 1 || Number(routerId) > 255) throw new Error('HA_ROUTER_ID invalido no arquivo de pareamento');
      if (!/^[A-Za-z0-9_.:-]{6,32}$/.test(authPass)) throw new Error('HA_AUTH_PASS invalido no arquivo de pareamento');
      normalized.HA_VIP = vip;
      normalized.HA_VIP_CIDR = vipCidr;
      normalized.HA_ROUTER_ID = routerId;
      normalized.HA_AUTH_PASS = authPass;
    }
  }
  const optionalKeys = ['TRONSOFTOS_SSH_PUBLIC_KEY', 'HA_VIP', 'HA_VIP_CIDR', 'HA_ROUTER_ID', 'HA_AUTH_PASS'].filter(key => normalized[key]);
  const keys = [...required, ...optionalKeys];
  return {
    values: normalized,
    content: `${keys.map(key => `${key}='${normalized[key]}'`).join('\n')}\n`
  };
}

function exportPairingContent() {
  const base = fs.existsSync(clusterSecretsPath) ? parseEnvText(fs.readFileSync(clusterSecretsPath, 'utf8')) : {};
  const current = {
    ...base,
    SESSION_SECRET: base.SESSION_SECRET || process.env.SESSION_SECRET || '',
    TRONSOFTOS_INTERNAL_TOKEN: base.TRONSOFTOS_INTERNAL_TOKEN || process.env.TRONSOFTOS_INTERNAL_TOKEN || '',
    POSTGRES_PASSWORD: base.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || '',
    FIREBIRD_PASSWORD: base.FIREBIRD_PASSWORD || process.env.FIREBIRD_PASSWORD || '',
    TRONSOFTOS_SSH_PUBLIC_KEY: base.TRONSOFTOS_SSH_PUBLIC_KEY || process.env.TRONSOFTOS_SSH_PUBLIC_KEY || '',
    HA_VIP: process.env.HA_VIP || base.HA_VIP || '',
    HA_VIP_CIDR: process.env.HA_VIP_CIDR || base.HA_VIP_CIDR || ((process.env.HA_VIP || base.HA_VIP) ? `${process.env.HA_VIP || base.HA_VIP}/24` : ''),
    HA_ROUTER_ID: process.env.HA_ROUTER_ID || base.HA_ROUTER_ID || '',
    HA_AUTH_PASS: process.env.HA_AUTH_PASS || base.HA_AUTH_PASS || ''
  };
  return normalizePairingContent(Object.entries(current)
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => `${key}='${String(value).replace(/'/g, "'\\''")}'`)
    .join('\n')).content;
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

async function tronfireAlerts() {
  const token = process.env.TRONSOFTOS_INTERNAL_TOKEN || '';
  if (!token) return [];
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(new URL('/api/internal/alerts', target), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const alerts = await response.json();
    return Array.isArray(alerts) ? alerts.map(alert => ({
      source: 'TronFire',
      severity: String(alert.severity || 'warning').toLowerCase(),
      message: alert.message || alert.type || 'Alerta TronFire',
      type: alert.type || null,
      createdAt: alert.createdAt || null
    })) : [];
  } catch {
    return [];
  }
}

async function tronfireHaStatus() {
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(new URL('/api/ha/status', target), { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const payload = await response.json();
    const databases = Array.isArray(payload.databases) ? payload.databases : [];
    const activeDatabases = databases.filter(db => db.standbyRequiredForPromotion !== false);
    const readyDatabases = activeDatabases.filter(db => String(db.standbyStatus || '').toUpperCase() === 'READY');
    const latestBackupAt = activeDatabases
      .map(db => db.lastStandbyBackupAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const latestValidatedAt = activeDatabases
      .map(db => db.lastStandbyValidatedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    return {
      ok: true,
      deploymentMode: payload.deploymentMode || null,
      nodeRole: payload.nodeRole || null,
      databaseCount: activeDatabases.length,
      readyCount: readyDatabases.length,
      allReady: activeDatabases.length > 0 && readyDatabases.length === activeDatabases.length,
      latestBackupAt,
      latestValidatedAt,
      databases: activeDatabases.map(db => ({
        alias: db.alias,
        name: db.name,
        standbyStatus: db.standbyStatus,
        lastStandbyBackupAt: db.lastStandbyBackupAt,
        lastStandbyValidatedAt: db.lastStandbyValidatedAt
      }))
    };
  } catch {
    return null;
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
    const disabledAndStopped = app.enabled === false && running === 0;
    apps.push({
      ...publicApp(app),
      containers,
      health,
      status: disabledAndStopped ? 'disabled' : health.ok ? 'online' : running > 0 ? 'degraded' : 'offline'
    });
  }
  return apps;
}

function clusterStatus() {
  const lock = clusterLock();
  const identity = nodeIdentity();
  const guard = clusterGuard();
  return {
    mode: identity.deploymentMode || process.env.TRONSOFTOS_DEPLOYMENT_MODE || 'simple',
    nodeName: identity.nodeName || process.env.TRONSOFTOS_NODE_NAME || 'local',
    nodeRole: identity.nodeRole || process.env.TRONFIRE_NODE_ROLE || process.env.TRONSOFTOS_NODE_ROLE || 'primary',
    identity,
    vip: process.env.HA_VIP || null,
    vipCidr: process.env.HA_VIP_CIDR || null,
    lockPath: clusterLockPath,
    lock,
    guard,
    maintenance: maintenanceState(),
    keepalived: {
      enabled: process.env.TRONSOFTOS_KEEPALIVED_ENABLED === 'true',
      interface: process.env.HA_INTERFACE || null,
      routerId: process.env.HA_ROUTER_ID || null,
      nodeState: process.env.HA_NODE_ROLE || null,
      priority: process.env.HA_PRIORITY || null
    },
    sync: haSyncStatus()
  };
}

async function backupStatus() {
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
  const [quota, disk] = await Promise.all([
    rcloneAbout(),
    diskUsageForPath(backupDir)
  ]);
  return {
    backupDir,
    rclone,
    quota,
    disk,
    recentFiles: files.slice(0, 20)
  };
}

function rawCloudflareSettings() {
  return {
    enabled: false,
    apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    zoneId: process.env.CLOUDFLARE_ZONE_ID || '',
    recordId: process.env.CLOUDFLARE_RECORD_ID || '',
    recordName: process.env.CLOUDFLARE_RECORD_NAME || '',
    recordType: process.env.CLOUDFLARE_RECORD_TYPE || 'A',
    targetIp: process.env.CLOUDFLARE_TARGET_IP || process.env.HA_VIP || '',
    proxied: process.env.CLOUDFLARE_PROXIED ? process.env.CLOUDFLARE_PROXIED === 'true' : true,
    ttl: Number(process.env.CLOUDFLARE_TTL || 60),
    ...readJson(cloudflareSettingsPath, {})
  };
}

function publicCloudflareSettings(settings = rawCloudflareSettings()) {
  return {
    enabled: settings.enabled === true,
    zoneId: settings.zoneId || '',
    recordId: settings.recordId || '',
    recordName: settings.recordName || null,
    recordType: settings.recordType || 'A',
    targetIp: settings.targetIp || null,
    tokenConfigured: !!settings.apiToken && settings.apiToken !== 'change-me',
    proxied: settings.proxied !== false,
    ttl: Number(settings.ttl || 60)
  };
}

function normalizeCloudflareSettings(body) {
  const current = rawCloudflareSettings();
  const next = {
    enabled: body.enabled === true,
    apiToken: body.apiToken ? String(body.apiToken).trim() : current.apiToken || '',
    zoneId: String(body.zoneId || current.zoneId || '').trim(),
    recordId: String(body.recordId || current.recordId || '').trim(),
    recordName: String(body.recordName || '').trim(),
    recordType: String(body.recordType || 'A').trim().toUpperCase(),
    targetIp: String(body.targetIp || '').trim(),
    proxied: body.proxied !== false,
    ttl: Number(body.ttl || 60)
  };
  if (!['A', 'AAAA', 'CNAME'].includes(next.recordType)) throw new Error('tipo de registro Cloudflare invalido');
  if (next.ttl !== 1 && (next.ttl < 60 || next.ttl > 86400)) throw new Error('TTL Cloudflare invalido');
  if (next.enabled) {
    if (!next.apiToken) throw new Error('token Cloudflare nao informado');
    if (!next.zoneId) throw new Error('zone id Cloudflare nao informado');
    if (!next.recordName) throw new Error('nome do registro Cloudflare nao informado');
    if (!next.targetIp) throw new Error('destino Cloudflare nao informado');
  }
  return next;
}

function writeCloudflareSettings(body) {
  ensureStateDir();
  const settings = normalizeCloudflareSettings(body);
  fs.writeFileSync(cloudflareSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  appendEvent('CLOUDFLARE_SETTINGS_UPDATED', {
    enabled: settings.enabled,
    recordName: settings.recordName,
    recordType: settings.recordType,
    targetIp: settings.targetIp
  });
  return publicCloudflareSettings(settings);
}

async function cloudflareRequest(settings, method, pathname, body = null) {
  if (!settings.apiToken) throw new Error('token Cloudflare nao configurado');
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${settings.apiToken}`,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.[0]?.message || `Cloudflare HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function cloudflareTest() {
  const settings = rawCloudflareSettings();
  if (!settings.zoneId) throw new Error('zone id Cloudflare nao configurado');
  const payload = await cloudflareRequest(settings, 'GET', `/zones/${settings.zoneId}`);
  appendEvent('CLOUDFLARE_TEST_OK', { zoneId: settings.zoneId, name: payload.result?.name });
  return { ok: true, zone: payload.result?.name || settings.zoneId };
}

async function cloudflareSync() {
  const settings = rawCloudflareSettings();
  if (settings.enabled !== true) throw new Error('Cloudflare desabilitado');
  const body = {
    type: settings.recordType || 'A',
    name: settings.recordName,
    content: settings.targetIp,
    ttl: Number(settings.ttl || 60),
    proxied: settings.proxied !== false
  };
  let recordId = settings.recordId || '';
  if (!recordId) {
    const query = new URLSearchParams({ type: body.type, name: body.name });
    const found = await cloudflareRequest(settings, 'GET', `/zones/${settings.zoneId}/dns_records?${query.toString()}`);
    recordId = found.result?.[0]?.id || '';
  }
  const payload = recordId
    ? await cloudflareRequest(settings, 'PUT', `/zones/${settings.zoneId}/dns_records/${recordId}`, body)
    : await cloudflareRequest(settings, 'POST', `/zones/${settings.zoneId}/dns_records`, body);
  const next = writeCloudflareSettings({ ...settings, recordId: payload.result?.id || recordId });
  appendEvent('CLOUDFLARE_DNS_SYNCED', { recordName: next.recordName, targetIp: next.targetIp });
  return { ok: true, record: publicCloudflareSettings({ ...settings, recordId: payload.result?.id || recordId }) };
}

function cloudflareStatus() {
  return publicCloudflareSettings();
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
  const identity = nodeIdentity();
  const sync = rawHaSyncSettings();
  if (['stop', 'restart'].includes(action) && identity.deploymentMode === 'ha' && identity.nodeRole === 'primary' && sync.standbyHost && maintenanceState().active !== true) {
    try {
      startStandbyKeepalived('stop', { confirmation: 'SUSPENDER STANDBY' });
      appendEvent('HA_MAINTENANCE_AUTO_BEFORE_FIREBIRD', { action, standbyHost: sync.standbyHost });
    } catch (err) {
      appendEvent('HA_MAINTENANCE_AUTO_BEFORE_FIREBIRD_FAILED', { action, standbyHost: sync.standbyHost, error: err.message });
    }
  }
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

async function clusterNetworkImpact(proposedAddressCidr = '') {
  const [network, syncSettings] = await Promise.all([
    hostNetworkStatus(),
    Promise.resolve(publicHaSyncSettings())
  ]);
  const identity = nodeIdentity();
  const cloudflare = publicCloudflareSettings();
  const currentInterface = network.defaultInterface || network.interfaces?.[0]?.name || null;
  const currentAddress = network.interfaces
    ?.find(item => item.name === currentInterface)?.addresses?.[0]
    || network.interfaces?.[0]?.addresses?.[0]
    || null;
  const proposed = parseIpv4Cidr(proposedAddressCidr) || (currentAddress ? parseIpv4Cidr(currentAddress.cidr) : null);
  const currentCidr = currentAddress?.cidr || null;
  const proposedCidr = proposed ? `${proposed.address}/${proposed.prefixLength}` : '';
  const vip = process.env.HA_VIP || null;
  const vipCidr = vip && proposed ? `${vip}/${proposed.prefixLength}` : null;
  const warnings = [];
  const actions = [];
  if (identity.deploymentMode === 'ha') {
    if (!vip) {
      warnings.push({ level: 'warning', message: 'HA está ativo, mas HA_VIP não está configurado.' });
    } else if (proposed && sameIpv4Subnet(proposedCidr, vipCidr) === false) {
      warnings.push({ level: 'danger', message: `VIP ${vip} não está na mesma faixa do IP ${proposedCidr}.` });
      actions.push('Escolher um VIP na mesma rede do IP real do servidor.');
    }
    if (identity.nodeRole === 'primary' && syncSettings.enabled && !syncSettings.standbyHost) {
      warnings.push({ level: 'warning', message: 'Sync HA está habilitado, mas o IP real do standby não foi informado.' });
    }
    if (identity.nodeRole === 'standby' && currentAddress && syncSettings.standbyHost === currentAddress.address) {
      warnings.push({ level: 'warning', message: 'Este standby parece apontar o Sync HA para ele mesmo.' });
    }
  }
  if (proposed && currentAddress && proposed.address !== currentAddress.address) {
    actions.push('Atualizar o outro nó para usar este novo IP real em SSH/rsync.');
    actions.push('Recriar/reiniciar containers para recarregar arquivos .env que dependem do IP.');
    if (cloudflare.enabled && cloudflare.targetIp === currentAddress.address) {
      warnings.push({ level: 'warning', message: 'Cloudflare aponta para o IP real atual; ao trocar IP, atualize o destino ou use o VIP.' });
      actions.push('Atualizar Cloudflare para o novo IP real ou para o VIP.');
    }
  }
  if (cloudflare.enabled && vip && cloudflare.targetIp && cloudflare.targetIp !== vip) {
    warnings.push({ level: 'info', message: `Cloudflare aponta para ${cloudflare.targetIp}; em HA, o mais estável costuma ser apontar para o VIP ${vip}.` });
  }
  if (identity.deploymentMode === 'ha' && proposed && currentAddress && proposed.address !== currentAddress.address) {
    warnings.push({ level: 'info', message: 'A troca do IP real não altera o VIP automaticamente.' });
  }
  return {
    identity,
    current: {
      interface: currentInterface,
      address: currentAddress?.address || null,
      cidr: currentCidr,
      gateway: network.gateway || null,
      dns: network.dns || []
    },
    proposed: proposed ? { address: proposed.address, cidr: proposedCidr, prefixLength: proposed.prefixLength } : null,
    vip,
    vipSameSubnet: proposed && vip ? sameIpv4Subnet(proposedCidr, vipCidr) : null,
    sync: {
      enabled: syncSettings.enabled,
      standbyHost: syncSettings.standbyHost || null,
      sshUser: syncSettings.sshUser,
      sshPort: syncSettings.sshPort
    },
    cloudflare: {
      enabled: cloudflare.enabled,
      recordName: cloudflare.recordName,
      targetIp: cloudflare.targetIp
    },
    warnings,
    actions: [...new Set(actions)]
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

function assertVipPayload(body) {
  const payload = {
    interfaceName: String(body.interfaceName || '').trim(),
    vipCidr: String(body.vipCidr || '').trim(),
    routerId: Number(body.routerId || 51),
    authPass: String(body.authPass || process.env.HA_AUTH_PASS || '').trim(),
    nodeState: String(body.nodeState || 'BACKUP').trim().toUpperCase(),
    priority: Number(body.priority || 100)
  };
  if (!/^[A-Za-z0-9_.:-]+$/.test(payload.interfaceName)) throw new Error('interface invalida');
  if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(payload.vipCidr)) throw new Error('vip/cidr invalido');
  if (!Number.isInteger(payload.routerId) || payload.routerId < 1 || payload.routerId > 255) throw new Error('router id invalido');
  if (!/^[A-Za-z0-9_.:-]{6,32}$/.test(payload.authPass)) throw new Error('senha VRRP invalida');
  if (!['MASTER', 'BACKUP'].includes(payload.nodeState)) throw new Error('papel keepalived invalido');
  if (!Number.isInteger(payload.priority) || payload.priority < 1 || payload.priority > 254) throw new Error('prioridade invalida');
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

async function hostNetworkVip(body) {
  const payload = assertVipPayload(body);
  const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', [
    'apply-vip',
    appRoot,
    payload.interfaceName,
    payload.vipCidr,
    String(payload.routerId),
    payload.authPass,
    payload.nodeState,
    String(payload.priority)
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 * 2 });
  const result = parseJsonLines(out.stdout).at(-1) || { ok: true };
  appendEvent('HOST_NETWORK_VIP_CONFIGURED', {
    interfaceName: payload.interfaceName,
    vipCidr: payload.vipCidr,
    routerId: payload.routerId,
    nodeState: payload.nodeState,
    priority: payload.priority,
    result
  });
  return {
    ...result,
    reloadRequired: true,
    reloadHint: 'Reinicie TronSoftOS e containers TronFire para carregar os envs atualizados.',
    stderr: out.stderr
  };
}

async function importPairingFile(body) {
  const rawContent = typeof body.content === 'string' ? body.content : '';
  if (!rawContent.trim()) throw new Error('arquivo de pareamento vazio');
  if (Buffer.byteLength(rawContent, 'utf8') > 64 * 1024) throw new Error('arquivo de pareamento muito grande');

  ensureStateDir();
  const pairing = normalizePairingContent(rawContent);
  const importPath = path.join(stateDir, `pairing-import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.env`);
  fs.writeFileSync(importPath, pairing.content, { mode: 0o600 });

  const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', [
    'apply-pairing',
    appRoot,
    importPath
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const result = parseJsonLines(out.stdout).at(-1) || { ok: true };

  process.env.TRONSOFTOS_INTERNAL_TOKEN = pairing.values.TRONSOFTOS_INTERNAL_TOKEN;
  for (const key of ['HA_VIP', 'HA_VIP_CIDR', 'HA_ROUTER_ID', 'HA_AUTH_PASS']) {
    if (pairing.values[key]) process.env[key] = pairing.values[key];
  }
  appendEvent('CLUSTER_PAIRING_IMPORTED', {
    keys: Object.keys(pairing.values),
    clusterSecrets: result.clusterSecrets || clusterSecretsPath,
    tronfireEnv: result.tronfireEnv || path.join(appRoot, 'apps/tronfire/.env'),
    sshKeyImported: result.sshKeyImported === true,
    authorizedKeys: result.authorizedKeys || null
  });
  return {
    ok: true,
    importedKeys: Object.keys(pairing.values),
    sshKeyImported: result.sshKeyImported === true,
    paths: {
      clusterSecrets: result.clusterSecrets || clusterSecretsPath,
      tronsoftosEnv: result.tronsoftosEnv || '/etc/tronsoftos/tronsoftos.env',
      tronfireEnv: result.tronfireEnv || path.join(appRoot, 'apps/tronfire/.env'),
      troncomandaEnvUpdated: result.troncomandaEnvUpdated === true,
      authorizedKeys: result.authorizedKeys || path.join(appRoot, '.ssh/authorized_keys')
    },
    reloadRequired: true,
    reloadHint: 'Reinicie TronSoftOS e TronFire para carregar os segredos importados.',
    stderr: out.stderr
  };
}

function exportPairingFile(reply) {
  let content;
  try {
    content = exportPairingContent();
  } catch (err) {
    return json(reply, 404, { error: err.message || 'cluster-secrets.env not found' });
  }
  reply.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="cluster-secrets.env"',
    'cache-control': 'no-store'
  });
  reply.end(content);
}

async function dashboard() {
  const [apps, tronfireHa] = await Promise.all([appsStatus(), tronfireHaStatus()]);
  const cluster = clusterStatus();
  if (tronfireHa && cluster.sync) {
    cluster.sync.tronfireStandby = tronfireHa;
    const requiredReady = tronfireHa.allReady === true;
    const latestRestoredBackupAt = tronfireHa.latestBackupAt ? new Date(tronfireHa.latestBackupAt).getTime() : 0;
    const latestReceivedBackupAt = cluster.sync.receiver?.latestBackup?.modifiedAt ? new Date(cluster.sync.receiver.latestBackup.modifiedAt).getTime() : 0;
    const latestBackupAtMs = latestRestoredBackupAt || latestReceivedBackupAt;
    const lagMinutes = latestBackupAtMs ? Math.max(0, Math.round((Date.now() - latestBackupAtMs) / 60000)) : null;
    cluster.sync.standbyLagMinutes = lagMinutes;
    cluster.sync.standbyReady = requiredReady && lagMinutes !== null && lagMinutes <= Number(cluster.sync.intervalMinutes || 10) * 2;
    cluster.sync.promotionReady = cluster.sync.standbyReady && cluster.sync.status !== 'failed';
  }
  const backups = await backupStatus();
  const alerts = [];
  if (apps.some(app => app.status === 'offline' && app.enabled)) alerts.push({ severity: 'critical', message: 'App gerenciado offline' });
  if (cluster.mode === 'ha' && !cluster.lock) alerts.push({ severity: 'warning', message: 'Cluster HA sem cluster-lock' });
  if (cluster.sync?.status === 'failed') alerts.push({ severity: 'critical', message: 'Sync HA falhou na ultima execucao' });
  if (cluster.sync?.enabled && cluster.sync?.standbyLagMinutes !== null && cluster.sync.standbyLagMinutes > Number(cluster.sync.intervalMinutes || 10) * 2) {
    alerts.push({ severity: 'warning', message: `Standby atrasado: ${cluster.sync.standbyLagMinutes} min sem backup recebido` });
  }
  if (cluster.sync?.enabled) {
    const intervalMinutes = Number(cluster.sync.intervalMinutes || 10);
    const latestBackupAt = cluster.sync.receiver?.latestBackup?.modifiedAt ? new Date(cluster.sync.receiver.latestBackup.modifiedAt).getTime() : 0;
    const backupAgeMinutes = latestBackupAt ? Math.round((Date.now() - latestBackupAt) / 60000) : null;
    if (backupAgeMinutes === null) {
      alerts.push({ severity: 'warning', message: 'Sync HA sem backup validado disponivel' });
    } else if (backupAgeMinutes > intervalMinutes * 2) {
      alerts.push({ severity: 'warning', message: `Backup validado atrasado: ${backupAgeMinutes} min desde o ultimo arquivo` });
    }
  }
  if (!backups.rclone.remote) alerts.push({ severity: 'warning', message: 'Remote rclone nao configurado' });
  if (backups.disk?.percentUsed >= 97) alerts.push({ severity: 'critical', message: `Disco de backup com ${backups.disk.percentUsed}% de uso` });
  else if (backups.disk?.percentUsed >= 90) alerts.push({ severity: 'warning', message: `Disco de backup com ${backups.disk.percentUsed}% de uso` });
  if (backups.quota?.percentUsed >= 97) alerts.push({ severity: 'critical', message: `Google Drive com ${backups.quota.percentUsed}% de uso` });
  else if (backups.quota?.percentUsed >= 90) alerts.push({ severity: 'warning', message: `Google Drive com ${backups.quota.percentUsed}% de uso` });
  if (backups.quota && backups.quota.ok === false) alerts.push({ severity: 'warning', message: `Falha ao consultar espaco do Google Drive: ${backups.quota.error}` });
  alerts.push(...await tronfireAlerts());
  await notifyCriticalAlerts(alerts);
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
    backups: await backupStatus()
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
  const out = await run('docker', args, { timeout: 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 10, env: dockerEnv() });
  appendEvent(`APP_${action.toUpperCase()}`, { app: app.name, stdout: out.stdout, stderr: out.stderr });
  return out;
}

function appActionCommand(app, action) {
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
  return { command: 'docker', args };
}

function dockerEnv() {
  ensureStateDir();
  fs.mkdirSync(dockerConfigDir, { recursive: true, mode: 0o700 });
  return { ...process.env, DOCKER_CONFIG: dockerConfigDir };
}

function publicActionJob(job) {
  return {
    id: job.id,
    app: job.app,
    action: job.action,
    command: job.command,
    args: job.args,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    stdout: job.stdout,
    stderr: job.stderr
  };
}

function appendActionLog(job, stream, chunk) {
  job[stream] += chunk.toString();
  if (job[stream].length > maxActionLogLength) {
    job[stream] = job[stream].slice(job[stream].length - maxActionLogLength);
  }
}

function startAppAction(app, action) {
  const { command, args } = appActionCommand(app, action);
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    app: app.name,
    action,
    command,
    args,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: ''
  };
  actionJobs.set(id, job);
  const child = spawn(command, args, { cwd: appRoot, env: dockerEnv(), windowsHide: true });
  child.stdout.on('data', chunk => appendActionLog(job, 'stdout', chunk));
  child.stderr.on('data', chunk => appendActionLog(job, 'stderr', chunk));
  child.on('error', err => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    appendEvent(`APP_${action.toUpperCase()}_FAILED`, { app: app.name, error: err.message });
  });
  child.on('close', code => {
    job.exitCode = code;
    job.status = code === 0 ? 'success' : 'failed';
    job.finishedAt = new Date().toISOString();
    appendEvent(`APP_${action.toUpperCase()}`, { app: app.name, exitCode: code, stdout: job.stdout, stderr: job.stderr });
  });
  return publicActionJob(job);
}

function startHaSync() {
  const guard = clusterGuard();
  if (nodeIdentity().deploymentMode === 'ha' && guard.canServeProduction !== true) {
    throw new Error('Sync HA deve ser executado no no primary/ativo');
  }
  const settings = publicHaSyncSettings(rawHaSyncSettings());
  if (settings.enabled !== true) throw new Error('sync HA desabilitado');
  if (!settings.standbyHost) throw new Error('host standby nao configurado');
  const runningJob = [...actionJobs.values()].reverse().find(job => job.app === 'ha-sync' && job.status === 'running');
  if (runningJob) return publicActionJob(runningJob);
  const script = path.join(appRoot, 'scripts/ha-sync-to-standby.sh');
  if (!fs.existsSync(script)) throw new Error(`script nao encontrado: ${script}`);
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    app: 'ha-sync',
    action: 'run',
    command: 'bash',
    args: [script],
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: ''
  };
  actionJobs.set(id, job);
  const internalToken = internalTokenValue();
  if (!internalToken) throw new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado para restore automatico no standby');
  const env = {
    ...process.env,
    TRONSOFTOS_APP_DIR: appRoot,
    TRONSOFTOS_INTERNAL_TOKEN: internalToken,
    HA_SYNC_STANDBY_HOST: settings.standbyHost,
    HA_SYNC_SSH_USER: settings.sshUser || 'tronsoftos',
    HA_SYNC_SSH_PORT: String(settings.sshPort || 22),
    HA_SYNC_REMOTE_BACKUP_DIR: settings.remoteBackupDir || '/opt/tronfire-storage/firebird/backups',
    HA_SYNC_REMOTE_CATALOG_DIR: settings.remoteCatalogDir || '/opt/tronos/state/tronfire-catalog',
    FIREBIRD_BACKUP_DIR: settings.backupDir || '/opt/tronfire-storage/firebird/backups',
    TRONFIRE_CATALOG_EXPORT_DIR: settings.catalogDir || path.join(stateDir, 'tronfire-catalog')
  };
  const child = spawn('bash', [script], { cwd: appRoot, env, windowsHide: true });
  child.stdout.on('data', chunk => appendActionLog(job, 'stdout', chunk));
  child.stderr.on('data', chunk => appendActionLog(job, 'stderr', chunk));
  child.on('error', err => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    appendEvent('HA_SYNC_FAILED', { standbyHost: settings.standbyHost, error: err.message });
  });
  child.on('close', code => {
    job.exitCode = code;
    job.status = code === 0 ? 'success' : 'failed';
    job.finishedAt = new Date().toISOString();
    appendEvent(code === 0 ? 'HA_SYNC_FINISHED' : 'HA_SYNC_FAILED', { standbyHost: settings.standbyHost, exitCode: code, stdout: job.stdout, stderr: job.stderr });
  });
  appendEvent('HA_SYNC_STARTED', { standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort });
  return publicActionJob(job);
}

function shouldRunAutoHaSync(settings) {
  if (!settings.enabled || !settings.autoEnabled || !settings.standbyHost) return false;
  const identity = nodeIdentity();
  if (identity.deploymentMode === 'ha' && clusterGuard().canServeProduction !== true) return false;
  const runningJob = [...actionJobs.values()].reverse().find(job => job.app === 'ha-sync' && job.status === 'running');
  if (runningJob) return false;
  const intervalMs = Math.max(Number(settings.intervalMinutes || 10), 2) * 60 * 1000;
  const lastEvent = readEvents(200).find(event => ['HA_SYNC_STARTED', 'HA_SYNC_FINISHED', 'HA_SYNC_FAILED'].includes(event.type)) || null;
  const lastEventAt = lastEvent?.createdAt ? new Date(lastEvent.createdAt).getTime() : 0;
  const lastRunAt = Math.max(lastEventAt || 0, lastAutoHaSyncStartedAt || 0);
  return !lastRunAt || Date.now() - lastRunAt >= intervalMs;
}

function startHaSyncScheduler() {
  if (haSyncSchedulerTimer) return;
  haSyncSchedulerTimer = setInterval(() => {
    try {
      const settings = publicHaSyncSettings();
      if (!shouldRunAutoHaSync(settings)) return;
      lastAutoHaSyncStartedAt = Date.now();
      appendEvent('HA_SYNC_AUTO_TRIGGERED', { standbyHost: settings.standbyHost, intervalMinutes: settings.intervalMinutes });
      startHaSync();
    } catch (err) {
      appendEvent('HA_SYNC_AUTO_SKIPPED', { error: err.message });
    }
  }, 60 * 1000);
  if (typeof haSyncSchedulerTimer.unref === 'function') haSyncSchedulerTimer.unref();
}

function startCommandJob({ app, action, command, args, env = process.env, cwd = appRoot, eventPrefix = 'MAINTENANCE' }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    app,
    action,
    command,
    args,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: ''
  };
  actionJobs.set(id, job);
  const child = spawn(command, args, { cwd, env, windowsHide: true });
  child.stdout.on('data', chunk => appendActionLog(job, 'stdout', chunk));
  child.stderr.on('data', chunk => appendActionLog(job, 'stderr', chunk));
  child.on('error', err => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    appendEvent(`${eventPrefix}_${action.toUpperCase()}_FAILED`, { app, error: err.message });
  });
  child.on('close', code => {
    job.exitCode = code;
    job.status = code === 0 ? 'success' : 'failed';
    job.finishedAt = new Date().toISOString();
    appendEvent(`${eventPrefix}_${action.toUpperCase()}`, { app, exitCode: code, stdout: job.stdout, stderr: job.stderr });
  });
  return publicActionJob(job);
}

function privilegedCommandArgs(command, args) {
  if (process.getuid && process.getuid() !== 0) {
    return { command: 'sudo', args: [command, ...args] };
  }
  return { command, args };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function requireConfirmation(body, expected) {
  const confirmation = String(body.confirmation || '').trim();
  if (confirmation !== expected) throw new Error(`confirmacao invalida; digite ${expected}`);
}

function maintenanceState() {
  return readJson(maintenanceStatePath, {
    active: false,
    mode: null,
    reason: '',
    standbyHost: null,
    startedAt: null,
    clearedAt: null
  });
}

function writeMaintenanceState(next) {
  ensureStateDir();
  const state = {
    ...maintenanceState(),
    ...next,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(maintenanceStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  appendEvent(state.active ? 'HA_MAINTENANCE_ACTIVE' : 'HA_MAINTENANCE_CLEARED', state);
  return state;
}

async function maintenanceStatus() {
  let localKeepalived = 'unknown';
  try {
    const { stdout } = await run('systemctl', ['is-active', 'keepalived.service'], { timeout: 5000 });
    localKeepalived = stdout.trim() || 'unknown';
  } catch (err) {
    localKeepalived = String(err.stdout || err.message || 'unknown').trim();
  }
  return {
    generatedAt: new Date().toISOString(),
    cluster: clusterStatus(),
    maintenance: maintenanceState(),
    guard: clusterGuard(),
    sync: publicHaSyncSettings(),
    local: {
      keepalived: localKeepalived
    }
  };
}

function startLocalKeepalived(action, body = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('acao keepalived invalida');
  requireConfirmation(body, action === 'stop' ? 'SUSPENDER LOCAL' : action === 'start' ? 'REATIVAR LOCAL' : 'REINICIAR LOCAL');
  const cmd = privilegedCommandArgs('/usr/local/sbin/tronsoftos-network', ['local-keepalived', action]);
  return startCommandJob({ app: 'keepalived-local', action, ...cmd });
}

function startStandbyKeepalived(action, body = {}) {
  if (!['start', 'stop'].includes(action)) throw new Error('acao keepalived invalida');
  requireConfirmation(body, action === 'stop' ? 'SUSPENDER STANDBY' : 'REATIVAR STANDBY');
  const settings = rawHaSyncSettings();
  if (!settings.standbyHost) throw new Error('host standby nao configurado no Sync HA');
  const sshUser = settings.sshUser || 'tronsoftos';
  const sshPort = String(settings.sshPort || 22);
  const remoteCommand = `sudo -n systemctl ${action} keepalived.service`;
  const knownHosts = path.join(stateDir, 'known_hosts');
  const identityFile = path.join(stateDir, 'ssh/id_ed25519');
  if (!fs.existsSync(identityFile)) throw new Error(`chave SSH nao encontrada: ${identityFile}`);
  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
  fs.closeSync(fs.openSync(knownHosts, 'a'));
  if (action === 'stop') {
    writeMaintenanceState({
      active: true,
      mode: 'ha',
      reason: 'failover suspenso no standby',
      standbyHost: settings.standbyHost,
      startedAt: new Date().toISOString(),
      clearedAt: null
    });
  } else {
    writeMaintenanceState({
      active: false,
      mode: 'ha',
      reason: 'failover reativado no standby',
      standbyHost: settings.standbyHost,
      clearedAt: new Date().toISOString()
    });
  }
  return startCommandJob({
    app: 'keepalived-standby',
    action,
    command: 'ssh',
    args: [
      '-p', sshPort,
      '-i', identityFile,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      `${sshUser}@${settings.standbyHost}`,
      remoteCommand
    ]
  });
}

function startHostPower(action, body = {}) {
  if (!['reboot', 'poweroff'].includes(action)) throw new Error('acao de energia invalida');
  requireConfirmation(body, action === 'reboot' ? 'REINICIAR HOST' : 'DESLIGAR HOST');
  const identity = nodeIdentity();
  const settings = rawHaSyncSettings();
  const cmd = privilegedCommandArgs('/usr/local/sbin/tronsoftos-network', ['host-power', action]);
  if ((identity.nodeRole || 'primary') === 'primary' && settings.standbyHost) {
    const sshUser = settings.sshUser || 'tronsoftos';
    const sshPort = String(settings.sshPort || 22);
    const knownHosts = path.join(stateDir, 'known_hosts');
    const identityFile = path.join(stateDir, 'ssh/id_ed25519');
    if (!fs.existsSync(identityFile)) throw new Error(`chave SSH nao encontrada: ${identityFile}`);
    fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
    fs.closeSync(fs.openSync(knownHosts, 'a'));
    writeMaintenanceState({
      active: true,
      mode: 'ha',
      reason: `failover suspenso automaticamente antes de ${action}`,
      standbyHost: settings.standbyHost,
      startedAt: new Date().toISOString(),
      clearedAt: null
    });
    const sshArgs = [
      'ssh',
      '-p', sshPort,
      '-i', identityFile,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      `${sshUser}@${settings.standbyHost}`,
      'sudo -n systemctl stop keepalived.service'
    ];
    const commandLine = [
      ...sshArgs.map(shQuote),
      '&&',
      shQuote(cmd.command),
      ...cmd.args.map(shQuote)
    ].join(' ');
    return startCommandJob({ app: 'host', action, command: '/bin/sh', args: ['-lc', commandLine] });
  }
  return startCommandJob({ app: 'host', action, ...cmd });
}

function dockerRegistryLogin(body) {
  const registry = String(body.registry || 'ghcr.io').trim();
  const username = String(body.username || '').trim();
  const token = String(body.token || '').trim();
  if (!registry) throw new Error('registry obrigatorio');
  if (!username) throw new Error('usuario obrigatorio');
  if (!token) throw new Error('token obrigatorio');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['login', registry, '-u', username, '--password-stdin'], { cwd: appRoot, env: dockerEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout no docker login'));
    }, 60_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      appendEvent(code === 0 ? 'DOCKER_REGISTRY_LOGIN_OK' : 'DOCKER_REGISTRY_LOGIN_FAILED', { registry, username, exitCode: code, stdout, stderr });
      if (code !== 0) return reject(new Error(stderr || stdout || `docker login saiu com codigo ${code}`));
      resolve({ ok: true, registry, username, stdout, stderr });
    });
    child.stdin.end(`${token}\n`);
  });
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

function tronfireProxyTarget() {
  const env = parseEnvFile(path.join(appRoot, 'apps/tronfire/.env'));
  const panelPort = env.TRONFIRE_PANEL_PORT || process.env.TRONFIRE_PANEL_PORT || 8081;
  return new URL(process.env.TRONFIRE_PROXY_TARGET || `http://127.0.0.1:${panelPort}`);
}

function proxyHeaders(headers, target) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) next[key] = value;
  }
  next.host = target.host;
  next['x-forwarded-prefix'] = '/tronfire';
  next['x-forwarded-host'] = headers.host || '';
  next['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'http';
  return next;
}

function proxyTronfire(req, reply) {
  const target = tronfireProxyTarget();
  const upstreamPath = req.url.replace(/^\/tronfire(?=\/|$)/, '') || '/';
  const client = target.protocol === 'https:' ? https : http;
  const request = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: upstreamPath,
    headers: proxyHeaders(req.headers, target)
  }, upstream => {
    const headers = { ...upstream.headers };
    if (typeof headers.location === 'string' && headers.location.startsWith('/')) {
      headers.location = `/tronfire${headers.location}`;
    }
    reply.writeHead(upstream.statusCode || 502, headers);
    upstream.pipe(reply);
  });
  request.on('error', err => {
    json(reply, 502, { error: `TronFire indisponivel em ${target.origin}: ${err.message}` });
  });
  req.pipe(request);
}

async function handleApi(req, reply, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(reply, 200, { ok: true, app: 'TronSoftOS', version: '0.1.0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(reply, 200, await dashboard());
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') return json(reply, 200, await diagnostics());
  if (req.method === 'GET' && url.pathname === '/api/apps') return json(reply, 200, { apps: await appsStatus() });
  if (req.method === 'POST' && url.pathname === '/api/apps/registry-login') return json(reply, 200, await dockerRegistryLogin(await readBody(req)));
  const actionJobMatch = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (req.method === 'GET' && actionJobMatch) {
    const job = actionJobs.get(actionJobMatch[1]);
    if (!job) return json(reply, 404, { error: 'action not found' });
    return json(reply, 200, publicActionJob(job));
  }
  if (req.method === 'GET' && url.pathname === '/api/cluster') return json(reply, 200, clusterStatus());
  if (req.method === 'GET' && url.pathname === '/api/cluster/guard') return json(reply, 200, clusterGuard());
  if (req.method === 'GET' && url.pathname === '/api/cluster/lock') return json(reply, 200, clusterLock());
  if (req.method === 'PATCH' && url.pathname === '/api/cluster/lock') return json(reply, 200, writeClusterLock(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cluster/promotion/block') return json(reply, 200, blockClusterPromotion((await readBody(req).catch(() => ({}))).reason));
  if (req.method === 'POST' && url.pathname === '/api/cluster/activate-local') return json(reply, 200, activateLocalNode(await readBody(req).catch(() => ({}))));
  if (req.method === 'POST' && url.pathname === '/api/cluster/recovery-local') return json(reply, 200, putLocalNodeInRecovery(await readBody(req).catch(() => ({}))));
  if (req.method === 'GET' && url.pathname === '/api/cluster/network-impact') return json(reply, 200, await clusterNetworkImpact(url.searchParams.get('proposed') || ''));
  if (req.method === 'GET' && url.pathname === '/api/cluster/sync') return json(reply, 200, publicHaSyncSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/cluster/sync') return json(reply, 200, writeHaSyncSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cluster/sync/run') return json(reply, 202, { ok: true, job: startHaSync() });
  if (req.method === 'GET' && url.pathname === '/api/node-identity') return json(reply, 200, nodeIdentity());
  if (req.method === 'PATCH' && url.pathname === '/api/node-identity') return json(reply, 200, writeNodeIdentity(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups') return json(reply, 200, await backupStatus());
  if (req.method === 'GET' && url.pathname === '/api/backups/rclone') return json(reply, 200, publicRcloneSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/backups/rclone') return json(reply, 200, writeRcloneSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/test') return json(reply, 200, await rcloneTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/upload-test') return json(reply, 200, await rcloneUploadTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/token') return json(reply, 200, saveGoogleDriveToken(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/rclone/remote-files') return json(reply, 200, await rcloneRemoteBackups());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/download') return json(reply, 202, { ok: true, job: startRcloneRemoteBackupDownload(await readBody(req)) });
  if (req.method === 'GET' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, publicGoogleCredentials());
  if (req.method === 'POST' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, saveGoogleCredentials(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/google/start') return json(reply, 200, startGoogleDriveOauth(req, await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/google/callback') return await completeGoogleDriveOauth(reply, url);
  if (req.method === 'GET' && url.pathname === '/api/cloudflare') return json(reply, 200, cloudflareStatus());
  if (req.method === 'PATCH' && url.pathname === '/api/cloudflare') return json(reply, 200, writeCloudflareSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cloudflare/test') return json(reply, 200, await cloudflareTest());
  if (req.method === 'POST' && url.pathname === '/api/cloudflare/sync') return json(reply, 200, await cloudflareSync());
  if (req.method === 'GET' && url.pathname === '/api/settings/smtp') return json(reply, 200, smtpSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/settings/smtp') return json(reply, 200, writeSmtpSettings(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/events') return json(reply, 200, { events: readEvents(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'GET' && url.pathname === '/api/maintenance') return json(reply, 200, await maintenanceStatus());
  if (req.method === 'POST' && url.pathname === '/api/maintenance/standby/keepalived/stop') return json(reply, 202, { ok: true, job: startStandbyKeepalived('stop', await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/standby/keepalived/start') return json(reply, 202, { ok: true, job: startStandbyKeepalived('start', await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/local/keepalived/stop') return json(reply, 202, { ok: true, job: startLocalKeepalived('stop', await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/local/keepalived/start') return json(reply, 202, { ok: true, job: startLocalKeepalived('start', await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/host/reboot') return json(reply, 202, { ok: true, job: startHostPower('reboot', await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/host/poweroff') return json(reply, 202, { ok: true, job: startHostPower('poweroff', await readBody(req)) });
  if (req.method === 'GET' && url.pathname === '/api/cluster/pairing-file') return exportPairingFile(reply);
  if (req.method === 'POST' && url.pathname === '/api/cluster/pairing-file/import') return json(reply, 200, await importPairingFile(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/host/firebird') return json(reply, 200, await hostFirebirdStatus());
  if (req.method === 'POST' && url.pathname === '/api/host/firebird/aliases') return json(reply, 200, await hostFirebirdAliases(req));
  if (req.method === 'GET' && url.pathname === '/api/host/network') return json(reply, 200, await hostNetworkStatus());
  if (req.method === 'POST' && url.pathname === '/api/host/network/static') return json(reply, 200, await hostNetworkStatic(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/host/network/vip') return json(reply, 200, await hostNetworkVip(await readBody(req)));
  const hostFirebirdMatch = url.pathname.match(/^\/api\/host\/firebird\/(start|stop|restart)$/);
  if (req.method === 'POST' && hostFirebirdMatch) return json(reply, 200, await hostFirebirdAction(hostFirebirdMatch[1]));
  const actionMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/(up|stop|restart|pull)$/);
  if (req.method === 'POST' && actionMatch) {
    await readBody(req).catch(() => ({}));
    const app = findApp(actionMatch[1]);
    if (!app) return json(reply, 404, { error: 'app not found' });
    return json(reply, 202, { ok: true, job: startAppAction(app, actionMatch[2]) });
  }
  return json(reply, 404, { error: 'not found' });
}

const server = http.createServer(async (req, reply) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/tronfire') {
      reply.writeHead(302, { location: '/tronfire/' });
      return reply.end();
    }
    if (url.pathname.startsWith('/tronfire/')) {
      return proxyTronfire(req, reply);
    }
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
  startHaSyncScheduler();
  appendEvent('TRONSOFTOS_STARTED', { port });
  console.log(`TronSoftOS listening on 0.0.0.0:${port}`);
});
