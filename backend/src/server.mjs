import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.TRONSOFTOS_APP_DIR || path.resolve(__dirname, '../..');
const port = Number(process.env.TRONSOFTOS_PORT || 8080);
const friendlyPort = Number(process.env.TRONSOFTOS_FRIENDLY_PORT || 80);
const friendlyPath = normalizeBasePath(process.env.TRONSOFTOS_FRIENDLY_PATH || '/tronsoft');
const configPath = process.env.MANAGED_APPS_CONFIG || path.join(appRoot, 'config/managed-apps.json');
const fallbackConfigPath = path.join(appRoot, 'config/managed-apps.example.json');
const stateDir = process.env.TRONSOFTOS_STATE_DIR || path.join(appRoot, 'state');
const versionPath = path.join(appRoot, 'VERSION');
const buildInfoPath = process.env.TRONSOFTOS_BUILD_INFO || path.join(stateDir, 'build-info.json');
const nodeIdentityPath = process.env.TRONSOFTOS_NODE_IDENTITY || path.join(stateDir, 'node-identity.json');
const clusterLockPath = process.env.TRONSOFTOS_CLUSTER_LOCK || path.join(stateDir, 'cluster-lock.json');
const clusterActivationPath = process.env.TRONSOFTOS_CLUSTER_ACTIVATION || path.join(stateDir, 'cluster-activation.json');
const clusterSecretsPath = process.env.TRONSOFTOS_CLUSTER_SECRETS || path.join(stateDir, 'cluster-secrets.env');
const eventLogPath = process.env.TRONSOFTOS_EVENT_LOG || path.join(stateDir, 'events.jsonl');
const smtpSettingsPath = process.env.TRONSOFTOS_SMTP_SETTINGS || path.join(stateDir, 'smtp-settings.json');
const smtpAlertStatePath = process.env.TRONSOFTOS_SMTP_ALERT_STATE || path.join(stateDir, 'smtp-alert-state.json');
const centralSettingsPath = process.env.TRONSOFTOS_CENTRAL_SETTINGS || path.join(stateDir, 'central-settings.json');
const centralTokenPath = process.env.TRONSOFTOS_CENTRAL_TOKEN_FILE || path.join(stateDir, 'central-installation-token');
const centralAlertStatePath = process.env.TRONSOFTOS_CENTRAL_ALERT_STATE || path.join(stateDir, 'central-alert-state.json');
const cloudflareSettingsPath = process.env.TRONSOFTOS_CLOUDFLARE_SETTINGS || path.join(stateDir, 'cloudflare-settings.json');
const rcloneSettingsPath = process.env.TRONSOFTOS_RCLONE_SETTINGS || path.join(stateDir, 'rclone-settings.json');
const driveSettingsPath = process.env.TRONSOFTOS_DRIVE_SETTINGS || path.join(stateDir, 'drive-settings.json');
const haSyncSettingsPath = process.env.TRONSOFTOS_HA_SYNC_SETTINGS || path.join(stateDir, 'ha-sync-settings.json');
const haFailoverSettingsPath = process.env.TRONSOFTOS_HA_FAILOVER_SETTINGS || path.join(stateDir, 'ha-failover-settings.json');
const maintenanceStatePath = process.env.TRONSOFTOS_MAINTENANCE_STATE || path.join(stateDir, 'maintenance-state.json');
const updateStatusPath = process.env.TRONSOFTOS_UPDATE_STATUS || path.join(stateDir, 'update-status.json');
const googleCredentialsPath = process.env.TRONSOFTOS_GOOGLE_CREDENTIALS || path.join(stateDir, 'google-drive-credentials.json');
const googleOauthDir = process.env.TRONSOFTOS_GOOGLE_OAUTH_DIR || path.join(stateDir, 'google-oauth');
const frontendDist = process.env.TRONSOFTOS_FRONTEND_DIST || path.join(appRoot, 'frontend/dist');
const haSyncLogDir = process.env.TRONSOFTOS_HA_SYNC_LOG_DIR || path.join(appRoot, 'logs', 'ha-sync');
const installerSecretsUrl = process.env.TRONSOFTOS_INSTALLER_SECRETS_URL || 'https://tronsoft.bitrix24.com.br/file/MhJuIFtuaVf1PtvmtsfS';
const FIXED_HA_SYNC_INTERVAL_MINUTES = 3;
const HA_SYNC_CRITICAL_LAG_MINUTES = 20;
const DEFAULT_HA_SYNC_MODE = 'physical';
const UPDATE_MAINTENANCE_TIMEOUT_MINUTES = 30;
const UPDATE_ALLOWED_BRANCHES = new Set(['main', 'dev']);
const SESSION_COOKIE = 'tronsoftos_session';
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const actionJobs = new Map();
const loginFailures = new Map();
const maxActionLogLength = 1024 * 128;
const dockerConfigDir = process.env.TRONSOFTOS_DOCKER_CONFIG || path.join(stateDir, 'docker-config');
let rcloneQuotaCache = { key: null, checkedAt: 0, value: null };
let companyIdentityCache = { checkedAt: 0, value: null };
let haSyncSchedulerTimer = null;
let haSyncSchedulerBusy = false;
let haFailoverWatchdogTimer = null;
let lastAutoHaSyncStartedAt = 0;
let primaryDownSince = 0;
let autoFailoverInProgress = false;
const smtpAlertStates = new Map(Object.entries(readJson(smtpAlertStatePath, {})));
let smtpNotificationInFlight = false;
const centralAlertStates = new Map(Object.entries(readJson(centralAlertStatePath, {})));
let centralAgentTimer = null;
let centralAgentInFlight = false;
let centralDatabaseInfoCache = { checkedAt: 0, value: null };

function normalizeBasePath(value) {
  const text = String(value || '').trim();
  if (!text || text === '/') return '';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function maskSecretValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value
        .replace(/(password|passwd|senha|token|secret|client_secret|refresh_token|access_token)(["'=:\s]+)([^"'\s,}]+)/gi, '$1$2***')
        .replace(/(cts_)[a-z0-9]+/gi, '$1***')
        .replace(/(x-tronsoftos-token:\s*)[^\s'"]+/gi, '$1***')
        .replace(/(download\?token=)[^"'&\s]+/gi, '$1***');
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const sensitive = /^(password|passwd|senha|secret|clientSecret|client_secret|refreshToken|refresh_token|accessToken|access_token|authorization|configContent|token|tunnelToken|installationToken)$/i.test(key);
    return [key, sensitive ? maskSecretValue(item) : redactSecrets(item)];
  }));
}

function json(reply, status, body) {
  const payload = JSON.stringify(redactSecrets(body), null, 2);
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

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator > 0) {
        try {
          cookies[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1));
        } catch {
          cookies[part.slice(0, separator)] = '';
        }
      }
      return cookies;
    }, {});
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionSecret() {
  return internalTokenValue() || parseEnvFile(path.join(appRoot, 'apps/tronfire/.env')).SESSION_SECRET || '';
}

function signSession(payload) {
  const secret = sessionSecret();
  if (!secret) throw Object.assign(new Error('Segredo de sessao nao configurado'), { statusCode: 503 });
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function sessionFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const secret = sessionSecret();
  if (!token || !secret) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!timingSafeEqualText(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!session?.username || Number(session.expiresAt || 0) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieHeader(req, token, maxAge = SESSION_DURATION_SECONDS) {
  const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function requestHasInternalToken(req) {
  const configured = internalTokenValue();
  return Boolean(configured && timingSafeEqualText(req.headers['x-tronsoftos-token'], configured));
}

function loginFailureKey(req, username) {
  return `${req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase().trim()}`;
}

function loginThrottle(req, username) {
  const key = loginFailureKey(req, username);
  const current = loginFailures.get(key);
  if (!current || Date.now() - current.startedAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }
  if (current.count < LOGIN_MAX_FAILURES) return null;
  return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - current.startedAt)) / 1000));
}

function recordLoginFailure(req, username) {
  const key = loginFailureKey(req, username);
  const current = loginFailures.get(key);
  if (!current || Date.now() - current.startedAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, startedAt: Date.now() });
  } else {
    current.count += 1;
  }
}

function clearLoginFailures(req, username) {
  loginFailures.delete(loginFailureKey(req, username));
}

function buildInfo() {
  const version = String(process.env.TRONSOFTOS_VERSION || (fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8') : '0.1.0')).trim() || '0.1.0';
  const saved = readJson(buildInfoPath, {});
  const git = liveGitBuildInfo();
  const commit = git.commit || process.env.TRONSOFTOS_GIT_COMMIT || saved.commit || 'unknown';
  const buildNumber = Number(git.buildNumber || process.env.TRONSOFTOS_BUILD_NUMBER || saved.buildNumber || 0) || null;
  return {
    version: version || saved.version || '0.1.0',
    buildNumber,
    commit,
    branch: git.branch || process.env.TRONSOFTOS_GIT_BRANCH || saved.branch || 'unknown',
    installedAt: saved.installedAt || null,
    generatedAt: new Date().toISOString(),
    source: git.commit ? 'git' : saved.commit ? 'build-info' : 'env'
  };
}

function liveGitBuildInfo() {
  try {
    const git = (args) => execFileSync('git', ['-c', `safe.directory=${appRoot}`, '-C', appRoot, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return {
      commit: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['branch', '--show-current']) || git(['rev-parse', '--abbrev-ref', 'HEAD']),
      buildNumber: Number(git(['rev-list', '--count', 'HEAD'])) || null
    };
  } catch {
    return {};
  }
}

function appendEvent(type, details = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    details: redactSecrets(details),
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

async function setNodeRoleEnv(role) {
  const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', [
    'set-node-role',
    appRoot,
    role
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const result = parseJsonLines(out.stdout).at(-1) || { ok: true, role };
  process.env.TRONSOFTOS_NODE_ROLE = role;
  process.env.TRONFIRE_NODE_ROLE = role;
  return { ...result, stderr: out.stderr };
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

function currentBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return process.env.TRONSOFTOS_BOOT_ID || '';
  }
}

function clusterActivation() {
  return readJson(clusterActivationPath, null);
}

function writeClusterActivation(identity, lock, reason = '') {
  ensureStateDir();
  const activation = {
    cluster: identity.clusterId,
    nodeName: identity.nodeName,
    nodeRole: identity.nodeRole,
    activeNode: lock.active_node || identity.nodeName,
    bootId: currentBootId(),
    reason: String(reason || lock.reason || '').trim(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(clusterActivationPath, `${JSON.stringify(activation, null, 2)}\n`, { mode: 0o600 });
  appendEvent('CLUSTER_LOCAL_ACTIVATION_RECORDED', {
    cluster: activation.cluster,
    nodeName: activation.nodeName,
    nodeRole: activation.nodeRole,
    activeNode: activation.activeNode,
    reason: activation.reason
  });
  return activation;
}

function clearClusterActivation(reason = '') {
  try {
    fs.rmSync(clusterActivationPath, { force: true });
  } catch {}
  appendEvent('CLUSTER_LOCAL_ACTIVATION_CLEARED', { reason: String(reason || '').trim() });
}

function localActivationValid(identity, activeNode) {
  const activation = clusterActivation();
  const bootId = currentBootId();
  const valid = Boolean(
    activation
    && activation.cluster === identity.clusterId
    && activation.nodeName === identity.nodeName
    && activation.nodeRole === 'primary'
    && activation.activeNode === activeNode
    && (!bootId || activation.bootId === bootId)
  );
  return { valid, activation, bootId };
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
  const effectiveActiveNode = activeNode || (identity.nodeRole === 'primary' ? thisNode : '');
  const activation = localActivationValid(identity, effectiveActiveNode);
  const primaryActivationRequired = isHa && identity.nodeRole === 'primary';
  const primaryActivationOk = !primaryActivationRequired || activation.valid;
  const isLocalActive = !isHa || ((activeNode === thisNode || (noActiveDefined && identity.nodeRole === 'primary')) && primaryActivationOk);
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
  } else if (primaryActivationRequired && !activation.valid) {
    status = 'blocked';
    reason = 'primary HA aguardando ativacao local apos boot/failback';
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
    localActivationRequired: primaryActivationRequired,
    localActivationValid: activation.valid,
    localActivationUpdatedAt: activation.activation?.updatedAt || null,
    updatedAt: new Date().toISOString()
  };
}

async function activateLocalNode(body = {}) {
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
  let tronfirePromotion = null;
  let roleEnv = null;
  let tronfireRestart = null;
  let nextIdentity = identity;
  if (identity.deploymentMode === 'ha' && identity.nodeRole === 'standby') {
    tronfirePromotion = await promoteLocalTronfireStandby();
    roleEnv = await setNodeRoleEnv('primary');
    nextIdentity = writeNodeIdentity({ ...identity, nodeRole: 'primary' });
    tronfireRestart = await restartTronfireBackend();
  } else if (identity.deploymentMode === 'ha' && identity.nodeRole === 'primary') {
    roleEnv = await setNodeRoleEnv('primary');
  }
  const nextLock = writeClusterLock({
    ...lock,
    cluster: nextIdentity.clusterId,
    active_node: nextIdentity.nodeName,
    this_node: nextIdentity.nodeName,
    allow_promotion: false,
    reason
  });
  const activation = nextIdentity.deploymentMode === 'ha' && nextIdentity.nodeRole === 'primary'
    ? writeClusterActivation(nextIdentity, nextLock, reason)
    : null;
  appendEvent('CLUSTER_LOCAL_NODE_ACTIVATED', {
    cluster: nextIdentity.clusterId,
    nodeName: nextIdentity.nodeName,
    nodeRole: nextIdentity.nodeRole,
    reason,
    tronfirePromotion: !!tronfirePromotion,
    tronfireRestart
  });
  return { identity: nextIdentity, lock: nextLock, activation, guard: clusterGuard(), tronfirePromotion, roleEnv, tronfireRestart };
}

function putLocalNodeInRecovery(body = {}) {
  const identity = writeNodeIdentity({ ...nodeIdentity(), nodeRole: 'recovery' });
  clearClusterActivation(String(body.reason || 'no colocado em recovery').trim());
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
    sshValidatedAt: null,
    sshValidatedHost: '',
    sshValidatedUser: '',
    syncMode: process.env.HA_SYNC_MODE || DEFAULT_HA_SYNC_MODE,
    intervalMinutes: FIXED_HA_SYNC_INTERVAL_MINUTES,
    standbyHost: process.env.HA_SYNC_STANDBY_HOST || '',
    sshUser: process.env.HA_SYNC_SSH_USER || 'tronsoft',
    sshPort: Number(process.env.HA_SYNC_SSH_PORT || 22),
    remoteBackupDir: process.env.HA_SYNC_REMOTE_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups',
    remoteRestoreDir: process.env.HA_SYNC_REMOTE_RESTORE_DIR || '/opt/tronfire-storage/firebird/restore-work',
    remoteCatalogDir: process.env.HA_SYNC_REMOTE_CATALOG_DIR || '/tmp/tronfire-catalog',
    backupDir: process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups',
    catalogDir: process.env.TRONFIRE_CATALOG_EXPORT_DIR || path.join(stateDir, 'tronfire-catalog'),
    ...readJson(haSyncSettingsPath, {})
  };
}

function publicHaSyncSettings(settings = rawHaSyncSettings()) {
  const syncMode = ['physical', 'backup_restore'].includes(String(settings.syncMode || '').toLowerCase())
    ? String(settings.syncMode).toLowerCase()
    : DEFAULT_HA_SYNC_MODE;
  return {
    enabled: settings.enabled !== false,
    autoEnabled: settings.autoEnabled !== false,
    sshValidated: Boolean(
      settings.sshValidatedAt
      && settings.sshValidatedHost === settings.standbyHost
      && settings.sshValidatedUser === (settings.sshUser || 'tronsoft')
    ),
    sshValidatedAt: settings.sshValidatedAt || null,
    syncMode,
    intervalMinutes: FIXED_HA_SYNC_INTERVAL_MINUTES,
    standbyHost: settings.standbyHost || '',
    sshUser: settings.sshUser || 'tronsoft',
    sshPort: Number(settings.sshPort || 22),
    remoteBackupDir: settings.remoteBackupDir || '/opt/tronfire-storage/firebird/backups',
    remoteRestoreDir: settings.remoteRestoreDir || '/opt/tronfire-storage/firebird/restore-work',
    remoteCatalogDir: settings.remoteCatalogDir || '/tmp/tronfire-catalog',
    backupDir: settings.backupDir || '/opt/tronfire-storage/firebird/backups',
    catalogDir: settings.catalogDir || path.join(stateDir, 'tronfire-catalog')
  };
}

function defaultPrimaryHealthUrl() {
  const fromEnv = process.env.HA_FAILOVER_PRIMARY_HEALTH_URL || process.env.HA_PRIMARY_HEALTH_URL || '';
  if (fromEnv) return fromEnv;
  const host = process.env.HA_PRIMARY_HOST || process.env.PRIMARY_HOST || '';
  return host ? (/^https?:\/\//i.test(host) ? `${host.replace(/\/+$/, '')}/health` : `http://${host}:${port}/health`) : '';
}

function rawHaFailoverSettings() {
  return {
    enabled: true,
    timeoutSeconds: Number(process.env.HA_FAILOVER_TIMEOUT_SECONDS || 60),
    checkIntervalSeconds: Number(process.env.HA_FAILOVER_CHECK_INTERVAL_SECONDS || 5),
    primaryHealthUrl: defaultPrimaryHealthUrl(),
    ...readJson(haFailoverSettingsPath, {})
  };
}

function publicHaFailoverSettings(settings = rawHaFailoverSettings()) {
  return {
    enabled: settings.enabled !== false,
    timeoutSeconds: Math.max(Number(settings.timeoutSeconds || 60), 10),
    checkIntervalSeconds: Math.max(Number(settings.checkIntervalSeconds || 5), 2),
    primaryHealthUrl: String(settings.primaryHealthUrl || '').trim()
  };
}

function writeHaFailoverSettings(body = {}) {
  ensureStateDir();
  const next = {
    enabled: body.enabled !== false,
    timeoutSeconds: Math.max(Number(body.timeoutSeconds || 60), 10),
    checkIntervalSeconds: Math.max(Number(body.checkIntervalSeconds || 5), 2),
    primaryHealthUrl: String(body.primaryHealthUrl || '').trim()
  };
  if (next.enabled && !next.primaryHealthUrl) throw new Error('URL de health do primary nao informada');
  fs.writeFileSync(haFailoverSettingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  appendEvent('HA_FAILOVER_SETTINGS_UPDATED', next);
  restartHaFailoverWatchdog();
  return publicHaFailoverSettings(next);
}

function haSyncStatus() {
  const settings = publicHaSyncSettings();
  const lastEvent = readEvents(200).find(event => ['HA_SYNC_STARTED', 'HA_SYNC_FINISHED', 'HA_SYNC_FAILED', 'HA_SYNC_DEFERRED'].includes(event.type)) || null;
  const runningJob = [...actionJobs.values()].reverse().find(job => job.app === 'ha-sync' && job.status === 'running') || null;
  const receiverCatalogPath = settings.catalogDir || path.join(stateDir, 'tronfire-catalog');
  const receiverBackupPath = settings.backupDir || '/opt/tronfire-storage/firebird/backups';
  const latestCatalog = latestFileInfo(receiverCatalogPath, /\.(dump)$/i);
  const latestBackup = latestFileInfo(receiverBackupPath, /\.(gbk|fbk|gbk\.gz|fbk\.gz)$/i);
  const latestValidatedBackup = latestFileInfo(receiverBackupPath, /\.(manifest\.json)$/i);
  const lastExitCode = lastEvent?.details?.exitCode;
  const intervalMinutes = FIXED_HA_SYNC_INTERVAL_MINUTES;
  const lastSyncAtMs = lastEvent?.createdAt ? new Date(lastEvent.createdAt).getTime() : 0;
  const nextRunAt = settings.enabled && settings.autoEnabled && lastSyncAtMs
    ? new Date(lastSyncAtMs + intervalMinutes * 60 * 1000).toISOString()
    : settings.enabled && settings.autoEnabled
      ? new Date().toISOString()
      : null;
  const lastBackupAtMs = latestValidatedBackup?.modifiedAt ? new Date(latestValidatedBackup.modifiedAt).getTime() : 0;
  const standbyLagMinutes = lastBackupAtMs ? Math.max(0, Math.round((Date.now() - lastBackupAtMs) / 60000)) : null;
  const standbyReady = !!latestCatalog && !!latestValidatedBackup && (standbyLagMinutes === null || standbyLagMinutes <= intervalMinutes * 2);
  let status = 'disabled';
  if (runningJob) status = 'running';
  else if (settings.enabled && !settings.standbyHost) status = 'warning';
  else if (settings.enabled && lastEvent?.type === 'HA_SYNC_FINISHED') status = 'success';
  else if (settings.enabled && lastEvent?.type === 'HA_SYNC_DEFERRED') status = 'deferred';
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
      latestBackup,
      latestValidatedBackup
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
    enabled: body.enabled !== undefined ? body.enabled !== false : current.enabled !== false,
    autoEnabled: body.autoEnabled !== undefined ? body.autoEnabled !== false : current.autoEnabled !== false,
    syncMode: ['physical', 'backup_restore'].includes(String(body.syncMode || current.syncMode || DEFAULT_HA_SYNC_MODE).toLowerCase())
      ? String(body.syncMode || current.syncMode || DEFAULT_HA_SYNC_MODE).toLowerCase()
      : DEFAULT_HA_SYNC_MODE,
    intervalMinutes: FIXED_HA_SYNC_INTERVAL_MINUTES,
    standbyHost: String(body.standbyHost || current.standbyHost || '').trim(),
    sshUser: String(body.sshUser || current.sshUser || 'tronsoft').trim(),
    sshPort: Number(body.sshPort || current.sshPort || 22),
    remoteBackupDir: String(body.remoteBackupDir || current.remoteBackupDir || '/opt/tronfire-storage/firebird/backups').trim(),
    remoteRestoreDir: String(body.remoteRestoreDir || current.remoteRestoreDir || '/opt/tronfire-storage/firebird/restore-work').trim(),
    remoteCatalogDir: String(body.remoteCatalogDir || current.remoteCatalogDir || '/tmp/tronfire-catalog').trim(),
    backupDir: String(body.backupDir || current.backupDir || '/opt/tronfire-storage/firebird/backups').trim(),
    catalogDir: String(body.catalogDir || current.catalogDir || path.join(stateDir, 'tronfire-catalog')).trim(),
    sshValidatedAt: current.sshValidatedHost === String(body.standbyHost || current.standbyHost || '').trim()
      && current.sshValidatedUser === String(body.sshUser || current.sshUser || 'tronsoft').trim()
      ? current.sshValidatedAt || null
      : null,
    sshValidatedHost: current.sshValidatedHost || '',
    sshValidatedUser: current.sshValidatedUser || ''
  };
  if (next.enabled && !next.standbyHost) throw new Error('host standby nao informado');
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(next.sshUser)) throw new Error('usuario SSH invalido');
  if (!Number.isInteger(next.sshPort) || next.sshPort < 1 || next.sshPort > 65535) throw new Error('porta SSH invalida');
  for (const key of ['remoteBackupDir', 'remoteRestoreDir', 'remoteCatalogDir', 'backupDir', 'catalogDir']) {
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
  appendEvent('HA_SYNC_SETTINGS_UPDATED', { enabled: settings.enabled, standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort, syncMode: settings.syncMode });
  return publicHaSyncSettings(settings);
}

async function testHaSyncSsh(body = {}) {
  const guard = clusterGuard();
  if (nodeIdentity().deploymentMode === 'ha' && guard.canServeProduction !== true) {
    throw new Error('Teste SSH do Sync HA deve ser executado no no primary/ativo');
  }
  const settings = normalizeHaSyncSettings(body);
  const identityFile = path.join(stateDir, 'ssh/id_ed25519');
  const knownHosts = path.join(stateDir, 'known_hosts');
  if (!fs.existsSync(identityFile)) throw new Error(`chave SSH nao encontrada: ${identityFile}`);
  const target = `${settings.sshUser}@${settings.standbyHost}`;
  try {
    const out = await run('ssh', [
      '-p', String(settings.sshPort),
      '-i', identityFile,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      target,
      'printf "TRONSOFTOS_SSH_OK\\n"; hostname'
    ], { timeout: 15_000, maxBuffer: 256 * 1024 });
    if (!out.stdout.includes('TRONSOFTOS_SSH_OK')) throw new Error('resposta SSH de validacao ausente');
    const validated = {
      ...settings,
      sshValidatedAt: new Date().toISOString(),
      sshValidatedHost: settings.standbyHost,
      sshValidatedUser: settings.sshUser
    };
    ensureStateDir();
    fs.writeFileSync(haSyncSettingsPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    appendEvent('HA_SYNC_SSH_VALIDATED', { standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort });
    return {
      ok: true,
      target,
      hostname: out.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || settings.standbyHost,
      validatedAt: validated.sshValidatedAt
    };
  } catch (err) {
    appendEvent('HA_SYNC_SSH_VALIDATION_FAILED', { standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort, error: err.message });
    throw new Error(`Pareamento SSH invalido para ${target}. Importe novamente o arquivo de pareamento no standby e repita o teste. Detalhe: ${err.stderr || err.message}`);
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
  const safeSubject = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
  await smtpCommand(socket, `MAIL FROM:<${settings.from.replace(/^.*<|>.*$/g, '')}>`);
  for (const recipient of recipients) await smtpCommand(socket, `RCPT TO:<${recipient.replace(/^.*<|>.*$/g, '')}>`);
  await smtpCommand(socket, 'DATA', /^354/);
  const message = [
    `From: ${settings.from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${settings.subjectPrefix || '[TronSoftOS]'} ${safeSubject}`,
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

function smtpAlertKey(installationLabel, alert) {
  const stableAlert = String(alert.type || alert.message || 'alerta')
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${installationLabel}:${alert.source || 'TronSoftOS'}:${stableAlert}`;
}

function persistSmtpAlertStates() {
  ensureStateDir();
  fs.writeFileSync(smtpAlertStatePath, `${JSON.stringify(Object.fromEntries(smtpAlertStates), null, 2)}\n`, { mode: 0o600 });
}

function smtpAlertBody(identity, company, alert, statusLabel) {
  return [
    `Status: ${statusLabel}`,
    `Empresa Sintegra: ${company.companyName || 'Nao identificada'}`,
    `Banco: ${company.databaseName || 'Nao identificado'}${company.databaseAlias ? ` (${company.databaseAlias})` : ''}`,
    `Cluster: ${identity.clusterId || 'Nao informado'}`,
    `No: ${identity.nodeName || 'Nao informado'}`,
    `Papel: ${identity.nodeRole || 'Nao informado'}`,
    `Origem: ${alert.source || 'TronSoftOS'}`,
    `Severidade: ${alert.severity || 'critical'}`,
    `Mensagem: ${alert.message || 'Alerta critico'}`,
    `Quando: ${new Date().toISOString()}`
  ].join('\n');
}

async function notifyCriticalAlerts(alerts) {
  const settings = readJson(smtpSettingsPath, {});
  if (settings.enabled !== true || smtpNotificationInFlight) return;
  smtpNotificationInFlight = true;
  try {
    const now = Date.now();
    const reminderIntervalMs = 60 * 60 * 1000;
    const recoveryGraceMs = 2 * 60 * 1000;
    const critical = alerts.filter(alert => ['critical', 'critico', 'danger'].includes(String(alert.severity || '').toLowerCase()));
    const identity = nodeIdentity();
    const company = await tronfireCompanyIdentity();
    const installationLabel = company.companyName || identity.clusterId || identity.nodeName || 'TronSoftOS';
    const installationKey = identity.clusterId || identity.nodeName || 'TronSoftOS';
    const activeKeys = new Set();

    for (const alert of critical) {
      const key = smtpAlertKey(installationKey, alert);
      activeKeys.add(key);
      const current = smtpAlertStates.get(key) || {};
      const retryIntervalMs = 5 * 60 * 1000;
      const reminderDue = !current.lastSentAt || now - Number(current.lastSentAt) >= reminderIntervalMs;
      const retryAllowed = !current.lastAttemptAt || now - Number(current.lastAttemptAt) >= retryIntervalMs;
      const shouldSend = reminderDue && retryAllowed;
      const notificationKind = current.lastSentAt ? 'LEMBRETE' : 'NOVO ALERTA';
      const nextState = {
        ...current,
        alert,
        identity,
        company,
        installationLabel,
        absentSince: null,
        lastObservedAt: now
      };
      if (!shouldSend) {
        smtpAlertStates.set(key, nextState);
        continue;
      }
      try {
        await sendSmtpMessage(settings, `[${installationLabel}] ${notificationKind}: ${alert.message || 'Alerta critico'}`, smtpAlertBody(identity, company, alert, notificationKind));
        smtpAlertStates.set(key, { ...nextState, lastSentAt: now, lastAttemptAt: now });
        appendEvent('SMTP_ALERT_SENT', { key, kind: notificationKind, message: alert.message });
      } catch (err) {
        smtpAlertStates.set(key, { ...nextState, lastAttemptAt: now });
        appendEvent('SMTP_ALERT_FAILED', { key, kind: notificationKind, error: err.message });
      }
    }

    for (const [key, state] of smtpAlertStates.entries()) {
      if (activeKeys.has(key) || !state.lastSentAt) continue;
      if (!state.absentSince) {
        smtpAlertStates.set(key, { ...state, absentSince: now });
        continue;
      }
      if (now - Number(state.absentSince) < recoveryGraceMs) continue;
      if (state.recoveryLastAttemptAt && now - Number(state.recoveryLastAttemptAt) < 5 * 60 * 1000) continue;
      const recoveredAlert = state.alert || { message: 'Alerta normalizado', severity: 'critical', source: 'TronSoftOS' };
      try {
        await sendSmtpMessage(
          settings,
          `[${state.installationLabel || installationLabel}] RECUPERADO: ${recoveredAlert.message || 'Alerta normalizado'}`,
          smtpAlertBody(state.identity || identity, state.company || company, recoveredAlert, 'RECUPERADO')
        );
        smtpAlertStates.delete(key);
        appendEvent('SMTP_ALERT_RECOVERED', { key, message: recoveredAlert.message });
      } catch (err) {
        smtpAlertStates.set(key, { ...state, recoveryLastAttemptAt: now });
        appendEvent('SMTP_ALERT_FAILED', { key, kind: 'RECUPERADO', error: err.message });
      }
    }
    persistSmtpAlertStates();
  } finally {
    smtpNotificationInFlight = false;
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
    bind: process.env.RCLONE_BIND || '0.0.0.0',
    remoteRetentionDays: Number(process.env.RCLONE_REMOTE_RETENTION_DAYS || 30),
    accountEmail: '',
    ...readJson(rcloneSettingsPath, {})
  };
}

function publicRcloneSettings(settings = rawRcloneSettings()) {
  const tokenStatus = rcloneTokenStatus(settings.config || defaultRcloneConfigPath(), settings.remote || '');
  return {
    enabled: settings.enabled === true,
    bin: settings.bin || '/usr/bin/rclone',
    config: settings.config || defaultRcloneConfigPath(),
    configConfigured: fs.existsSync(settings.config || defaultRcloneConfigPath()),
    remote: settings.remote || '',
    path: settings.path || 'tronsoftos/backups',
    uploadOnlyRole: settings.uploadOnlyRole || 'primary',
    bind: settings.bind || process.env.RCLONE_BIND || '0.0.0.0',
    remoteRetentionDays: Number(settings.remoteRetentionDays || 30),
    accountEmail: settings.accountEmail || '',
    tokenStatus
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
    uploadOnlyRole: String(body.uploadOnlyRole || 'primary').trim(),
    bind: String(body.bind || current.bind || process.env.RCLONE_BIND || '0.0.0.0').trim(),
    remoteRetentionDays: Number(body.remoteRetentionDays || current.remoteRetentionDays || 30),
    accountEmail: String(body.accountEmail || current.accountEmail || '').trim()
  };
  if (!next.bin.startsWith('/')) throw new Error('caminho do rclone deve ser absoluto');
  if (!next.config.startsWith('/')) throw new Error('caminho do rclone.conf deve ser absoluto');
  if (next.enabled && !next.remote) throw new Error('remote rclone nao informado');
  if (!['primary', 'standby', 'recovery', 'any'].includes(next.uploadOnlyRole)) throw new Error('role de upload invalida');
  next.remoteRetentionDays = Math.max(1, Math.min(365, Math.round(Number.isFinite(next.remoteRetentionDays) ? next.remoteRetentionDays : 30)));
  return next;
}

function canRepairRcloneConfigPath(configPath) {
  const resolvedConfig = path.resolve(configPath || defaultRcloneConfigPath());
  const resolvedRcloneDir = path.resolve(appRoot, 'config/rclone');
  return resolvedConfig === path.join(resolvedRcloneDir, 'rclone.conf')
    || resolvedConfig.startsWith(`${resolvedRcloneDir}${path.sep}`);
}

function repairRcloneConfigPermissions(configPath) {
  if (!canRepairRcloneConfigPath(configPath)) return false;
  try {
    execFileSync('sudo', ['-n', '/usr/local/sbin/tronsoftos-network', 'fix-rclone-permissions', appRoot], {
      timeout: 15_000,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function ensureRcloneConfigReadable(configPath = defaultRcloneConfigPath()) {
  const target = configPath || defaultRcloneConfigPath();
  if (!fs.existsSync(target)) return false;
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch (err) {
    if (!['EACCES', 'EPERM'].includes(err.code) || !repairRcloneConfigPermissions(target)) throw err;
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  }
}

function writeRcloneConfigContent(settings, configContent) {
  const configDir = path.dirname(settings.config);
  const write = () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings.config, configContent.trimEnd() + '\n', { mode: 0o600 });
    fs.chmodSync(configDir, 0o700);
    fs.chmodSync(settings.config, 0o600);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const owner = serviceUserIds();
      fs.chownSync(configDir, owner.uid, owner.gid);
      fs.chownSync(settings.config, owner.uid, owner.gid);
    }
  };

  try {
    write();
  } catch (err) {
    if (!['EACCES', 'EPERM'].includes(err.code) || !repairRcloneConfigPermissions(settings.config)) throw err;
    write();
  }
}

function writeRcloneSettings(body) {
  ensureStateDir();
  const settings = normalizeRcloneSettings(body);
  if (typeof body.configContent === 'string' && body.configContent.trim()) {
    try {
      writeRcloneConfigContent(settings, body.configContent);
    } catch (err) {
      const error = new Error(`Nao foi possivel salvar o rclone.conf em ${settings.config}: ${err.message}. Verifique se a pasta pertence ao usuario tronsoftos.`);
      error.statusCode = 500;
      throw error;
    }
  }
  fs.writeFileSync(rcloneSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  rcloneQuotaCache = { key: null, checkedAt: 0, value: null };
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

function parseRcloneRemoteConfig(configPath, remote) {
  if (!configPath || !remote || !fs.existsSync(configPath)) return {};
  try {
    const section = String(remote).replace(/:+$/g, '');
    const result = {};
    let active = false;
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        active = header[1] === section;
        continue;
      }
      if (!active) continue;
      const match = line.match(/^\s*([^=]+?)\s*=\s*(.*)\s*$/);
      if (match) result[match[1].trim()] = match[2].trim();
    }
    return result;
  } catch {
    return {};
  }
}

function rcloneTokenStatus(configPath, remote) {
  const section = parseRcloneRemoteConfig(configPath, remote);
  if (!section.token) {
    return {
      configured: false,
      validJson: false,
      hasRefreshToken: false,
      expiry: null,
      expired: false,
      clientIdConfigured: !!section.client_id,
      clientSecretConfigured: !!section.client_secret
    };
  }
  let token = null;
  try {
    token = JSON.parse(section.token);
  } catch {
    return {
      configured: true,
      validJson: false,
      hasRefreshToken: false,
      expiry: null,
      expired: true,
      clientIdConfigured: !!section.client_id,
      clientSecretConfigured: !!section.client_secret
    };
  }
  const expiry = token?.expiry || null;
  const expiresAt = expiry ? new Date(expiry).getTime() : NaN;
  return {
    configured: true,
    validJson: true,
    hasRefreshToken: !!token?.refresh_token,
    expiry,
    expired: Number.isFinite(expiresAt) ? expiresAt <= Date.now() : false,
    clientIdConfigured: !!section.client_id,
    clientSecretConfigured: !!section.client_secret
  };
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
  const credentials = rawGoogleCredentials();
  const remote = normalizeRemoteName(body.remote || settings.remote || 'gdrive');
  const rawToken = String(body.token || '').trim();
  if (!rawToken) throw new Error('token OAuth nao informado');
  let token;
  try {
    token = JSON.parse(rawToken);
  } catch {
    throw new Error('token OAuth deve estar em JSON');
  }
  if (!token.refresh_token) throw new Error('token OAuth invalido: refresh_token ausente. Gere o token com rclone authorize e permita acesso offline.');
  const configContent = googleDriveRcloneConfig({
    remote,
    clientId: String(body.clientId || credentials.clientId || '').trim(),
    clientSecret: String(body.clientSecret || credentials.clientSecret || '').trim(),
    token
  });
  const result = writeRcloneSettings({
    enabled: true,
    bin: body.bin || settings.bin || '/usr/bin/rclone',
    config: body.config || settings.config || defaultRcloneConfigPath(),
    remote,
    path: body.path || settings.path || 'tronsoftos/backups',
    uploadOnlyRole: body.uploadOnlyRole || settings.uploadOnlyRole || 'primary',
    bind: body.bind || settings.bind || '0.0.0.0',
    remoteRetentionDays: body.remoteRetentionDays || settings.remoteRetentionDays || 30,
    accountEmail: body.accountEmail || settings.accountEmail || '',
    configContent
  });
  appendEvent('GOOGLE_DRIVE_TOKEN_IMPORTED', { remote, path: result.path });
  return result;
}

async function resetGoogleDriveAuth() {
  const current = rawRcloneSettings();
  try {
    const token = centralToken();
    if (token) {
      await centralRequest('/api/tronsoftos/oauth/google/reset', {
        method: 'POST',
        token
      });
    }
  } catch (err) {
    appendEvent('CENTRAL_GOOGLE_OAUTH_RESET_FAILED', { error: err.message });
  }
  const config = current.config || defaultRcloneConfigPath();
  if (canRepairRcloneConfigPath(config)) {
    try {
      fs.rmSync(config, { force: true });
    } catch (err) {
      if (!['EACCES', 'EPERM'].includes(err.code) || !repairRcloneConfigPermissions(config)) throw err;
      fs.rmSync(config, { force: true });
    }
  }
  const settings = {
    ...current,
    enabled: false,
    accountEmail: ''
  };
  fs.writeFileSync(rcloneSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  rcloneQuotaCache = { key: null, checkedAt: 0, value: null };
  appendEvent('GOOGLE_DRIVE_AUTH_RESET', { remote: settings.remote || 'gdrive', path: settings.path || 'tronsoftos/backups' });
  return {
    ...publicRcloneSettings(settings),
    message: 'Autenticacao local do Google Drive resetada. Clique em Autenticar Google para gerar uma nova autorizacao.'
  };
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

function rcloneConfiguredPath(settings) {
  return String(settings.path || '').replace(/^\/+|\/+$/g, '');
}

function rcloneRemoteRoot(settings) {
  return `${String(settings.remote || '').replace(/:+$/g, '')}:`;
}

function rcloneArgs(args = []) {
  const bind = String(rawRcloneSettings().bind || process.env.RCLONE_BIND || '0.0.0.0').trim();
  return bind ? ['--bind', bind, ...args] : args;
}

function rcloneBackupFilters() {
  return [
    '--filter', '+ *.gbk',
    '--filter', '+ *.fbk',
    '--filter', '+ *.gbk.gz',
    '--filter', '+ *.fbk.gz',
    '--filter', '+ *.manifest.json',
    '--filter', '- *'
  ];
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

function googleDriveErrorDetails(error) {
  const raw = String(error?.message || error || 'Falha ao acessar Google Drive');
  const activationUrl = raw.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/drive\.googleapis\.com\/overview\?project=\d+/)?.[0] || '';
  if (/SERVICE_DISABLED|accessNotConfigured|Google Drive API has not been used|drive\.googleapis\.com/i.test(raw)) {
    return {
      code: 'google_drive_api_disabled',
      activationUrl,
      message: activationUrl
        ? `Google Drive API desativada no projeto Google. Habilite em ${activationUrl} e aguarde alguns minutos antes de testar novamente.`
        : 'Google Drive API desativada no projeto Google das credenciais OAuth da Central. Habilite a API e aguarde alguns minutos antes de testar novamente.'
    };
  }
  if (/invalid_grant|refresh token|Token has been expired|revoked/i.test(raw)) {
    return {
      code: 'google_drive_auth_expired',
      activationUrl: '',
      message: 'Autorizacao do Google Drive expirou ou foi revogada. Reautorize o Google Drive. Se o client OAuth estiver em Producao, confira revogacao manual, limite de refresh tokens do Google ou troca de grant pela mesma conta.'
    };
  }
  if (/network is unreachable|dial tcp \[[0-9a-f:]+\]:443/i.test(raw)) {
    return {
      code: 'google_drive_ipv6_unreachable',
      activationUrl: '',
      message: 'Servidor tentou acessar o Google Drive por IPv6, mas a rede nao possui rota IPv6. O TronSoftOS deve executar o rclone com IPv4 (--bind 0.0.0.0) ou o IPv6 deve ser desativado/corrigido no Debian.'
    };
  }
  return { code: 'google_drive_error', activationUrl: '', message: raw };
}

async function rcloneRemoteBackups() {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote) throw new Error('Google Drive nao configurado para backups');
  if (!ensureRcloneConfigReadable(config)) throw new Error('Configuracao do Google Drive nao aplicada');
  const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs([
    'lsjson',
    rcloneTarget(settings),
    '--files-only',
    '--recursive',
    ...rcloneBackupFilters(),
    '--config', config
  ]), {
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

async function rcloneRemoteFiles(settings, config) {
  const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs([
    'lsjson',
    rcloneTarget(settings),
    '--files-only',
    '--recursive',
    '--config', config
  ]), {
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 20
  });
  const rows = JSON.parse(out.stdout || '[]');
  return Array.isArray(rows) ? rows
    .filter(item => !item.IsDir && (item.Path || item.Name))
    .map(item => ({
      name: item.Name || path.basename(item.Path || ''),
      path: item.Path || item.Name || '',
      size: Number(item.Size || 0),
      modifiedAt: item.ModTime || null,
      mimeType: item.MimeType || null
    })) : [];
}

async function rcloneCleanupRemoteBackups() {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote) throw new Error('Google Drive nao configurado para backups');
  if (!fs.existsSync(settings.bin || '/usr/bin/rclone')) throw new Error(`binario rclone nao encontrado: ${settings.bin || '/usr/bin/rclone'}`);
  if (!ensureRcloneConfigReadable(config)) throw new Error('Configuracao do Google Drive nao aplicada');
  const remotePath = rcloneConfiguredPath(settings);
  if (!remotePath) throw new Error('Caminho do Google Drive vazio. Configure uma pasta de backups antes de limpar.');
  const target = rcloneTarget(settings);
  const candidates = await rcloneRemoteFiles(settings, config);
  if (!candidates.length) {
    appendEvent('RCLONE_REMOTE_CLEANUP_EMPTY', { target });
    return { ok: true, target, candidates: 0, removed: 0, freedBytes: 0 };
  }
  const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs([
    'delete',
    target,
    '--drive-use-trash=false',
    '--config', config
  ]), {
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 5
  });
  rcloneQuotaCache = { key: null, checkedAt: 0, value: null };
  const after = await rcloneRemoteFiles(settings, config).catch(() => []);
  const remaining = new Set(after.map(file => file.path));
  const removedFiles = candidates.filter(file => !remaining.has(file.path));
  const freedBytes = removedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const quota = await rcloneAbout({ force: true }).catch(() => null);
  appendEvent('RCLONE_REMOTE_CLEANUP_OK', {
    target,
    candidates: candidates.length,
    removed: removedFiles.length,
    freedBytes,
    quota
  });
  return {
    ok: true,
    target,
    candidates: candidates.length,
    removed: removedFiles.length,
    freedBytes,
    quota,
    stdout: out.stdout,
    stderr: out.stderr
  };
}

function startRcloneRemoteBackupDownload(body = {}) {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote) throw new Error('Google Drive nao configurado para backups');
  if (!ensureRcloneConfigReadable(config)) throw new Error('Configuracao do Google Drive nao aplicada');
  const remotePath = normalizeRemoteBackupPath(body.path);
  const backupDir = process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups';
  const localName = path.basename(remotePath).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const localPath = path.join(backupDir, localName);
  fs.mkdirSync(backupDir, { recursive: true });
  return startCommandJob({
    app: 'rclone',
    action: 'download',
    command: settings.bin || '/usr/bin/rclone',
    args: rcloneArgs([
      'copyto',
      rcloneRemoteObject(settings, remotePath),
      localPath,
      '--config',
      config
    ]),
    eventPrefix: 'RCLONE'
  });
}

async function rcloneTest() {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote) throw new Error('Google Drive nao configurado para backups');
  if (!fs.existsSync(settings.bin || '/usr/bin/rclone')) throw new Error(`binario rclone nao encontrado: ${settings.bin || '/usr/bin/rclone'}`);
  if (!ensureRcloneConfigReadable(config)) throw new Error(`Configuracao do Google Drive nao aplicada: ${config}`);
  const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs(['lsd', rcloneRemoteRoot(settings), '--config', config]), {
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 2
  });
  appendEvent('RCLONE_TEST_OK', { remote: settings.remote, path: settings.path });
  return {
    ok: true,
    stdout: out.stdout,
    stderr: out.stderr,
    remote: rcloneRemoteRoot(settings),
    target: rcloneTarget(settings)
  };
}

async function rcloneUploadTest() {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote) throw new Error('Google Drive nao configurado para backups');
  if (!fs.existsSync(settings.bin || '/usr/bin/rclone')) throw new Error(`binario rclone nao encontrado: ${settings.bin || '/usr/bin/rclone'}`);
  if (!ensureRcloneConfigReadable(config)) throw new Error(`Configuracao do Google Drive nao aplicada: ${config}`);
  ensureStateDir();
  const testPath = path.join(stateDir, `rclone-upload-test-${Date.now()}.txt`);
  fs.writeFileSync(testPath, `TronSoftOS rclone test ${new Date().toISOString()}\n`);
  try {
    const target = `${rcloneTarget(settings).replace(/\/+$/g, '')}/tronsoftos-upload-test.txt`;
    const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs(['copyto', testPath, target, '--config', config]), {
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 2
    });
    appendEvent('RCLONE_UPLOAD_TEST_OK', { target });
    return { ok: true, stdout: out.stdout, stderr: out.stderr, target };
  } finally {
    fs.rmSync(testPath, { force: true });
  }
}

async function rcloneAbout({ force = false } = {}) {
  const settings = rawRcloneSettings();
  const config = settings.config || defaultRcloneConfigPath();
  if (!settings.remote || !fs.existsSync(config)) return null;
  const cacheKey = `${settings.bin || '/usr/bin/rclone'}|${settings.bind || process.env.RCLONE_BIND || '0.0.0.0'}|${config}|${rcloneTarget(settings)}`;
  if (!force && rcloneQuotaCache.key === cacheKey && Date.now() - rcloneQuotaCache.checkedAt < 5 * 60 * 1000) {
    return rcloneQuotaCache.value;
  }
  try {
    ensureRcloneConfigReadable(config);
    const out = await run(settings.bin || '/usr/bin/rclone', rcloneArgs(['about', rcloneTarget(settings), '--json', '--config', config]), {
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
      checkedAt: new Date().toISOString(),
      total,
      used,
      free,
      percentUsed,
      raw: quota
    };
    rcloneQuotaCache = { key: cacheKey, checkedAt: Date.now(), value };
    return value;
  } catch (err) {
    const details = googleDriveErrorDetails(err);
    const value = { ok: false, target: rcloneTarget(settings), checkedAt: new Date().toISOString(), error: details.message, code: details.code, activationUrl: details.activationUrl };
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

function serviceUserIds() {
  const fallback = (() => {
    try {
      const stat = fs.statSync(appRoot);
      return { uid: stat.uid, gid: stat.gid };
    } catch {
      return { uid: 0, gid: 0 };
    }
  })();
  try {
    const userLine = fs.readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find(line => line.startsWith('tronsoftos:'));
    const groupLine = fs.readFileSync('/etc/group', 'utf8')
      .split('\n')
      .find(line => line.startsWith('tronsoftos:'));
    const uid = Number(userLine?.split(':')[2]);
    const gid = Number(groupLine?.split(':')[2] ?? userLine?.split(':')[3]);
    if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
  } catch {
    // Keep fallback when passwd/group is unavailable.
  }
  return fallback;
}

const hiddenDriveFsTypes = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'rpc_pipefs',
  'securityfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs'
]);

function defaultDriveSettings() {
  return {
    enabled: false,
    shareName: 'tronsystem-drive',
    mountPath: '',
    directoryName: 'drive',
    path: '',
    quotaGb: 0,
    sambaEnabled: true,
    sambaAuthMode: 'protected',
    sambaUsername: 'tronsystem',
    updatedAt: null
  };
}

function normalizeMountPath(value) {
  const mountPath = path.resolve(String(value || '/').trim() || '/');
  return mountPath === path.parse(mountPath).root ? mountPath : mountPath.replace(/\/+$/, '');
}

function publicDriveSettings(settings = readJson(driveSettingsPath, {})) {
  const merged = { ...defaultDriveSettings(), ...settings };
  const mountPath = merged.mountPath ? normalizeMountPath(merged.mountPath) : '';
  const directoryName = String(merged.directoryName || 'drive').trim() || 'drive';
  const shareName = String(merged.shareName || 'tronsystem-drive') === 'tronsoftos-drive'
    ? 'tronsystem-drive'
    : String(merged.shareName || 'tronsystem-drive');
  return {
    enabled: !!merged.enabled,
    shareName,
    mountPath,
    directoryName,
    path: mountPath ? path.join(mountPath, directoryName) : String(merged.path || ''),
    quotaGb: Number(merged.quotaGb || 0),
    sambaEnabled: !!merged.sambaEnabled,
    sambaAuthMode: merged.sambaAuthMode === 'public' ? 'public' : 'protected',
    sambaUsername: String(merged.sambaUsername || 'tronsystem'),
    updatedAt: merged.updatedAt || null
  };
}

function parseFindmntNumber(value) {
  const number = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function publicMount(item) {
  const target = normalizeMountPath(item.target || item.TARGET || '/');
  const fstype = String(item.fstype || item.FSTYPE || '').toLowerCase();
  const total = parseFindmntNumber(item.total ?? item.SIZE);
  const used = parseFindmntNumber(item.used ?? item.USED);
  const free = parseFindmntNumber(item.free ?? item.AVAIL);
  const percentRaw = item.percentUsed ?? item['USE%'];
  const percentUsed = Number(String(percentRaw || '').replace('%', ''));
  const reservedTarget = target === '/' || target.startsWith('/opt/tronfire-storage') || target.startsWith('/opt/tronsoftos');
  return {
    target,
    source: String(item.source || item.SOURCE || ''),
    fstype,
    total,
    used,
    free,
    percentUsed: Number.isFinite(percentUsed) ? percentUsed : (total > 0 ? Math.round((used / total) * 100) : null),
    options: String(item.options || item.OPTIONS || ''),
    recommended: !reservedTarget && free > 20 * 1024 * 1024 * 1024,
    warning: reservedTarget ? 'Disco usado pelo sistema, banco ou backups. Prefira um HD dedicado para arquivos dos clientes.' : null
  };
}

function visibleDriveMount(mount) {
  if (!mount.target || hiddenDriveFsTypes.has(mount.fstype)) return false;
  if (mount.total <= 0) return false;
  if (mount.target !== '/' && /^\/(boot|dev|proc|run|sys|var\/lib\/docker)(\/|$)/.test(mount.target)) return false;
  return true;
}

function flattenFindmnt(filesystems = []) {
  const mounts = [];
  for (const item of filesystems) {
    mounts.push(item);
    if (Array.isArray(item.children)) mounts.push(...flattenFindmnt(item.children));
  }
  return mounts;
}

function sortDriveMounts(mounts) {
  const byTarget = new Map();
  for (const mount of mounts) {
    if (!byTarget.has(mount.target)) byTarget.set(mount.target, mount);
  }
  return [...byTarget.values()].sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (left.target === '/') return 1;
    if (right.target === '/') return -1;
    return right.free - left.free;
  });
}

async function dfDriveMounts(args = []) {
  const out = await run('df', ['-PB1', ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return out.stdout.trim().split(/\r?\n/).slice(1).map(line => {
    const columns = line.trim().split(/\s+/);
    return publicMount({
      source: columns[0],
      total: columns[1],
      used: columns[2],
      free: columns[3],
      percentUsed: columns[4],
      target: columns.slice(5).join(' ')
    });
  }).filter(visibleDriveMount);
}

async function driveMounts() {
  if (process.platform === 'win32') return [];
  try {
    const out = await run('findmnt', ['-J', '-b', '-o', 'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const payload = JSON.parse(out.stdout || '{}');
    const mounts = flattenFindmnt(payload.filesystems || [])
      .map(publicMount)
      .filter(visibleDriveMount);
    if (mounts.length > 0) return sortDriveMounts(mounts);
  } catch {
    // Fall through to df fallback below.
  }
  const mounts = await dfDriveMounts(['-x', 'tmpfs', '-x', 'devtmpfs']).catch(() => []);
  if (mounts.length > 0) return sortDriveMounts(mounts);
  return sortDriveMounts(await dfDriveMounts(['/']));
}

function parseSambaSections(text) {
  const sections = [];
  let current = null;
  let managed = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '# BEGIN TRONSYSTEM DRIVE SHARE') managed = true;
    if (line === '# END TRONSYSTEM DRIVE SHARE') managed = false;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = { name: header[1], options: {}, managed };
      sections.push(current);
      continue;
    }
    if (!current || !line || line.startsWith('#') || line.startsWith(';')) continue;
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair) current.options[pair[1].trim().toLowerCase()] = pair[2].trim();
  }
  return sections;
}

async function sambaShares(settings) {
  if (process.platform === 'win32') return [];
  let content = '';
  try {
    const out = await run('testparm', ['-s', '/etc/samba/smb.conf'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    content = out.stdout || '';
  } catch {
    try {
      content = fs.readFileSync('/etc/samba/smb.conf', 'utf8');
    } catch {
      return [];
    }
  }
  return parseSambaSections(content)
    .filter(section => section.name !== 'global')
    .map(section => {
      const pathValue = section.options.path || '';
      const guestOk = /^(yes|true|1)$/i.test(section.options['guest ok'] || section.options.public || '');
      const available = !/^(no|false|0)$/i.test(section.options.available || 'yes');
      const name = section.name;
      const managed = section.managed || name === settings.shareName || (settings.path && pathValue === settings.path);
      return {
        name,
        path: pathValue,
        available,
        browseable: !/^(no|false|0)$/i.test(section.options.browseable || 'yes'),
        readOnly: /^(yes|true|1)$/i.test(section.options['read only'] || 'no'),
        guestOk,
        authMode: guestOk ? 'public' : 'protected',
        validUsers: section.options['valid users'] || '',
        managed,
        kind: name === 'homes' ? 'homes' : name === 'printers' || name === 'print$' ? 'system' : managed ? 'tronsystem' : 'external'
      };
    })
    .filter(share => share.managed && share.kind === 'tronsystem');
}

async function driveStatus() {
  const settings = publicDriveSettings();
  const mounts = await driveMounts();
  const selectedMount = settings.mountPath
    ? mounts.find(item => normalizeMountPath(item.target) === normalizeMountPath(settings.mountPath)) || null
    : null;
  const usage = settings.path ? await diskUsageForPath(settings.path) : null;
  return { settings, mounts, selectedMount, usage, sambaShares: await sambaShares(settings) };
}

function safeDriveName(value, fallback) {
  const normalized = String(value || fallback).trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(normalized)) {
    throw Object.assign(new Error('Use apenas letras, numeros, hifen ou underline no nome.'), { statusCode: 400 });
  }
  return normalized;
}

function safeSambaUsername(value) {
  const normalized = String(value || 'tronsystem').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_-]{2,31}$/.test(normalized)) {
    throw Object.assign(new Error('Usuario Samba deve comecar com letra e usar apenas letras, numeros, hifen ou underline.'), { statusCode: 400 });
  }
  return normalized;
}

function optionalSambaUsername(value, fallback = 'tronsystem') {
  try {
    return safeSambaUsername(value || fallback);
  } catch {
    return fallback;
  }
}

function safeSambaPassword(value, required) {
  const password = String(value || '');
  if (!password && required) {
    throw Object.assign(new Error('Informe a senha do usuario Samba para o modo protegido.'), { statusCode: 400 });
  }
  if (password && (password.length < 8 || password.length > 128)) {
    throw Object.assign(new Error('Senha Samba deve ter entre 8 e 128 caracteres.'), { statusCode: 400 });
  }
  return password;
}

function writeSambaPasswordFile(password) {
  ensureStateDir();
  const tmpDir = fs.mkdtempSync(path.join(stateDir, 'drive-samba-'));
  fs.chmodSync(tmpDir, 0o700);
  const passwordPath = path.join(tmpDir, 'password.secret');
  fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
  return { tmpDir, passwordPath };
}

async function writeDriveSettings(body) {
  const mounts = await driveMounts();
  if (!String(body.mountPath || '').trim()) {
    throw Object.assign(new Error('Selecione um disco para ativar o Drive.'), { statusCode: 400 });
  }
  const mountPath = normalizeMountPath(body.mountPath || '');
  const selectedMount = mounts.find(item => normalizeMountPath(item.target) === mountPath);
  if (!selectedMount) throw Object.assign(new Error('Disco selecionado nao esta disponivel no servidor.'), { statusCode: 400 });

  const directoryName = safeDriveName(body.directoryName, 'drive');
  const shareName = safeDriveName(body.shareName, 'tronsystem-drive');
  const previousSettings = publicDriveSettings();
  const sambaEnabled = body.sambaEnabled === true;
  const sambaAuthMode = body.sambaAuthMode === 'public' ? 'public' : 'protected';
  const sambaUsername = sambaEnabled
    ? safeSambaUsername(body.sambaUsername)
    : optionalSambaUsername(body.sambaUsername, previousSettings.sambaUsername || 'tronsystem');
  const canKeepSambaPassword = body.keepSambaPassword === true
    && !!previousSettings.updatedAt
    && previousSettings.sambaAuthMode === 'protected'
    && previousSettings.sambaUsername === sambaUsername;
  const sambaPassword = sambaEnabled && sambaAuthMode === 'protected'
    ? safeSambaPassword(body.sambaPassword, !canKeepSambaPassword)
    : '';
  const drivePath = path.resolve(path.join(mountPath, directoryName));
  const relative = path.relative(mountPath, drivePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Diretorio do Drive precisa ficar dentro do disco selecionado.'), { statusCode: 400 });
  }

  fs.mkdirSync(drivePath, { recursive: true, mode: 0o770 });
  try {
    fs.chmodSync(drivePath, 0o770);
  } catch {
    // Some filesystems do not support chmod; the directory still remains usable.
  }

  const settings = {
    enabled: body.enabled !== false,
    shareName,
    mountPath,
    directoryName,
    path: drivePath,
    quotaGb: Math.max(0, Number(body.quotaGb || 0)),
    sambaEnabled,
    sambaAuthMode,
    sambaUsername,
    updatedAt: new Date().toISOString()
  };
  let samba = null;
  if (settings.sambaEnabled) {
    let secret = null;
    try {
      if (sambaAuthMode === 'protected' && sambaPassword) secret = writeSambaPasswordFile(sambaPassword);
      const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', [
        'drive-samba',
        drivePath,
        shareName,
        sambaAuthMode,
        sambaUsername,
        secret?.passwordPath || ''
      ], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 2
      });
      samba = parseJsonLinesBestEffort(out.stdout).at(-1) || { ok: true };
    } finally {
      if (secret) fs.rmSync(secret.tmpDir, { recursive: true, force: true });
    }
  } else {
    const out = await privilegedRun('/usr/local/sbin/tronsoftos-network', ['drive-samba-disable'], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    }).catch(err => ({ stdout: JSON.stringify({ ok: false, error: err.message }) }));
    samba = parseJsonLinesBestEffort(out.stdout).at(-1) || { ok: true };
  }
  ensureStateDir();
  fs.writeFileSync(driveSettingsPath, JSON.stringify(settings, null, 2));
  appendEvent('DRIVE_SETTINGS_UPDATED', { mountPath, path: drivePath, shareName, enabled: settings.enabled, sambaEnabled: settings.sambaEnabled, sambaAuthMode, sambaUsername, samba });
  return driveStatus();
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

function troncomandaPublicUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  return /\/qr$/i.test(normalized) ? `${normalized}/` : `${normalized}/qr/`;
}

function appAccessUrl(app) {
  if (app.name === 'tronfire') {
    return process.env.TRONFIRE_PROXY_PATH || '/tronfire/';
  }
  if (app.name === 'troncomanda') {
    const env = parseEnvFile(path.join(appRoot, 'apps/troncomanda/.env'));
    const baseUrl = env.TRONCOMANDA_PUBLIC_URL
      || (env.TRONCOMANDA_LAN_HOST && env.TRONCOMANDA_WEB_PORT ? `http://${env.TRONCOMANDA_LAN_HOST}:${env.TRONCOMANDA_WEB_PORT}` : '')
      || app.publicUrl
      || app.accessUrl;
    if (baseUrl) return troncomandaPublicUrl(baseUrl);
  }
  if (app.publicUrl || app.accessUrl) return app.publicUrl || app.accessUrl;
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

function commandErrorPayload(err) {
  const stdout = String(err?.stdout || '');
  const stderr = String(err?.stderr || '');
  const message = String(err?.message || 'comando falhou');
  const text = `${stdout}\n${stderr}\n${message}`.trim();
  return {
    ok: false,
    error: text || message,
    exitCode: Number.isInteger(err?.code) ? err.code : null,
    signal: err?.signal || null,
    stdout,
    stderr
  };
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function parseJsonLinesBestEffort(text) {
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseEnvFile(filePath) {
  try {
    return parseEnvText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function formatEnvValue(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.,:@/+ -]*$/.test(text) ? text : JSON.stringify(text);
}

function renderEnvValues(existing, values) {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = { ...values };
  const nextLines = lines.map(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in pending)) return line;
    const key = match[1];
    const value = formatEnvValue(pending[key]);
    delete pending[key];
    return `${key}=${value}`;
  });
  for (const [key, value] of Object.entries(pending)) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }
  return `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join('\n')}\n`;
}

function writeEnvValues(filePath, values) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderEnvValues(existing, values));
}

async function writeEnvValuesPrivileged(filePath, values) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const content = renderEnvValues(existing, values);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return;
  } catch (err) {
    if (!['EACCES', 'EPERM', 'ENOENT'].includes(err.code)) throw err;
    throw new Error(`Sem permissao para gravar ${filePath}. Execute a atualizacao do TronSoftOS para ajustar as permissoes.`);
  }
}

function haSyncLogs(selectedName = '') {
  const safeSelectedName = path.basename(String(selectedName || ''));
  let files = [];
  try {
    files = fs.readdirSync(haSyncLogDir)
      .filter(name => /^ha-sync-\d{14}\.log$/.test(name))
      .map(name => {
        const filePath = path.join(haSyncLogDir, name);
        const stat = fs.statSync(filePath);
        const tail = fs.readFileSync(filePath, 'utf8').slice(-4096);
        const failed = /(^|\n)(curl:|.*\bfailed\b|.*\berror\b|.*Falha|.*erro|.*exit\s+[1-9]\d*)/i.test(tail);
        return {
          name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          status: failed ? 'failed' : 'success',
          summary: tail.trim().split(/\r?\n/).slice(-4).join('\n')
        };
      })
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))
      .slice(0, 50);
  } catch {
    files = [];
  }

  const selected = files.find(file => file.name === safeSelectedName) || files[0] || null;
  let content = '';
  if (selected) {
    const selectedPath = path.join(haSyncLogDir, selected.name);
    const resolved = path.resolve(selectedPath);
    const allowedRoot = path.resolve(haSyncLogDir);
    if (resolved.startsWith(allowedRoot + path.sep)) {
      content = fs.readFileSync(resolved, 'utf8').slice(-1024 * 128);
    }
  }
  return { logDir: haSyncLogDir, files, selected, content };
}

function internalTokenValue() {
  return process.env.TRONSOFTOS_INTERNAL_TOKEN || parseEnvFile(clusterSecretsPath).TRONSOFTOS_INTERNAL_TOKEN || '';
}

async function promoteLocalTronfireStandby() {
  const token = internalTokenValue();
  if (!token) throw new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado para promover o TronFire');
  const target = tronfireProxyTarget();
  const response = await fetch(new URL('/api/ha/standby/promote', target), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tronsoftos-token': token },
    body: JSON.stringify({ confirmation: 'PROMOTE_STANDBY' })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `TronFire HTTP ${response.status}`);
  return payload;
}

async function restartTronfireBackend() {
  try {
    const { stdout, stderr } = await run('docker', ['compose', 'restart', 'backend'], {
      cwd: path.join(appRoot, 'apps/tronfire'),
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 2
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
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
  const primaryHealthUrl = String(env.HA_PRIMARY_HEALTH_URL || '').trim();
  if (primaryHealthUrl) {
    if (!/^https?:\/\/[A-Za-z0-9_.:-]+\/health$/.test(primaryHealthUrl)) throw new Error('HA_PRIMARY_HEALTH_URL invalida');
    normalized.HA_PRIMARY_HEALTH_URL = primaryHealthUrl;
  }
  const optionalKeys = ['TRONSOFTOS_SSH_PUBLIC_KEY', 'HA_VIP', 'HA_VIP_CIDR', 'HA_ROUTER_ID', 'HA_AUTH_PASS', 'HA_PRIMARY_HEALTH_URL'].filter(key => normalized[key]);
  const keys = [...required, ...optionalKeys];
  return {
    values: normalized,
    content: `${keys.map(key => `${key}='${normalized[key]}'`).join('\n')}\n`
  };
}

function exportPairingContent() {
  const base = fs.existsSync(clusterSecretsPath) ? parseEnvText(fs.readFileSync(clusterSecretsPath, 'utf8')) : {};
  const currentPublicKeyPath = path.join(stateDir, 'ssh/id_ed25519.pub');
  const currentPublicKey = fs.existsSync(currentPublicKeyPath) ? fs.readFileSync(currentPublicKeyPath, 'utf8').trim() : '';
  if (!currentPublicKey) throw new Error(`chave publica SSH nao encontrada: ${currentPublicKeyPath}`);
  const primaryHost = String(process.env.HOST_STATIC_IP_ADDRESS_CIDR || process.env.TRONFIRE_LAN_HOST || '').split('/')[0] || '';
  const primaryHealthUrl = process.env.HA_PRIMARY_HEALTH_URL || (primaryHost ? `http://${primaryHost}:${port}/health` : process.env.TRONSOFTOS_HEALTH_URL || '');
  const current = {
    ...base,
    SESSION_SECRET: base.SESSION_SECRET || process.env.SESSION_SECRET || '',
    TRONSOFTOS_INTERNAL_TOKEN: base.TRONSOFTOS_INTERNAL_TOKEN || process.env.TRONSOFTOS_INTERNAL_TOKEN || '',
    POSTGRES_PASSWORD: base.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || '',
    FIREBIRD_PASSWORD: base.FIREBIRD_PASSWORD || process.env.FIREBIRD_PASSWORD || '',
    TRONSOFTOS_SSH_PUBLIC_KEY: currentPublicKey,
    HA_VIP: process.env.HA_VIP || base.HA_VIP || '',
    HA_VIP_CIDR: process.env.HA_VIP_CIDR || base.HA_VIP_CIDR || ((process.env.HA_VIP || base.HA_VIP) ? `${process.env.HA_VIP || base.HA_VIP}/24` : ''),
    HA_ROUTER_ID: process.env.HA_ROUTER_ID || base.HA_ROUTER_ID || '',
    HA_AUTH_PASS: process.env.HA_AUTH_PASS || base.HA_AUTH_PASS || '',
    HA_PRIMARY_HEALTH_URL: primaryHealthUrl
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
    const [psOut, inspectOut] = await Promise.all([
      run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 20_000, maxBuffer: 1024 * 1024 * 5 }),
      run('docker', ['inspect', ...names], { timeout: 20_000, maxBuffer: 1024 * 1024 * 10 }).catch(() => ({ stdout: '[]' }))
    ]);
    const rows = psOut.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const inspected = JSON.parse(inspectOut.stdout || '[]');
    const inspectedByName = new Map(inspected.flatMap(item => (item.Name ? [[String(item.Name).replace(/^\/+/, ''), item]] : [])));
    return names.map(name => {
      const row = rows.find(item => item.Names === name);
      const inspect = inspectedByName.get(name);
      const labels = inspect?.Config?.Labels || {};
      const image = inspect?.Config?.Image || row?.Image || '';
      const imageTag = image.includes(':') ? image.split(':').at(-1) : '';
      const imageId = String(inspect?.Image || row?.ID || '').replace(/^sha256:/, '').slice(0, 12);
      const version = labels['org.opencontainers.image.version']
        || labels['org.opencontainers.image.ref.name']
        || labels.version
        || labels.VERSION
        || imageTag
        || '';
      const revision = labels['org.opencontainers.image.revision'] || labels.revision || '';
      return row
        ? { name, status: row.State || 'unknown', detail: row.Status || '', image, imageTag, imageId, version, revision: revision ? String(revision).slice(0, 12) : '' }
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

async function fetchJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, url, body };
  } catch (err) {
    return { ok: false, status: 'offline', url, error: err.message, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function tronfireAlerts() {
  const token = internalTokenValue();
  if (!token) return [];
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(new URL('/api/internal/alerts', target), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const alerts = await response.json();
    return Array.isArray(alerts) ? alerts.map(normalizeTronfireAlert) : [];
  } catch {
    return [];
  }
}

function normalizeTronfireAlert(alert = {}) {
  const type = String(alert.type || alert.code || '').trim();
  const message = alert.message || type || 'Alerta TronFire';
  const normalized = {
    source: 'TronFire',
    severity: String(alert.severity || 'warning').toLowerCase(),
    title: alert.title || message,
    message,
    code: type || null,
    type: type || null,
    createdAt: alert.createdAt || null,
    details: alert.details || null
  };
  if (type.startsWith('BACKUP_VALIDATION_OVERDUE_')) {
    return {
      ...normalized,
      severity: 'warning',
      title: 'Validacao diaria de backup pendente',
      message: `${message}. Backups simples continuam sendo gerados; a validacao por restore/gstat roda na janela diaria configurada.`,
      details: {
        ...(alert.details || {}),
        category: 'backup_validation',
        validationMode: 'daily',
        operationalImpact: 'backup_available_validation_pending'
      }
    };
  }
  if (type.startsWith('BACKUP_VALIDATION_FAILED_')) {
    return {
      ...normalized,
      severity: 'critical',
      title: 'Validacao de backup falhou',
      message: `${message}. O backup foi gerado, mas nao foi aprovado pelo restore/gstat; investigue antes de considerar esse ponto como recuperavel.`,
      details: {
        ...(alert.details || {}),
        category: 'backup_validation',
        operationalImpact: 'backup_generated_validation_failed'
      }
    };
  }
  if (type.startsWith('FIREBIRD_DEGRADED_') || type.startsWith('FIREBIRD_UNRESPONSIVE_')) {
    return {
      ...normalized,
      severity: 'critical',
      title: 'Firebird em risco operacional',
      message: `${message}. Servico pode estar online, mas o ambiente requer acao tecnica.`,
      details: {
        ...(alert.details || {}),
        category: 'firebird_health',
        operationalImpact: 'service_online_with_database_risk'
      }
    };
  }
  if (type === 'BACKUP_FAILED') {
    return {
      ...normalized,
      severity: 'critical',
      title: 'Backup falhou',
      details: {
        ...(alert.details || {}),
        category: 'backup',
        operationalImpact: 'backup_failure'
      }
    };
  }
  return normalized;
}

async function tronfireCompanyIdentity() {
  if (companyIdentityCache.value && Date.now() - companyIdentityCache.checkedAt < 10 * 60 * 1000) {
    return companyIdentityCache.value;
  }
  const fallback = {
    companyName: null,
    databaseName: null,
    databaseAlias: null
  };
  const token = internalTokenValue();
  if (!token) return fallback;
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(new URL('/api/internal/company-identity', target), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return fallback;
    const value = { ...fallback, ...await response.json() };
    companyIdentityCache = { checkedAt: Date.now(), value };
    return value;
  } catch {
    return companyIdentityCache.value || fallback;
  }
}

async function tronfireSystemMetrics(range = 'day') {
  const token = internalTokenValue();
  if (!token) return null;
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(new URL(`/api/internal/metrics/dashboard?range=${encodeURIComponent(range)}`, target), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
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

function summarizeTronfireHaStatus(payload) {
  const databases = Array.isArray(payload?.databases) ? payload.databases : [];
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
    deploymentMode: payload?.deploymentMode || null,
    nodeRole: payload?.nodeRole || null,
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
}

function haFailoverStatus() {
  const settings = publicHaFailoverSettings();
  const identity = nodeIdentity();
  const guard = clusterGuard();
  const maintenanceBlock = failoverMaintenanceBlock();
  const elapsedSeconds = primaryDownSince ? Math.max(0, Math.floor((Date.now() - primaryDownSince) / 1000)) : 0;
  const remainingSeconds = primaryDownSince && !maintenanceBlock.active ? Math.max(0, settings.timeoutSeconds - elapsedSeconds) : null;
  return {
    ...settings,
    mode: identity.deploymentMode,
    nodeRole: identity.nodeRole,
    watchdogActive: identity.deploymentMode === 'ha' && identity.nodeRole === 'standby' && !!settings.primaryHealthUrl,
    primaryDownSince: primaryDownSince ? new Date(primaryDownSince).toISOString() : null,
    elapsedSeconds,
    remainingSeconds,
    inProgress: autoFailoverInProgress,
    canPromote: guard.canPromote,
    maintenanceBlock,
    guardStatus: guard.status,
    guardReason: guard.reason
  };
}

async function remoteTronfireHaStatus(host) {
  const targetHost = String(host || '').trim();
  if (!targetHost) return null;
  const base = /^https?:\/\//i.test(targetHost) ? targetHost : `http://${targetHost}:${port}`;
  try {
    const token = internalTokenValue();
    if (!token) return { ok: false, url: base, error: 'token interno nao configurado' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(new URL('/api/cluster/standby-status', base), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return { ok: false, url: base, status: response.status };
    return { ...await response.json(), url: base };
  } catch (err) {
    return { ok: false, url: base, error: err.message };
  }
}

async function remoteTronsoftosHealth(host) {
  const targetHost = String(host || '').trim();
  if (!targetHost) return null;
  const base = /^https?:\/\//i.test(targetHost) ? targetHost : `http://${targetHost}:${port}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(new URL('/health', base), { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return { ok: false, url: base, status: response.status };
    const payload = await response.json();
    return { ok: true, url: base, ...payload };
  } catch (err) {
    return { ok: false, url: base, error: err.message };
  }
}

function buildsDiffer(left, right) {
  if (!left || !right) return false;
  return Boolean(
    (left.buildNumber && right.buildNumber && left.buildNumber !== right.buildNumber)
    || (left.commit && right.commit && left.commit !== right.commit)
    || (left.version && right.version && left.version !== right.version)
  );
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
  const tronfireEnv = parseEnvFile(path.join(appRoot, 'apps/tronfire/.env'));
  const apps = [];
  for (const app of config.apps || []) {
    const appContainers = app.name === 'tronfire' && String(tronfireEnv.FIREBIRD_EXEC_MODE || process.env.FIREBIRD_EXEC_MODE || '').toLowerCase() === 'host'
      ? (app.containers || []).filter(name => name !== 'tronfire_firebird25')
      : (app.containers || []);
    const [containers, health] = await Promise.all([
      containerStatus(appContainers),
      fetchHealth(app.healthUrl)
    ]);
    const running = containers.filter(item => item.status === 'running').length;
    const disabledAndStopped = app.enabled === false && running === 0;
    apps.push({
      ...publicApp(app),
      containersExpected: appContainers,
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
    build: buildInfo(),
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
    sync: haSyncStatus(),
    failover: haFailoverStatus()
  };
}

async function localVipPresence(vip) {
  if (!vip) return { present: false, interface: null, cidr: null };
  try {
    const { stdout } = await run('ip', ['-j', '-4', 'addr', 'show', 'scope', 'global'], { timeout: 10_000, maxBuffer: 1024 * 1024 * 2 });
    const interfaces = JSON.parse(stdout);
    for (const item of interfaces) {
      const match = (item.addr_info || []).find(addr => addr.local === vip);
      if (match) {
        return {
          present: true,
          interface: item.ifname || null,
          cidr: `${match.local}/${match.prefixlen}`
        };
      }
    }
  } catch (err) {
    return { present: false, interface: null, cidr: null, error: err.message };
  }
  return { present: false, interface: null, cidr: null };
}

async function vipStatus(cluster) {
  const vip = cluster.vip || process.env.HA_VIP || null;
  const port = process.env.TRONSOFTOS_PORT || '8080';
  const local = await localVipPresence(vip);
  const healthUrl = vip ? `http://${vip}:${port}/health` : null;
  const health = healthUrl ? await fetchJson(healthUrl, 3000) : { ok: null, status: 'not-configured', url: null, body: null };
  const node = health.body?.node || {};
  const expectedLocalPresence = cluster.nodeRole === 'primary';
  const healthRole = node.nodeRole || null;
  const ok = Boolean(vip)
    && health.ok === true
    && healthRole === 'primary'
    && (cluster.nodeRole === 'primary' ? local.present === true : local.present === false);
  return {
    vip,
    port: Number(port) || port,
    healthUrl,
    localPresent: local.present === true,
    localInterface: local.interface,
    localCidr: local.cidr,
    localError: local.error || null,
    expectedLocalPresence,
    reachable: health.ok === true,
    status: health.status,
    ok,
    holder: health.body ? {
      nodeName: node.nodeName || null,
      nodeRole: node.nodeRole || null,
      nodeId: node.nodeId || null,
      clusterId: node.clusterId || null,
      buildNumber: health.body.buildNumber || null,
      version: health.body.version || null
    } : null,
    error: health.error || null
  };
}

async function backupStatus() {
  const backupDir = process.env.FIREBIRD_BACKUP_DIR || '/opt/tronfire-storage/firebird/backups';
  const rclone = publicRcloneSettings();
  const files = [];
  const backupFiles = [];
  const manifests = [];
  try {
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(gbk|fbk|gbk\.gz|fbk\.gz|manifest\.json)$/i.test(entry.name)) continue;
      const filePath = path.join(backupDir, entry.name);
      const stat = fs.statSync(filePath);
      const file = { name: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      files.push(file);
      if (/\.(gbk|fbk)(\.gz)?$/i.test(entry.name)) {
        backupFiles.push(file);
      } else if (/\.manifest\.json$/i.test(entry.name)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          manifests.push({ ...file, manifest });
        } catch {
          manifests.push(file);
        }
      }
    }
  } catch {
    // Directory may not exist before install.
  }
  files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  backupFiles.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  manifests.sort((a, b) => {
    const aDate = a.manifest?.backupFinishedAt || a.modifiedAt;
    const bDate = b.manifest?.backupFinishedAt || b.modifiedAt;
    return new Date(bDate) - new Date(aDate);
  });
  const latestManifest = manifests[0] || null;
  const latestBackupFile = backupFiles[0] || null;
  const latestValidatedBackupAt = latestManifest?.manifest?.validation?.ok
    ? latestManifest.manifest.backupFinishedAt || latestManifest.modifiedAt
    : null;
  const latestBackupAt = latestValidatedBackupAt;
  const latestBackupFileAt = latestBackupFile?.modifiedAt || null;
  const [quota, disk] = await Promise.all([
    rcloneAbout(),
    diskUsageForPath(backupDir)
  ]);
  return {
    backupDir,
    rclone,
    quota,
    disk,
    latestBackupAt,
    latestValidatedBackupAt,
    latestBackupFileAt,
    latestBackupFileValidated: Boolean(
      latestBackupFile
      && latestManifest?.manifest?.validation?.ok
      && String(latestManifest.manifest?.backupPath || '').endsWith(latestBackupFile.name)
    ),
    latestFile: latestBackupFile,
    latestManifest: latestManifest ? {
      name: latestManifest.name,
      path: latestManifest.path,
      size: latestManifest.size,
      modifiedAt: latestManifest.modifiedAt,
      backupFinishedAt: latestManifest.manifest?.backupFinishedAt || null,
      validationOk: latestManifest.manifest?.validation?.ok === true
    } : null,
    recentFiles: files.slice(0, 20)
  };
}

function rawCloudflareSettings() {
  const saved = readJson(cloudflareSettingsPath, {});
  const savedToken = Object.prototype.hasOwnProperty.call(saved, 'tunnelToken') ? saved.tunnelToken : saved.apiToken;
  const envToken = process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '';
  const savedMaintenanceHost = String(saved.maintenanceSshHostname || '').trim();
  const envMaintenanceHost = String(process.env.CLOUDFLARE_TUNNEL_SSH_HOSTNAME || '').trim();
  return {
    mode: 'tunnel',
    enabled: saved.enabled === true || process.env.CLOUDFLARE_TUNNEL_ENABLED === 'true',
    tokenCleared: saved.tokenCleared === true,
    tunnelToken: saved.tokenCleared === true ? String(savedToken || '') : savedToken || envToken || '',
    maintenanceSshEnabled: saved.maintenanceSshEnabled === true || process.env.CLOUDFLARE_TUNNEL_SSH_ENABLED === 'true',
    maintenanceSshHostname: savedMaintenanceHost || envMaintenanceHost,
    maintenanceSshService: 'ssh://host.docker.internal:22'
  };
}

function publicCloudflareSettings(settings = rawCloudflareSettings()) {
  return {
    mode: 'tunnel',
    enabled: settings.enabled === true,
    tokenConfigured: !!settings.tunnelToken && settings.tunnelToken !== 'change-me',
    maintenanceSshEnabled: settings.maintenanceSshEnabled === true,
    maintenanceSshHostname: settings.maintenanceSshHostname || '',
    maintenanceSshService: settings.maintenanceSshService || 'ssh://host.docker.internal:22'
  };
}

function normalizeCloudflareSettings(body) {
  const current = rawCloudflareSettings();
  const providedToken = body.tunnelToken ? String(body.tunnelToken).trim() : '';
  const maintenanceSshHostname = String(body.maintenanceSshHostname ?? current.maintenanceSshHostname ?? '').trim().toLowerCase();
  const next = {
    mode: 'tunnel',
    enabled: body.enabled === true,
    tokenCleared: providedToken ? false : current.tokenCleared === true,
    tunnelToken: providedToken || current.tunnelToken || '',
    maintenanceSshEnabled: body.maintenanceSshEnabled === true,
    maintenanceSshHostname,
    maintenanceSshService: 'ssh://host.docker.internal:22'
  };
  if (next.enabled) {
    if (!next.tunnelToken) throw new Error('token do Cloudflare Tunnel nao informado');
    if (next.maintenanceSshEnabled && !next.maintenanceSshHostname) {
      throw new Error('hostname SSH de manutencao nao informado');
    }
    if (next.maintenanceSshHostname && !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(next.maintenanceSshHostname)) {
      throw new Error('hostname SSH de manutencao invalido');
    }
  }
  return next;
}

function writeCloudflareSettings(body) {
  ensureStateDir();
  const settings = normalizeCloudflareSettings(body);
  fs.writeFileSync(cloudflareSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  appendEvent('CLOUDFLARE_SETTINGS_UPDATED', {
    enabled: settings.enabled,
    mode: settings.mode,
    maintenanceSshEnabled: settings.maintenanceSshEnabled,
    maintenanceSshHostname: settings.maintenanceSshHostname || ''
  });
  return publicCloudflareSettings(settings);
}

async function applyCloudflareTunnelConnector() {
  const script = '/usr/local/sbin/tronsoftos-cloudflare-tunnel';
  if (!fs.existsSync(script)) return { ok: false, skipped: true, message: 'script do connector ainda nao instalado' };
  const { stdout, stderr } = await privilegedRun(script, ['apply'], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function stopCloudflareTunnelConnector() {
  const script = '/usr/local/sbin/tronsoftos-cloudflare-tunnel';
  if (!fs.existsSync(script)) return { ok: false, skipped: true, message: 'script do connector ainda nao instalado' };
  const { stdout, stderr } = await privilegedRun(script, ['stop'], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
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
  const normalized = normalizeCloudflareSettings(settings);
  if (!normalized.tunnelToken) throw new Error('token do Cloudflare Tunnel nao configurado');
  const connector = await applyCloudflareTunnelConnector();
  appendEvent('CLOUDFLARE_TUNNEL_TEST_OK', { enabled: normalized.enabled });
  return {
    ok: true,
    message: connector.ok ? 'Token configurado e connector aplicado.' : 'Token do Cloudflare Tunnel configurado.',
    connector
  };
}

async function cloudflareSync() {
  const settings = rawCloudflareSettings();
  if (settings.enabled !== true) throw new Error('Cloudflare Tunnel desabilitado');
  const normalized = normalizeCloudflareSettings(settings);
  appendEvent('CLOUDFLARE_TUNNEL_READY', { enabled: normalized.enabled });
  return {
    ok: true,
    message: normalized.maintenanceSshEnabled
      ? `Tunnel configurado. Crie no painel da Cloudflare uma rota Public Hostname ${normalized.maintenanceSshHostname} apontando para ${normalized.maintenanceSshService}.`
      : 'Tunnel configurado. As rotas sao gerenciadas no painel da Cloudflare.'
  };
}

function cloudflareStatus() {
  return publicCloudflareSettings();
}

async function saveCloudflareSettings(body) {
  const settings = writeCloudflareSettings(body);
  let connector = null;
  try {
    connector = await applyCloudflareTunnelConnector();
  } catch (err) {
    appendEvent('CLOUDFLARE_TUNNEL_APPLY_FAILED', { error: err.message });
    throw err;
  }
  return { ...settings, connector };
}

async function resetCloudflareSettings() {
  ensureStateDir();
  const settings = {
    mode: 'tunnel',
    enabled: false,
    tokenCleared: true,
    tunnelToken: '',
    maintenanceSshEnabled: false,
    maintenanceSshHostname: '',
    maintenanceSshService: 'ssh://host.docker.internal:22'
  };
  fs.writeFileSync(cloudflareSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  let connector = null;
  try {
    connector = await stopCloudflareTunnelConnector();
  } catch (err) {
    appendEvent('CLOUDFLARE_TUNNEL_RESET_STOP_FAILED', { error: err.message });
    throw err;
  }
  appendEvent('CLOUDFLARE_TUNNEL_TOKEN_RESET', { enabled: false });
  return { ...publicCloudflareSettings(settings), connector, message: 'Token removido e connector parado.' };
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
  const expected = internalTokenValue();
  if (!expected) {
    const error = new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado');
    error.statusCode = 503;
    throw error;
  }
  const received = String(req.headers['x-tronsoftos-token'] || '');
  if (!timingSafeEqualText(received, expected)) {
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

async function hostFirebirdScript(req) {
  assertInternalToken(req);
  const body = await readBody(req);
  const script = String(body.script || '');
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs || 14_400_000), 60_000), 14_400_000);
  if (!script.startsWith('# TronFire host Firebird script\n')) throw new Error('Script Firebird invalido');
  if (script.length > 1024 * 512) throw new Error('Script Firebird muito grande');
  ensureStateDir();
  const tmpPath = `/tmp/tronsoftos-firebird-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`;
  fs.writeFileSync(tmpPath, script, { mode: 0o700 });
  try {
    let out;
    try {
      out = await privilegedRun('/usr/local/sbin/tronsoftos-network', ['firebird-script', tmpPath], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
        env: { ...process.env, TERM: 'dumb' }
      });
    } catch (err) {
      const payload = commandErrorPayload(err);
      appendEvent('FIREBIRD_HOST_SCRIPT_FAILED', { script: path.basename(tmpPath), error: payload.error, exitCode: payload.exitCode, signal: payload.signal });
      return payload;
    }
    const result = parseJsonLinesBestEffort(out.stdout).at(-1) || { ok: true };
    const stderr = stripTerminalNoise(out.stderr);
    appendEvent('FIREBIRD_HOST_SCRIPT_EXECUTED', { script: path.basename(tmpPath), ...(stderr ? { stderr } : {}) });
    return { ...result, stdout: out.stdout, stderr };
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
      warnings.push({ level: 'warning', message: 'HA esta ativo, mas HA_VIP nao esta configurado.' });
    } else if (proposed && sameIpv4Subnet(proposedCidr, vipCidr) === false) {
      warnings.push({ level: 'danger', message: `VIP ${vip} nao esta na mesma faixa do IP ${proposedCidr}.` });
      actions.push('Escolher um VIP na mesma rede do IP real do servidor.');
    }
    if (identity.nodeRole === 'primary' && syncSettings.enabled && !syncSettings.standbyHost) {
      warnings.push({ level: 'warning', message: 'Sync HA esta habilitado, mas o IP real do standby nao foi informado.' });
    }
    if (identity.nodeRole === 'standby' && currentAddress && syncSettings.standbyHost === currentAddress.address) {
      warnings.push({ level: 'warning', message: 'Este standby parece apontar o Sync HA para ele mesmo.' });
    }
  }
  if (proposed && currentAddress && proposed.address !== currentAddress.address) {
    actions.push('Atualizar o outro no para usar este novo IP real em SSH/rsync.');
    actions.push('Recriar/reiniciar containers para recarregar arquivos .env que dependem do IP.');
  }
  if (identity.deploymentMode === 'ha' && proposed && currentAddress && proposed.address !== currentAddress.address) {
    warnings.push({ level: 'info', message: 'A troca do IP real nao altera o VIP automaticamente.' });
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
      tokenConfigured: cloudflare.tokenConfigured
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
  for (const key of ['HA_VIP', 'HA_VIP_CIDR', 'HA_ROUTER_ID', 'HA_AUTH_PASS', 'HA_PRIMARY_HEALTH_URL']) {
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
    keepalived: pairing.values.HA_VIP_CIDR && pairing.values.HA_ROUTER_ID && pairing.values.HA_AUTH_PASS ? {
      vipCidr: pairing.values.HA_VIP_CIDR,
      routerId: Number(pairing.values.HA_ROUTER_ID),
      authPassImported: true
    } : null,
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
  const [apps, localTronfireHa, systemMetrics] = await Promise.all([appsStatus(), tronfireHaStatus(), tronfireSystemMetrics()]);
  const cluster = clusterStatus();
  const haMode = cluster.mode === 'ha';
  cluster.vipStatus = await vipStatus(cluster);
  const identity = cluster.identity || nodeIdentity();
  if (haMode && cluster.sync?.standbyHost) {
    cluster.standbyHealth = await remoteTronsoftosHealth(cluster.sync.standbyHost);
  }
  const tronfireHa = haMode && identity.nodeRole === 'primary' && cluster.sync?.standbyHost
    ? await remoteTronfireHaStatus(cluster.sync.standbyHost)
    : haMode
      ? localTronfireHa
      : null;
  if (haMode && tronfireHa && cluster.sync) {
    cluster.sync.tronfireStandby = tronfireHa;
    const requiredReady = tronfireHa.ok !== false && tronfireHa.allReady === true;
    const latestRestoredBackupAt = tronfireHa.latestBackupAt ? new Date(tronfireHa.latestBackupAt).getTime() : 0;
    const latestReceivedBackupAt = cluster.sync.receiver?.latestValidatedBackup?.modifiedAt ? new Date(cluster.sync.receiver.latestValidatedBackup.modifiedAt).getTime() : 0;
    const latestBackupAtMs = latestRestoredBackupAt || latestReceivedBackupAt;
    const lagMinutes = latestBackupAtMs ? Math.max(0, Math.round((Date.now() - latestBackupAtMs) / 60000)) : null;
    cluster.sync.standbyLagMinutes = lagMinutes;
    cluster.sync.standbyReady = requiredReady && lagMinutes !== null && lagMinutes <= FIXED_HA_SYNC_INTERVAL_MINUTES * 2;
    cluster.sync.promotionReady = cluster.sync.standbyReady && cluster.sync.status !== 'failed';
    cluster.sync.receiverReady = ['standby', 'recovery'].includes(identity.nodeRole) && cluster.sync.standbyReady;
  }
  const backups = await backupStatus();
  const alerts = [];
  if (apps.some(app => app.status === 'offline' && app.enabled)) alerts.push({ severity: 'critical', message: 'App gerenciado offline' });
  if (buildsDiffer(cluster.build, cluster.standbyHealth)) {
    const localVersion = cluster.build.buildNumber ? `build ${cluster.build.buildNumber}` : (cluster.build.commit || cluster.build.version);
    const standbyVersion = cluster.standbyHealth.buildNumber ? `build ${cluster.standbyHealth.buildNumber}` : (cluster.standbyHealth.commit || cluster.standbyHealth.version);
    alerts.push({ severity: 'warning', message: `Nos HA em versoes diferentes: local ${localVersion}, standby ${standbyVersion}` });
  }
  if (haMode && !cluster.lock) alerts.push({ severity: 'warning', message: 'Cluster HA sem cluster-lock' });
  if (haMode && identity.nodeRole === 'primary' && cluster.sync?.standbyHost && cluster.sync?.sshValidated !== true) {
    alerts.push({ severity: 'warning', message: 'Pareamento SSH do standby pendente: o TronSoftOS tentara validar automaticamente' });
  }
  if (haMode && cluster.sync?.status === 'failed') {
    alerts.push({
      severity: 'warning',
      message: 'Sync HA em recuperacao: ultima tentativa falhou; aguarde a proxima execucao ou rode o sync manual se persistir'
    });
  }
  if (haMode && cluster.sync?.status === 'deferred') {
    alerts.push({
      severity: 'warning',
      message: 'Sync HA adiado: backup do TronFire em andamento; nova tentativa automatica ocorrera no proximo ciclo'
    });
  }
  if (haMode && cluster.failover?.maintenanceBlock?.active) {
    alerts.push({
      severity: cluster.failover.maintenanceBlock.expired ? 'critical' : 'warning',
      message: cluster.failover.maintenanceBlock.expired
        ? 'Primary em manutencao planejada excedeu o tempo limite. Failover automatico bloqueado; acao tecnica necessaria.'
        : `Failover automatico suspenso por manutencao planejada ate ${formatIsoForAlert(cluster.failover.maintenanceBlock.expiresAt)}`
    });
  }
  if (haMode && cluster.failover?.primaryDownSince) {
    const maintenanceBlocked = cluster.failover.maintenanceBlock?.active === true;
    const standbyBlocked = !maintenanceBlocked && cluster.failover.enabled && cluster.sync?.enabled && cluster.sync?.standbyReady === false;
    alerts.push({
      severity: cluster.failover.enabled && !standbyBlocked && !maintenanceBlocked ? 'critical' : 'warning',
      message: maintenanceBlocked
        ? 'Primary indisponivel, mas failover automatico esta bloqueado por manutencao planejada'
        : cluster.failover.enabled
        ? standbyBlocked
          ? 'Primary indisponivel: promocao automatica bloqueada porque o standby nao esta pronto'
          : `Primary indisponivel: failover automatico em ${cluster.failover.remainingSeconds ?? 0}s`
        : 'Primary indisponivel: failover em modo manual'
    });
    if (standbyBlocked) {
      const standbySummary = cluster.sync.tronfireStandby?.databaseCount
        ? `${cluster.sync.tronfireStandby.readyCount || 0}/${cluster.sync.tronfireStandby.databaseCount} bancos READY`
        : 'sem banco READY confirmado';
      alerts.push({
        severity: 'critical',
        message: `Standby nao assumiu: primary indisponivel, mas o sync foi interrompido ou o standby nao esta READY (${standbySummary}). Restaure/valide o banco pelo TronFire antes de promover.`
      });
    }
  }
  if (haMode && cluster.sync?.enabled && cluster.sync?.standbyLagMinutes !== null && cluster.sync.standbyLagMinutes > FIXED_HA_SYNC_INTERVAL_MINUTES * 2) {
    const lagLabel = cluster.sync.syncMode === 'physical' ? 'sem standby fisico validado' : 'sem backup validado/restauravel';
    alerts.push({
      severity: cluster.sync.standbyLagMinutes >= HA_SYNC_CRITICAL_LAG_MINUTES ? 'critical' : 'warning',
      message: `Standby atrasado: ${cluster.sync.standbyLagMinutes} min ${lagLabel}`
    });
  }
  if (haMode && cluster.sync?.enabled && cluster.sync?.syncMode === 'backup_restore') {
    const intervalMinutes = FIXED_HA_SYNC_INTERVAL_MINUTES;
    const latestBackupAt = cluster.sync.receiver?.latestValidatedBackup?.modifiedAt ? new Date(cluster.sync.receiver.latestValidatedBackup.modifiedAt).getTime() : 0;
    const backupAgeMinutes = latestBackupAt ? Math.round((Date.now() - latestBackupAt) / 60000) : null;
    if (backupAgeMinutes === null) {
      alerts.push({ severity: 'warning', message: 'Sync HA sem backup validado disponivel' });
    } else if (backupAgeMinutes > intervalMinutes * 2) {
      alerts.push({ severity: 'warning', message: `Backup validado atrasado: ${backupAgeMinutes} min desde o ultimo manifesto aprovado` });
    }
  }
  if (!backups.rclone.remote || !backups.rclone.configConfigured) alerts.push({ severity: 'warning', message: 'Google Drive nao configurado para backups' });
  if (backups.disk?.percentUsed >= 97) alerts.push({ severity: 'critical', message: `Disco de backup com ${backups.disk.percentUsed}% de uso` });
  else if (backups.disk?.percentUsed >= 90) alerts.push({ severity: 'warning', message: `Disco de backup com ${backups.disk.percentUsed}% de uso` });
  if (backups.quota?.percentUsed >= 97) alerts.push({ severity: 'critical', message: `Google Drive com ${backups.quota.percentUsed}% de uso` });
  else if (backups.quota?.percentUsed >= 90) alerts.push({ severity: 'warning', message: `Google Drive com ${backups.quota.percentUsed}% de uso` });
  if (backups.quota && backups.quota.ok === false) alerts.push({ severity: 'warning', message: `Falha ao consultar espaco do Google Drive: ${backups.quota.error}` });
  alerts.push(...await tronfireAlerts());
  await notifyCriticalAlerts(alerts);
  return {
    generatedAt: new Date().toISOString(),
    build: buildInfo(),
    cluster,
    apps,
    systemMetrics,
    hostUptimeSeconds: Math.floor(os.uptime()),
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
    build: buildInfo(),
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

function troncomandaImageTagEnv(branch = 'main') {
  const tag = branch === 'dev' ? ':dev' : ':main';
  return {
    API_IMAGE_TAG: tag,
    QR_IMAGE_TAG: tag,
    CARDAPIO_IMAGE_TAG: tag,
    RETAGUARDA_API_IMAGE_TAG: tag,
    RETAGUARDA_WEB_IMAGE_TAG: tag,
    TSGERENTE_API_IMAGE_TAG: tag,
    TSGERENTE_WEB_IMAGE_TAG: tag
  };
}

function appActionSteps(app, action, options = {}) {
  if (!['up', 'stop', 'restart', 'pull'].includes(action)) throw new Error('invalid action');
  if (app.type !== 'compose') throw new Error('only compose apps are supported');
  const branch = String(options.branch || 'main').trim();
  if (app.name === 'troncomanda' && !['main', 'dev'].includes(branch)) throw new Error(`branch TronComanda invalida: ${branch}`);
  const env = app.name === 'troncomanda' && ['up', 'pull'].includes(action) ? troncomandaImageTagEnv(branch) : null;
  const composeFiles = app.composeFiles || (app.composeFile ? [app.composeFile] : []);
  if (!composeFiles.length) throw new Error('compose file not configured');
  const baseArgs = ['compose', '-p', app.projectName || app.name];
  for (const composeFile of composeFiles) {
    baseArgs.push('-f', path.resolve(appRoot, composeFile));
  }
  if (action === 'up') return [{ command: 'docker', args: [...baseArgs, 'up', '-d'], env }];
  if (action === 'restart') return [{ command: 'docker', args: [...baseArgs, 'restart'] }];
  if (action === 'pull') {
    return [
      { command: 'docker', args: [...baseArgs, 'pull'], env },
      { command: 'docker', args: [...baseArgs, 'up', '-d'], env }
    ];
  }
  return [{ command: 'docker', args: [...baseArgs, action] }];
}

function appActionCommand(app, action) {
  return appActionSteps(app, action)[0];
}

const TRONCOMANDA_OPTIONAL_SERVICES = {
  cardapio: ['cardapio-lite'],
  retaguarda: ['tsretaguarda-api', 'tsretaguarda-web'],
  gerente: ['tsgerente-api', 'tsgerente-web']
};

function troncomandaEnvPath() {
  return path.join(appRoot, 'apps/troncomanda/.env');
}

function troncomandaStorageRoot(env = parseEnvFile(troncomandaEnvPath())) {
  return env.TRONCOMANDA_STORAGE_ROOT || '/opt/tronfire-storage/troncomanda';
}

function troncomandaQrEnvPath(env = parseEnvFile(troncomandaEnvPath())) {
  return path.join(troncomandaStorageRoot(env), 'qr-static/.env');
}

function normalizedProfiles(value) {
  return new Set(String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean));
}

async function troncomandaSettings() {
  const env = parseEnvFile(troncomandaEnvPath());
  const qrEnvPath = troncomandaQrEnvPath(env);
  const qrEnv = parseEnvFile(qrEnvPath);
  const profiles = normalizedProfiles(env.COMPOSE_PROFILES);
  const containers = await containerStatus([
    'troncomanda_cardapio_lite',
    'tsretaguarda-api',
    'tsretaguarda-web',
    'tsgerente-api',
    'tsgerente-web',
    'troncomanda_qr'
  ]);
  return {
    tableRequired: String(qrEnv.TABLE_REQUERID ?? env.TRONCOMANDA_TABLE_REQUIRED ?? '0') === '1',
    cardapioLiteEnabled: profiles.has('cardapio'),
    retaguardaWebEnabled: profiles.has('retaguarda'),
    gerenteWebEnabled: profiles.has('gerente'),
    composeProfiles: Array.from(profiles),
    envPath: troncomandaEnvPath(),
    qrEnvPath,
    containers
  };
}

function troncomandaComposeBaseArgs() {
  return ['compose', '-p', 'troncomanda', '-f', path.join(appRoot, 'apps/troncomanda/docker-compose.yml')];
}

async function runTroncomandaCompose(args, options = {}) {
  return run('docker', [...troncomandaComposeBaseArgs(), ...args], {
    timeout: options.timeout || 1000 * 60 * 10,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 10,
    env: dockerEnv()
  });
}

async function writeTroncomandaSettings(body = {}) {
  const current = await troncomandaSettings();
  const next = {
    tableRequired: body.tableRequired !== undefined ? !!body.tableRequired : current.tableRequired,
    cardapioLiteEnabled: body.cardapioLiteEnabled !== undefined ? !!body.cardapioLiteEnabled : current.cardapioLiteEnabled,
    retaguardaWebEnabled: body.retaguardaWebEnabled !== undefined ? !!body.retaguardaWebEnabled : current.retaguardaWebEnabled,
    gerenteWebEnabled: body.gerenteWebEnabled !== undefined ? !!body.gerenteWebEnabled : current.gerenteWebEnabled
  };
  const profiles = [];
  if (next.cardapioLiteEnabled) profiles.push('cardapio');
  if (next.retaguardaWebEnabled) profiles.push('retaguarda');
  if (next.gerenteWebEnabled) profiles.push('gerente');

  const envPath = troncomandaEnvPath();
  const env = parseEnvFile(envPath);
  const qrEnvPath = troncomandaQrEnvPath(env);
  await writeEnvValuesPrivileged(envPath, {
    COMPOSE_PROFILES: profiles.join(','),
    TRONCOMANDA_TABLE_REQUIRED: next.tableRequired ? '1' : '0'
  });
  await writeEnvValuesPrivileged(qrEnvPath, { TABLE_REQUERID: next.tableRequired ? '1' : '0' });

  const enabledServices = [
    ...(next.cardapioLiteEnabled ? TRONCOMANDA_OPTIONAL_SERVICES.cardapio : []),
    ...(next.retaguardaWebEnabled ? TRONCOMANDA_OPTIONAL_SERVICES.retaguarda : []),
    ...(next.gerenteWebEnabled ? TRONCOMANDA_OPTIONAL_SERVICES.gerente : [])
  ];
  const disabledServices = [
    ...(next.cardapioLiteEnabled ? [] : TRONCOMANDA_OPTIONAL_SERVICES.cardapio),
    ...(next.retaguardaWebEnabled ? [] : TRONCOMANDA_OPTIONAL_SERVICES.retaguarda),
    ...(next.gerenteWebEnabled ? [] : TRONCOMANDA_OPTIONAL_SERVICES.gerente)
  ];
  const outputs = [];
  if (enabledServices.length) {
    outputs.push({ action: 'up', services: enabledServices, ...(await runTroncomandaCompose(['up', '-d', ...enabledServices])) });
  }
  if (disabledServices.length) {
    outputs.push({ action: 'stop', services: disabledServices, ...(await runTroncomandaCompose(['stop', ...disabledServices])) });
  }
  outputs.push({ action: 'qr-refresh', services: ['troncomanda_qr'], ...(await runTroncomandaCompose(['up', '-d', '--force-recreate', 'qr'])) });

  appendEvent('TRONCOMANDA_SETTINGS_UPDATED', { next, profiles, outputs: outputs.map(item => ({ action: item.action, services: item.services })) });
  return { ...(await troncomandaSettings()), outputs };
}

function dockerEnv() {
  ensureStateDir();
  fs.mkdirSync(dockerConfigDir, { recursive: true, mode: 0o700 });
  return { ...process.env, DOCKER_CONFIG: dockerConfigDir };
}

async function downloadInstallerSecretsIfNeeded({ force = false } = {}) {
  const dest = path.join(stateDir, 'installer-secrets.env');
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  if (!installerSecretsUrl) return null;

  ensureStateDir();
  let response = await fetch(installerSecretsUrl);
  if (!response.ok) throw new Error(`falha ao baixar credenciais privadas: HTTP ${response.status}`);
  let text = await response.text();
  if (!/TRONSOFTOS_GHCR_(USER|TOKEN)|GHCR_(USER|TOKEN)/.test(text)) {
    const href = text.match(/href="([^"]*\/download\?token=[^"]*)"/)?.[1];
    if (href) {
      const downloadUrl = new URL(href, installerSecretsUrl);
      const cookie = cookieHeaderFromResponse(response);
      response = await fetch(downloadUrl, { headers: cookie ? { cookie } : {} });
      if (!response.ok) throw new Error(`falha ao baixar credenciais privadas: HTTP ${response.status}`);
      text = await response.text();
    }
  }
  if (!/TRONSOFTOS_GHCR_(USER|TOKEN)|GHCR_(USER|TOKEN)/.test(text)) {
    throw new Error('arquivo de credenciais privadas nao contem variaveis GHCR esperadas');
  }
  fs.writeFileSync(`${dest}.tmp`, text, { mode: 0o600 });
  fs.renameSync(`${dest}.tmp`, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

function cookieHeaderFromResponse(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=[^;,]+=)/);
  return values
    .map(value => String(value || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function readInstallerRegistryCredentials() {
  const candidates = [
    path.join(stateDir, 'installer-secrets.env'),
    path.join(appRoot, 'config/installer-secrets.env'),
    '/etc/tronsoftos/installer-secrets.env'
  ];

  if (installerSecretsUrl) {
    const hasLocalFallback = candidates.some(filePath => fs.existsSync(filePath));
    try {
      const downloaded = await downloadInstallerSecretsIfNeeded({ force: true });
      if (downloaded) candidates.unshift(downloaded);
    } catch (err) {
      appendEvent('INSTALLER_SECRETS_DOWNLOAD_FAILED', { url: installerSecretsUrl, error: err.message });
      if (!hasLocalFallback) throw err;
    }
  } else if (!candidates.some(filePath => fs.existsSync(filePath))) {
    const downloaded = await downloadInstallerSecretsIfNeeded();
    if (downloaded) candidates.unshift(downloaded);
  }

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const env = parseEnvFile(filePath);
    const registry = String(env.TRONSOFTOS_GHCR_REGISTRY || env.GHCR_REGISTRY || 'ghcr.io').trim();
    const username = String(env.TRONSOFTOS_GHCR_USER || env.GHCR_USER || '').trim();
    const token = String(env.TRONSOFTOS_GHCR_TOKEN || env.GHCR_TOKEN || '').trim();
    if (registry && username && token) return { registry, username, token, source: filePath };
  }
  return null;
}

function dockerRegistryLoginWithCredentials(credentials) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['login', credentials.registry, '-u', credentials.username, '--password-stdin'], { cwd: appRoot, env: dockerEnv(), windowsHide: true });
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
      appendEvent(code === 0 ? 'DOCKER_REGISTRY_LOGIN_OK' : 'DOCKER_REGISTRY_LOGIN_FAILED', {
        registry: credentials.registry,
        username: credentials.username,
        source: credentials.source,
        exitCode: code,
        stdout,
        stderr
      });
      if (code !== 0) return reject(new Error(stderr || stdout || `docker login saiu com codigo ${code}`));
      resolve({ ok: true, stdout, stderr });
    });
    child.stdin.end(`${credentials.token}\n`);
  });
}

async function ensureTroncomandaRegistryLogin(job) {
  const credentials = await readInstallerRegistryCredentials();
  if (!credentials) {
    throw new Error('Credenciais GHCR nao encontradas para baixar imagens privadas do TronComanda');
  }
  appendActionLog(job, 'stdout', `Autenticando no ${credentials.registry} para baixar imagens privadas...\n`);
  await dockerRegistryLoginWithCredentials(credentials);
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

function updateStatusJob(id) {
  const state = readJson(updateStatusPath, null);
  if (!state || state.id !== id) return null;
  return publicActionJob({
    id: state.id,
    app: state.app || 'tronsoftos',
    action: state.action || `update-${state.branch || 'main'}`,
    command: state.command || 'sudo',
    args: state.args || ['/usr/bin/bash', path.join(appRoot, 'scripts/update-tronsoftos.sh'), state.branch || 'main'],
    status: state.status || 'running',
    startedAt: state.startedAt || null,
    finishedAt: state.finishedAt || null,
    exitCode: state.exitCode ?? null,
    error: state.error || null,
    stdout: state.stdout || state.message || '',
    stderr: state.stderr || ''
  });
}

function writeUpdateStatus(state) {
  ensureStateDir();
  fs.writeFileSync(updateStatusPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendActionLog(job, stream, chunk) {
  job[stream] += redactSecrets(chunk.toString());
  if (job[stream].length > maxActionLogLength) {
    job[stream] = job[stream].slice(job[stream].length - maxActionLogLength);
  }
}

function runActionStep(job, step) {
  return new Promise((resolve, reject) => {
    appendActionLog(job, 'stdout', `$ ${step.command} ${step.args.join(' ')}\n`);
    const child = spawn(step.command, step.args, { cwd: appRoot, env: { ...dockerEnv(), ...(step.env || {}) }, windowsHide: true });
    child.stdout.on('data', chunk => appendActionLog(job, 'stdout', chunk));
    child.stderr.on('data', chunk => appendActionLog(job, 'stderr', chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(Object.assign(new Error(`${step.command} saiu com codigo ${code}`), { exitCode: code }));
      resolve(code);
    });
  });
}

function startAppAction(app, action, options = {}) {
  const steps = appActionSteps(app, action, options);
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const branch = app.name === 'troncomanda' && ['up', 'pull'].includes(action) ? String(options.branch || 'main').trim() : null;
  const job = {
    id,
    app: app.name,
    action: branch ? `${action}-${branch}` : action,
    command: steps.map(step => step.command).join(' && '),
    args: steps.flatMap(step => step.args),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: ''
  };
  actionJobs.set(id, job);
  (async () => {
    try {
      if (app.name === 'troncomanda' && ['up', 'pull'].includes(action)) {
        await ensureTroncomandaRegistryLogin(job);
      }
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      appendEvent(`APP_${action.toUpperCase()}_FAILED`, { app: app.name, error: err.message });
      return;
    }

    try {
      for (const step of steps) {
        await runActionStep(job, step);
      }
      job.exitCode = 0;
      job.status = 'success';
      job.finishedAt = new Date().toISOString();
      appendEvent(`APP_${action.toUpperCase()}`, { app: app.name, exitCode: 0, stdout: job.stdout, stderr: job.stderr });
    } catch (err) {
      job.exitCode = err.exitCode ?? 1;
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      appendEvent(`APP_${action.toUpperCase()}_FAILED`, { app: app.name, error: err.message });
    }
  })();
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
  if (!settings.sshValidated) throw new Error('pareamento SSH do standby ainda nao foi validado; aguarde a verificacao automatica');
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
    HA_SYNC_MODE: settings.syncMode || DEFAULT_HA_SYNC_MODE,
    HA_SYNC_SSH_USER: settings.sshUser || 'tronsoft',
    HA_SYNC_SSH_PORT: String(settings.sshPort || 22),
    HA_SYNC_REMOTE_BACKUP_DIR: settings.remoteBackupDir || '/opt/tronfire-storage/firebird/backups',
    HA_SYNC_REMOTE_RESTORE_DIR: settings.remoteRestoreDir || '/opt/tronfire-storage/firebird/restore-work',
    HA_SYNC_REMOTE_CATALOG_DIR: settings.remoteCatalogDir || '/tmp/tronfire-catalog',
    HA_SYNC_STANDBY_TRONFIRE_URL: process.env.HA_SYNC_STANDBY_TRONFIRE_URL || `http://127.0.0.1:${process.env.TRONFIRE_PANEL_PORT || 8081}`,
    FIREBIRD_BACKUP_DIR: settings.backupDir || '/opt/tronfire-storage/firebird/backups',
    FIREBIRD_DATA_DIR: process.env.FIREBIRD_DATA_DIR || '/opt/tronfire-storage/firebird/data',
    FIREBIRD_BIN: process.env.FIREBIRD_BIN || '/usr/local/firebird/bin',
    FIREBIRD_PASSWORD: process.env.FIREBIRD_PASSWORD || parseEnvFile(clusterSecretsPath).FIREBIRD_PASSWORD || 'masterkey',
    TRONFIRE_CATALOG_EXPORT_DIR: settings.catalogDir || path.join(stateDir, 'tronfire-catalog'),
    TRONSOFTOS_HA_SYNC_ACTIVE_FILE: process.env.TRONSOFTOS_HA_SYNC_ACTIVE_FILE || path.join(stateDir, 'ha-sync.active'),
    TRONFIRE_POSTGRES_CONTAINER: process.env.TRONFIRE_POSTGRES_CONTAINER || 'tronfire_postgres',
    TRONFIRE_POSTGRES_DB: process.env.TRONFIRE_POSTGRES_DB || 'tronfire',
    TRONFIRE_POSTGRES_USER: process.env.TRONFIRE_POSTGRES_USER || 'tronfire'
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
    const deferred = code === 12;
    job.status = code === 0 || deferred ? 'success' : 'failed';
    job.finishedAt = new Date().toISOString();
    appendEvent(code === 0 ? 'HA_SYNC_FINISHED' : deferred ? 'HA_SYNC_DEFERRED' : 'HA_SYNC_FAILED', { standbyHost: settings.standbyHost, exitCode: code, stdout: job.stdout, stderr: job.stderr });
  });
  appendEvent('HA_SYNC_STARTED', { standbyHost: settings.standbyHost, sshUser: settings.sshUser, sshPort: settings.sshPort, syncMode: settings.syncMode });
  return publicActionJob(job);
}

function shouldRunAutoHaSync(settings) {
  if (!settings.enabled || !settings.autoEnabled || !settings.standbyHost) return false;
  if (!settings.sshValidated) return false;
  const identity = nodeIdentity();
  if (identity.deploymentMode === 'ha' && clusterGuard().canServeProduction !== true) return false;
  const runningJob = [...actionJobs.values()].reverse().find(job => job.app === 'ha-sync' && job.status === 'running');
  if (runningJob) return false;
  const intervalMs = FIXED_HA_SYNC_INTERVAL_MINUTES * 60 * 1000;
  const lastEvent = readEvents(200).find(event => ['HA_SYNC_STARTED', 'HA_SYNC_FINISHED', 'HA_SYNC_FAILED', 'HA_SYNC_DEFERRED'].includes(event.type)) || null;
  const lastEventAt = lastEvent?.createdAt ? new Date(lastEvent.createdAt).getTime() : 0;
  const lastRunAt = Math.max(lastEventAt || 0, lastAutoHaSyncStartedAt || 0);
  return !lastRunAt || Date.now() - lastRunAt >= intervalMs;
}

function startHaSyncScheduler() {
  if (haSyncSchedulerTimer) return;
  const tick = async () => {
    if (haSyncSchedulerBusy) return;
    haSyncSchedulerBusy = true;
    try {
      let settings = publicHaSyncSettings();
      const identity = nodeIdentity();
      if (!settings.enabled || !settings.autoEnabled || !settings.standbyHost) return;
      if (identity.deploymentMode === 'ha' && clusterGuard().canServeProduction !== true) return;
      if (!settings.sshValidated) {
        await testHaSyncSsh(settings);
        settings = publicHaSyncSettings();
      }
      if (!shouldRunAutoHaSync(settings)) return;
      lastAutoHaSyncStartedAt = Date.now();
      appendEvent('HA_SYNC_AUTO_TRIGGERED', { standbyHost: settings.standbyHost, intervalMinutes: settings.intervalMinutes, syncMode: settings.syncMode });
      startHaSync();
    } catch (err) {
      appendEvent('HA_SYNC_AUTO_SKIPPED', { error: err.message });
    } finally {
      haSyncSchedulerBusy = false;
    }
  };
  haSyncSchedulerTimer = setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000).unref?.();
  if (typeof haSyncSchedulerTimer.unref === 'function') haSyncSchedulerTimer.unref();
}

async function primaryHealthOk(url) {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function maybeAutoFailover() {
  const identity = nodeIdentity();
  const settings = publicHaFailoverSettings();
  if (identity.deploymentMode !== 'ha' || identity.nodeRole !== 'standby' || !settings.primaryHealthUrl) {
    primaryDownSince = 0;
    return;
  }

  const primaryOk = await primaryHealthOk(settings.primaryHealthUrl);
  if (primaryOk) {
    if (primaryDownSince) appendEvent('HA_FAILOVER_PRIMARY_RECOVERED', { primaryHealthUrl: settings.primaryHealthUrl });
    primaryDownSince = 0;
    return;
  }

  const maintenanceBlock = failoverMaintenanceBlock();
  if (maintenanceBlock.active) {
    if (!primaryDownSince) {
      primaryDownSince = Date.now();
      appendEvent('HA_FAILOVER_BLOCKED_BY_MAINTENANCE', { primaryHealthUrl: settings.primaryHealthUrl, maintenance: maintenanceBlock });
    }
    return;
  }

  if (!primaryDownSince) {
    primaryDownSince = Date.now();
    appendEvent('HA_FAILOVER_PRIMARY_DOWN_DETECTED', { primaryHealthUrl: settings.primaryHealthUrl, timeoutSeconds: settings.timeoutSeconds });
    return;
  }

  const elapsedSeconds = Math.floor((Date.now() - primaryDownSince) / 1000);
  if (elapsedSeconds < settings.timeoutSeconds || autoFailoverInProgress) return;
  if (!settings.enabled) return;

  const localTronfireHa = await tronfireHaStatus();
  if (!localTronfireHa?.allReady) {
    appendEvent('HA_FAILOVER_AUTO_BLOCKED', { reason: 'standby nao esta READY', elapsedSeconds, tronfireHa: localTronfireHa });
    return;
  }

  try {
    autoFailoverInProgress = true;
    const currentLock = clusterLock();
    const lock = writeClusterLock({
      ...currentLock,
      cluster: identity.clusterId,
      active_node: String(currentLock.active_node || 'primary-offline'),
      this_node: identity.nodeName,
      allow_promotion: true,
      reason: `failover automatico: primary indisponivel por ${elapsedSeconds}s`
    });
    appendEvent('HA_FAILOVER_AUTO_PROMOTING', { elapsedSeconds, lock });
    await activateLocalNode({ reason: `failover automatico: primary indisponivel por ${elapsedSeconds}s` });
    primaryDownSince = 0;
    appendEvent('HA_FAILOVER_AUTO_PROMOTED', { elapsedSeconds });
  } catch (err) {
    appendEvent('HA_FAILOVER_AUTO_FAILED', { error: err.message, elapsedSeconds });
  } finally {
    autoFailoverInProgress = false;
  }
}

function startHaFailoverWatchdog() {
  if (haFailoverWatchdogTimer) return;
  haFailoverWatchdogTimer = setInterval(() => {
    maybeAutoFailover().catch(err => appendEvent('HA_FAILOVER_WATCHDOG_ERROR', { error: err.message }));
  }, Math.max(publicHaFailoverSettings().checkIntervalSeconds, 2) * 1000);
  if (typeof haFailoverWatchdogTimer.unref === 'function') haFailoverWatchdogTimer.unref();
}

function restartHaFailoverWatchdog() {
  if (haFailoverWatchdogTimer) clearInterval(haFailoverWatchdogTimer);
  haFailoverWatchdogTimer = null;
  startHaFailoverWatchdog();
}

function persistUpdateJob(job, message = '') {
  if (job.app !== 'tronsoftos' || !String(job.action || '').startsWith('update-')) return;
  writeUpdateStatus({
    id: job.id,
    app: job.app,
    action: job.action,
    branch: String(job.action || '').replace(/^update-/, '') || 'main',
    command: job.command,
    args: job.args,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    message: message || (job.status === 'success' ? 'Atualizacao concluida com sucesso.' : job.error || 'Atualizacao em andamento.'),
    stdout: job.stdout,
    stderr: job.stderr
  });
}

function startCommandJob({ id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`, app, action, command, args, env = process.env, cwd = appRoot, eventPrefix = 'MAINTENANCE', timeoutMs = 0 }) {
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
  persistUpdateJob(job);
  const child = spawn(command, args, { cwd, env, windowsHide: true });
  let timedOut = false;
  let timeoutTimer = null;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      job.status = 'failed';
      job.error = `tempo limite excedido apos ${Math.round(timeoutMs / 60000)} minuto(s)`;
      job.finishedAt = new Date().toISOString();
      appendActionLog(job, 'stderr', `\n[tronsoftos] ${job.error}; encerrando processo de atualizacao.\n`);
      persistUpdateJob(job, job.error);
      appendEvent(`${eventPrefix}_${action.toUpperCase()}_TIMEOUT`, { app, timeoutMs });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000).unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }
  child.stdout.on('data', chunk => appendActionLog(job, 'stdout', chunk));
  child.stderr.on('data', chunk => appendActionLog(job, 'stderr', chunk));
  child.on('error', err => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    persistUpdateJob(job, err.message);
    appendEvent(`${eventPrefix}_${action.toUpperCase()}_FAILED`, { app, error: err.message });
  });
  child.on('close', code => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    job.exitCode = code;
    if (!timedOut) {
      job.status = code === 0 ? 'success' : 'failed';
      job.finishedAt = new Date().toISOString();
    }
    persistUpdateJob(job, job.status === 'success' ? 'Atualizacao concluida com sucesso.' : 'Atualizacao falhou.');
    appendEvent(`${eventPrefix}_${action.toUpperCase()}`, { app, exitCode: code, stdout: job.stdout, stderr: job.stderr });
  });
  return publicActionJob(job);
}

function privilegedCommandArgs(command, args, options = {}) {
  if (process.getuid && process.getuid() !== 0) {
    return { command: 'sudo', args: options.preserveEnv ? ['-E', command, ...args] : [command, ...args] };
  }
  return { command, args };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stripTerminalNoise(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/No entry for terminal type "unknown"|using dumb terminal settings/i.test(line))
    .join('\n')
    .trim();
}

function formatIsoForAlert(value) {
  if (!value) return 'horario nao informado';
  try {
    return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return String(value);
  }
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
    expiresAt: null,
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

function maintenanceExpiresAt(timeoutMinutes = UPDATE_MAINTENANCE_TIMEOUT_MINUTES) {
  return new Date(Date.now() + Math.max(1, Number(timeoutMinutes || UPDATE_MAINTENANCE_TIMEOUT_MINUTES)) * 60_000).toISOString();
}

function failoverMaintenanceBlock() {
  const state = maintenanceState();
  const mode = String(state.mode || '');
  const active = state.active === true && ['failover-update', 'update', 'ha-update', 'failback'].includes(mode);
  if (!active) return { active: false };
  const expiresAtMs = state.expiresAt ? new Date(state.expiresAt).getTime() : 0;
  const expired = expiresAtMs > 0 && Date.now() > expiresAtMs;
  return {
    active: true,
    expired,
    reason: state.reason || 'manutencao planejada',
    startedAt: state.startedAt || null,
    expiresAt: state.expiresAt || null,
    remainingSeconds: expiresAtMs ? Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)) : null
  };
}

function writeFailoverMaintenanceBlock(body = {}) {
  if (nodeIdentity().deploymentMode !== 'ha') {
    return clearFailoverMaintenanceBlock({ reason: 'Servidor solo: failover HA desativado' });
  }
  const timeoutMinutes = Number(body.timeoutMinutes || UPDATE_MAINTENANCE_TIMEOUT_MINUTES);
  return writeMaintenanceState({
    active: true,
    mode: 'failover-update',
    reason: String(body.reason || 'Atualizacao planejada do primary: failover automatico suspenso').trim(),
    standbyHost: body.primaryHost ? String(body.primaryHost).trim() : null,
    startedAt: new Date().toISOString(),
    expiresAt: body.expiresAt || maintenanceExpiresAt(timeoutMinutes),
    clearedAt: null
  });
}

function clearFailoverMaintenanceBlock(body = {}) {
  return writeMaintenanceState({
    active: false,
    mode: 'failover-update',
    reason: String(body.reason || 'Atualizacao planejada finalizada: failover automatico liberado').trim(),
    clearedAt: new Date().toISOString()
  });
}

function assertHostLabel(value, label) {
  const host = String(value || '').trim();
  if (!host) throw new Error(`${label} obrigatorio`);
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(host)) throw new Error(`${label} invalido`);
  return host;
}

function failbackStrategyInfo(strategy) {
  return {
    sync_from_active: {
      label: 'Sincronizar a partir do no ativo atual',
      productionLocked: true,
      recommended: true,
      description: 'Usa quem esta respondendo pelo VIP agora como fonte da verdade antes de liberar producao.'
    },
    manual_database: {
      label: 'Preparar failback e aguardar banco manual',
      productionLocked: true,
      recommended: false,
      description: 'Organiza o HA em modo protegido. O tecnico sobe/restaura o banco e depois executa validacao final.'
    },
    force_selected_database: {
      label: 'Usar banco atual do servidor escolhido',
      productionLocked: false,
      recommended: false,
      dangerous: true,
      description: 'Avancado. Assume que o banco ja presente no servidor escolhido e o correto.'
    }
  }[strategy] || null;
}

async function failbackStatus() {
  const cluster = clusterStatus();
  cluster.vipStatus = await vipStatus(cluster);
  const network = await hostNetworkStatus();
  const currentInterface = network.defaultInterface || network.interfaces?.[0]?.name || null;
  const currentAddress = network.interfaces
    ?.find(item => item.name === currentInterface)?.addresses?.[0]
    || network.interfaces?.[0]?.addresses?.[0]
    || null;
  const sync = publicHaSyncSettings();
  return {
    generatedAt: new Date().toISOString(),
    cluster,
    guard: clusterGuard(),
    maintenance: maintenanceState(),
    sync,
    local: {
      nodeName: cluster.nodeName,
      nodeRole: cluster.nodeRole,
      address: currentAddress?.address || null,
      cidr: currentAddress?.cidr || null,
      interface: currentInterface
    },
    remote: {
      address: sync.standbyHost || null,
      sshUser: sync.sshUser || 'tronsoft',
      sshPort: sync.sshPort || 22
    },
    strategies: ['sync_from_active', 'manual_database', 'force_selected_database'].map(id => ({ id, ...failbackStrategyInfo(id) }))
  };
}

async function prepareFailback(body = {}) {
  const strategy = String(body.strategy || '').trim();
  const strategyInfo = failbackStrategyInfo(strategy);
  if (!strategyInfo) throw new Error('estrategia de banco invalida');
  const confirmation = strategy === 'force_selected_database'
    ? 'USAR BANCO DO SERVIDOR ESCOLHIDO'
    : 'PREPARAR FAILBACK';
  requireConfirmation(body, confirmation);

  const desiredPrimaryHost = assertHostLabel(body.desiredPrimaryHost, 'primary desejado');
  const desiredStandbyHost = assertHostLabel(body.desiredStandbyHost, 'standby desejado');
  if (desiredPrimaryHost === desiredStandbyHost) throw new Error('primary e standby desejados devem ser diferentes');

  const status = await failbackStatus();
  const vipHolder = status.cluster.vipStatus?.holder || null;
  const state = writeMaintenanceState({
    active: true,
    mode: 'failback',
    reason: `Failback preparado: ${desiredPrimaryHost} sera primary; estrategia ${strategy}`,
    standbyHost: desiredStandbyHost,
    startedAt: new Date().toISOString(),
    expiresAt: maintenanceExpiresAt(Number(body.timeoutMinutes || 240)),
    clearedAt: null,
    failback: {
      desiredPrimaryHost,
      desiredStandbyHost,
      strategy,
      strategyLabel: strategyInfo.label,
      productionLocked: strategyInfo.productionLocked !== false,
      vip: status.cluster.vip || null,
      vipHolder,
      preparedBy: 'tronsoftos',
      requiresDatabaseValidation: strategy !== 'force_selected_database',
      nextSteps: strategy === 'manual_database'
        ? ['Subir/restaurar o banco manualmente no primary desejado.', 'Executar validacao final do banco.', 'Liberar producao somente apos health e banco OK.']
        : strategy === 'sync_from_active'
        ? ['Sincronizar dados do no ativo atual para o primary desejado.', 'Validar banco no destino.', 'Mover/liberar VIP no primary desejado.']
        : ['Confirmar auditoria de uso do banco atual.', 'Mover/liberar VIP no primary desejado.', 'Ressincronizar o outro no como standby.']
    }
  });
  const lock = blockClusterPromotion(`Failback em preparacao para ${desiredPrimaryHost}; producao ${strategyInfo.productionLocked === false ? 'pode ser liberada apos confirmacao avancada' : 'bloqueada ate validacao'}`);
  appendEvent('HA_FAILBACK_PREPARED', {
    desiredPrimaryHost,
    desiredStandbyHost,
    strategy,
    vip: status.cluster.vip || null,
    vipHolder
  });
  return { ok: true, state, lock, status: await failbackStatus() };
}

async function maintenanceStatus() {
  let localKeepalived = 'unknown';
  try {
    const { stdout } = await run('systemctl', ['is-active', 'keepalived.service'], { timeout: 5000 });
    localKeepalived = stdout.trim() || 'unknown';
  } catch (err) {
    localKeepalived = String(err.stdout || err.message || 'unknown').trim();
  }
  const cluster = clusterStatus();
  cluster.vipStatus = await vipStatus(cluster);
  return {
    generatedAt: new Date().toISOString(),
    cluster,
    maintenance: maintenanceState(),
    failoverMaintenance: failoverMaintenanceBlock(),
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
  if (nodeIdentity().deploymentMode !== 'ha') throw new Error('failover standby indisponivel em servidor solo');
  const settings = rawHaSyncSettings();
  if (!settings.standbyHost) throw new Error('host standby nao configurado no Sync HA');
  const sshUser = settings.sshUser || 'tronsoft';
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

function startTronsoftosUpdate(body = {}) {
  const branch = String(body.branch || 'main').trim();
  if (!UPDATE_ALLOWED_BRANCHES.has(branch)) throw new Error(`branch nao permitida para atualizacao pelo painel: ${branch}`);
  requireConfirmation(body, `ATUALIZAR ${branch.toUpperCase()}`);
  const identity = nodeIdentity();
  const settings = rawHaSyncSettings();
  const timeoutMinutes = Number(body.timeoutMinutes || UPDATE_MAINTENANCE_TIMEOUT_MINUTES);
  const script = path.join(appRoot, 'scripts/update-tronsoftos.sh');
  if (!fs.existsSync(script)) throw new Error(`script de atualizacao nao encontrado: ${script}`);

  if (identity.deploymentMode === 'ha') {
    writeMaintenanceState({
      active: true,
      mode: 'update',
      reason: `Atualizacao planejada para branch ${branch}`,
      standbyHost: identity.nodeRole === 'primary' ? settings.standbyHost || null : null,
      startedAt: new Date().toISOString(),
      expiresAt: maintenanceExpiresAt(timeoutMinutes),
      clearedAt: null
    });
  }

  const cmd = privilegedCommandArgs('/usr/bin/bash', [script, branch], { preserveEnv: true });
  const updateJobId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const env = {
    ...process.env,
    TRONSOFTOS_APP_DIR: appRoot,
    TRONSOFTOS_UPDATE_JOB_ID: updateJobId,
    TRONSOFTOS_UPDATE_STATUS: updateStatusPath,
    TRONSOFTOS_UPDATE_TIMEOUT_MINUTES: String(timeoutMinutes),
    TRONSOFTOS_UPDATE_STANDBY_HOST: identity.deploymentMode === 'ha' && identity.nodeRole === 'primary' ? settings.standbyHost || '' : '',
    TRONSOFTOS_UPDATE_SSH_USER: settings.sshUser || 'tronsoft',
    TRONSOFTOS_UPDATE_SSH_PORT: String(settings.sshPort || 22),
    TRONSOFTOS_UPDATE_SSH_KEY: path.join(stateDir, 'ssh/id_ed25519'),
    TRONSOFTOS_UPDATE_KNOWN_HOSTS: path.join(stateDir, 'known_hosts'),
    TRONSOFTOS_INTERNAL_TOKEN: internalTokenValue(),
    TRONSOFTOS_MAINTENANCE_STATE: maintenanceStatePath,
    TRONSOFTOS_PORT: String(port)
  };
  appendEvent('TRONSOFTOS_UPDATE_STARTED', { branch, nodeRole: identity.nodeRole, standbyHost: env.TRONSOFTOS_UPDATE_STANDBY_HOST || null });
  return startCommandJob({
    id: updateJobId,
    app: 'tronsoftos',
    action: `update-${branch}`,
    ...cmd,
    env,
    eventPrefix: 'TRONSOFTOS_UPDATE',
    timeoutMs: Math.max(timeoutMinutes, 1) * 60 * 1000
  });
}

function startHostPower(action, body = {}) {
  if (!['reboot', 'poweroff'].includes(action)) throw new Error('acao de energia invalida');
  requireConfirmation(body, action === 'reboot' ? 'REINICIAR HOST' : 'DESLIGAR HOST');
  const identity = nodeIdentity();
  const settings = rawHaSyncSettings();
  const cmd = privilegedCommandArgs('/usr/local/sbin/tronsoftos-network', ['host-power', action]);
  if (identity.deploymentMode === 'ha' && (identity.nodeRole || 'primary') === 'primary' && settings.standbyHost) {
    const sshUser = settings.sshUser || 'tronsoft';
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

function centralEnabled() {
  const settings = centralSettings();
  return (settings.enabled === true || String(process.env.TRONSOFTOS_CENTRAL_ENABLED || '').toLowerCase() === 'true')
    && Boolean(centralBaseUrl());
}

function centralBaseUrl() {
  const settings = centralSettings();
  return String(settings.url || process.env.TRONSOFTOS_CENTRAL_URL || 'https://central.tronsoft.app.br').trim().replace(/\/+$/, '');
}

function centralHeartbeatMs() {
  const seconds = Number(process.env.TRONSOFTOS_CENTRAL_HEARTBEAT_SECONDS || 120);
  return Math.max(60, seconds || 120) * 1000;
}

function centralInstallationId() {
  const identity = nodeIdentity();
  return process.env.TRONSOFTOS_CENTRAL_INSTALLATION_ID
    || identity.installId
    || `${identity.clusterId}-${identity.nodeName}`;
}

function centralEnvironmentName() {
  const identity = nodeIdentity();
  return process.env.TRONSOFTOS_CENTRAL_ENVIRONMENT_NAME
    || `${identity.clusterId} / ${identity.nodeName}`;
}

function centralSettings() {
  const saved = readJson(centralSettingsPath, {});
  return {
    enabled: saved.enabled === true || String(process.env.TRONSOFTOS_CENTRAL_ENABLED || '').toLowerCase() === 'true',
    url: saved.url || process.env.TRONSOFTOS_CENTRAL_URL || 'https://central.tronsoft.app.br',
    pairedAt: saved.pairedAt || null,
    installationId: saved.installationId || null,
    clientId: saved.clientId || null,
    lastValidationAt: saved.lastValidationAt || null
  };
}

function publicCentralSettings() {
  const settings = centralSettings();
  return {
    ...settings,
    tokenConfigured: Boolean(centralToken())
  };
}

function writeCentralSettings(next) {
  ensureStateDir();
  const current = centralSettings();
  const settings = {
    ...current,
    ...next,
    url: String(next.url || current.url || 'https://central.tronsoft.app.br').trim().replace(/\/+$/, '')
  };
  fs.writeFileSync(centralSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

function centralCustomerPayload() {
  const identity = nodeIdentity();
  return {
    name: process.env.TRONSOFTOS_CENTRAL_CUSTOMER_NAME || process.env.CUSTOMER_NAME || identity.clusterId || 'Cliente TronSoftOS',
    document: process.env.TRONSOFTOS_CENTRAL_CUSTOMER_DOCUMENT || process.env.CUSTOMER_DOCUMENT || '',
    city: process.env.TRONSOFTOS_CENTRAL_CUSTOMER_CITY || '',
    state: process.env.TRONSOFTOS_CENTRAL_CUSTOMER_STATE || ''
  };
}

function centralResellerPayload() {
  return {
    name: process.env.TRONSOFTOS_CENTRAL_RESELLER_NAME || 'TronSoftOS Direto',
    document: process.env.TRONSOFTOS_CENTRAL_RESELLER_DOCUMENT || ''
  };
}

function primaryHostIp() {
  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

async function centralDatabaseInfoFromTronFire() {
  if (centralDatabaseInfoCache.value && Date.now() - centralDatabaseInfoCache.checkedAt < 60 * 1000) {
    return centralDatabaseInfoCache.value;
  }
  const token = internalTokenValue();
  if (!token) return null;
  try {
    const target = tronfireProxyTarget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(new URL('/api/internal/database-version', target), {
      signal: controller.signal,
      headers: { 'x-tronsoftos-token': token }
    });
    clearTimeout(timeout);
    if (!response.ok) return centralDatabaseInfoCache.value || null;
    const payload = await response.json();
    const databases = Array.isArray(payload.databases)
      ? payload.databases.map(db => ({
          id: db.id || null,
          name: db.name || db.databaseName || null,
          alias: db.alias || db.databaseAlias || null,
          databaseName: db.databaseName || db.name || null,
          databaseAlias: db.databaseAlias || db.alias || null,
          pathRole: db.pathRole || null,
          ok: db.ok !== false,
          version: String(db.version || db.schemaVersion || db.versaoBanco || '').trim(),
          schemaVersion: String(db.schemaVersion || db.versaoBanco || db.version || '').trim(),
          versaoBanco: String(db.versaoBanco || db.schemaVersion || db.version || '').trim(),
          licensedUnit: db.licensedUnit || null,
          fileSizeBytes: db.fileSizeBytes ?? null,
          sizeMb: db.sizeMb ?? null,
          error: db.error || '',
          indexHealth: db.indexHealth || null,
          indexAudit: db.indexAudit || null
        }))
      : [];
    const value = {
      version: String(payload.version || '').trim(),
      databaseName: payload.databaseName || null,
      databaseAlias: payload.databaseAlias || null,
      fileSizeBytes: payload.fileSizeBytes ?? null,
      sizeMb: payload.sizeMb ?? null,
      indexHealth: payload.indexHealth || null,
      indexAudit: payload.indexAudit || null,
      databases
    };
    if (value.version || value.fileSizeBytes || value.indexHealth || value.indexAudit || value.databases.length) {
      centralDatabaseInfoCache = { checkedAt: Date.now(), value };
    }
    return value;
  } catch {
    return centralDatabaseInfoCache.value || null;
  }
}

async function centralDatabasePayload() {
  const tronfireEnv = parseEnvFile(path.join(appRoot, 'apps/tronfire/.env'));
  const tronfireDatabase = await centralDatabaseInfoFromTronFire();
  const versaoBanco = tronfireDatabase?.version
    || process.env.TRONSOFTOS_CENTRAL_DATABASE_VERSAO_BANCO
    || process.env.TRONSOFTOS_CENTRAL_DATABASE_VERSION_LABEL
    || tronfireEnv.VERSAO_BANCO
    || tronfireEnv.versao_banco
    || process.env.TRONSOFTOS_CENTRAL_DATABASE_SCHEMA_VERSION
    || tronfireEnv.TRONFIRE_SCHEMA_VERSION
    || '';
  return {
    engine: process.env.TRONSOFTOS_CENTRAL_DATABASE_ENGINE || tronfireEnv.FIREBIRD_ENGINE || 'Firebird',
    version: process.env.TRONSOFTOS_CENTRAL_DATABASE_VERSION || tronfireEnv.FIREBIRD_VERSION || '2.5',
    schemaVersion: versaoBanco,
    versaoBanco,
    versao_banco: versaoBanco,
    sizeMb: tronfireDatabase?.sizeMb ?? null,
    fileSizeBytes: tronfireDatabase?.fileSizeBytes ?? null,
    databaseName: tronfireDatabase?.databaseName || null,
    databaseAlias: tronfireDatabase?.databaseAlias || null,
    indexHealth: tronfireDatabase?.indexHealth || null,
    indexAudit: tronfireDatabase?.indexAudit || null,
    databases: Array.isArray(tronfireDatabase?.databases) ? tronfireDatabase.databases : []
  };
}

function centralHostPayload() {
  const cpus = os.cpus() || [];
  const cpuModel = cpus.find(cpu => cpu?.model)?.model || '';
  return {
    hostname: os.hostname(),
    serverTime: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || '',
    os: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    ip: primaryHostIp(),
    cpuModel,
    cpuName: cpuModel,
    cpuCores: cpus.length || null,
    processorCount: cpus.length || null,
    memoryTotalBytes: os.totalmem(),
    ramTotalBytes: os.totalmem()
  };
}

function centralToken() {
  try {
    return fs.readFileSync(centralTokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeCentralToken(token) {
  if (!token) return;
  ensureStateDir();
  fs.writeFileSync(centralTokenPath, `${token}\n`, { mode: 0o600 });
}

async function centralRequest(pathname, { method = 'GET', token = '', body = null } = {}) {
  const response = await fetch(`${centralBaseUrl()}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-installation-token': token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Central HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function requireCentralInstallationToken() {
  const token = centralToken();
  if (!token) {
    const error = new Error('TronSoftOS ainda nao esta pareado com a Central.');
    error.statusCode = 400;
    throw error;
  }
  return token;
}

async function centralGoogleStatus() {
  const token = requireCentralInstallationToken();
  return centralRequest('/api/tronsoftos/oauth/google/status', { token });
}

async function centralGoogleStart(body = {}) {
  const token = requireCentralInstallationToken();
  const settings = rawRcloneSettings();
  const payload = {
    remote: normalizeRemoteName(body.remote || settings.remote || 'gdrive'),
    path: String(body.path || settings.path || 'tronsoftos/backups').trim() || 'tronsoftos/backups'
  };
  const result = await centralRequest('/api/tronsoftos/oauth/google/start', {
    method: 'POST',
    token,
    body: payload
  });
  appendEvent('CENTRAL_GOOGLE_OAUTH_STARTED', { remote: payload.remote, path: payload.path });
  return result;
}

async function centralGoogleApply(body = {}) {
  const token = requireCentralInstallationToken();
  const current = rawRcloneSettings();
  const payload = await centralRequest('/api/tronsoftos/oauth/google/token', {
    method: 'POST',
    token
  });
  const rclone = payload.rclone || {};
  if (!rclone.configContent) {
    throw new Error('Central nao retornou configuracao do Google Drive.');
  }

  const result = writeRcloneSettings({
    enabled: true,
    bin: body.bin || current.bin || '/usr/bin/rclone',
    config: body.config || current.config || defaultRcloneConfigPath(),
    remote: rclone.remote || body.remote || current.remote || 'gdrive',
    path: rclone.path || body.path || current.path || 'tronsoftos/backups',
    uploadOnlyRole: body.uploadOnlyRole || current.uploadOnlyRole || 'primary',
    bind: body.bind || current.bind || '0.0.0.0',
    remoteRetentionDays: body.remoteRetentionDays || current.remoteRetentionDays || 30,
    accountEmail: payload.account?.accountEmail || payload.accountEmail || current.accountEmail || '',
    configContent: rclone.configContent
  });
  appendEvent('CENTRAL_GOOGLE_OAUTH_APPLIED', {
    accountEmail: payload.account?.accountEmail || payload.accountEmail || '',
    remote: result.remote,
    path: result.path
  });
  return {
    ...result,
    account: payload.account || null,
    accountEmail: payload.account?.accountEmail || payload.accountEmail || result.accountEmail || '',
    message: 'Google Drive autenticado pela Central e configuracao aplicada.'
  };
}

async function centralPair(pairingToken, url = '') {
  if (!pairingToken) throw new Error('Token da Central obrigatorio');
  const settings = writeCentralSettings({ enabled: false, url: url || centralBaseUrl() });
  const payload = await centralRequest('/api/tronsoftos/pair', {
    method: 'POST',
    body: {
      ...await centralIdentifyPayload(),
      pairingToken
    }
  });
  writeCentralToken(payload.installationToken);
  const next = writeCentralSettings({
    enabled: true,
    url: settings.url,
    pairedAt: new Date().toISOString(),
    lastValidationAt: new Date().toISOString(),
    installationId: payload.installationId,
    clientId: payload.clientId
  });
  appendEvent('CENTRAL_TOKEN_VALIDATED', {
    centralUrl: next.url,
    installationId: payload.installationId,
    clientId: payload.clientId
  });
  if (!centralAgentTimer) startCentralAgent();
  else centralAgentTick();
  return {
    ...publicCentralSettings(),
    message: payload.message || 'Central validada com sucesso.'
  };
}

async function centralIdentifyPayload() {
  const build = buildInfo();
  const identity = nodeIdentity();
  return {
    installationId: centralInstallationId(),
    reseller: centralResellerPayload(),
    customer: centralCustomerPayload(),
    environment: {
      name: centralEnvironmentName(),
      mode: identity.deploymentMode,
      nodeRole: identity.nodeRole
    },
    tronsoftos: {
      version: build.version,
      build: build.buildNumber ? String(build.buildNumber) : build.commit,
      channel: build.branch
    },
    database: await centralDatabasePayload(),
    host: centralHostPayload(),
    status: 'online'
  };
}

async function centralIdentify() {
  const payload = await centralRequest('/api/tronsoftos/identify', {
    method: 'POST',
    body: await centralIdentifyPayload()
  });
  writeCentralToken(payload.installationToken);
  appendEvent('CENTRAL_IDENTIFIED', {
    centralUrl: centralBaseUrl(),
    installationId: payload.installationId,
    clientId: payload.clientId,
    resellerId: payload.resellerId
  });
  return payload.installationToken;
}

function centralStatusFromDashboard(payload) {
  if (payload.apps?.some(app => app.status === 'offline' && app.enabled !== false)) return 'offline';
  if (payload.alerts?.some(alert => String(alert.severity || '').toLowerCase() === 'critical')) return 'warning';
  if (payload.alerts?.some(alert => String(alert.severity || '').toLowerCase() === 'warning')) return 'warning';
  return 'online';
}

function centralSystemMetricsPayload(payload = {}) {
  const metrics = payload.systemMetrics && typeof payload.systemMetrics === 'object' ? payload.systemMetrics : {};
  const latestRows = Array.isArray(metrics.latest) ? metrics.latest : (metrics.latest ? [metrics.latest] : []);
  const latestHost = latestRows.find(row => row && row.scope === 'HOST' && row.target) || latestRows[0] || null;
  const latest = latestHost && typeof latestHost === 'object'
    ? {
        ...latestHost,
        collectedAt: latestHost.collectedAt || latestHost.createdAt || metrics.collectedAt || new Date().toISOString()
      }
    : null;
  const series = Array.isArray(metrics.series)
    ? metrics.series
        .filter(row => row && (!row.scope || row.scope === 'HOST'))
        .map(row => ({
          ...row,
          collectedAt: row.collectedAt || row.createdAt || metrics.collectedAt || new Date().toISOString()
        }))
        .slice(-288)
    : [];
  return {
    ...metrics,
    ...(latest ? { latest } : {}),
    ...(series.length ? { series } : {})
  };
}

function centralFirebirdMetricsPayload(payload = {}) {
  const metrics = payload.systemMetrics && typeof payload.systemMetrics === 'object' ? payload.systemMetrics : {};
  const latestRows = Array.isArray(metrics.latest) ? metrics.latest : (metrics.latest ? [metrics.latest] : []);
  const latestFirebird = latestRows.find(row => row && row.scope === 'FIREBIRD') || null;
  const uptime = latestRows.find(row => row && row.target === 'firebird_uptime') || null;
  const series = Array.isArray(metrics.series)
    ? metrics.series
        .filter(row => row && row.scope === 'FIREBIRD')
        .map(row => ({
          ...row,
          collectedAt: row.collectedAt || row.createdAt || metrics.collectedAt || new Date().toISOString()
        }))
        .slice(-288)
    : [];
  if (!latestFirebird && !series.length && !uptime) return null;
  return {
    latest: latestFirebird
      ? {
          ...latestFirebird,
          collectedAt: latestFirebird.collectedAt || latestFirebird.createdAt || metrics.collectedAt || new Date().toISOString()
        }
      : null,
    uptimeSeconds: uptime?.uptimeSeconds ?? null,
    series
  };
}

function readInterfaceCounters(interfaceName = '') {
  const safeName = String(interfaceName || '').replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safeName) return null;
  const basePath = path.join('/sys/class/net', safeName);
  const readNumber = (fileName) => {
    try {
      const value = Number(fs.readFileSync(path.join(basePath, 'statistics', fileName), 'utf8').trim());
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const readSpeed = () => {
    try {
      const value = Number(fs.readFileSync(path.join(basePath, 'speed'), 'utf8').trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  };
  return {
    interface: safeName,
    rxBytes: readNumber('rx_bytes'),
    txBytes: readNumber('tx_bytes'),
    rxErrors: readNumber('rx_errors'),
    txErrors: readNumber('tx_errors'),
    rxDropped: readNumber('rx_dropped'),
    txDropped: readNumber('tx_dropped'),
    linkSpeedMbps: readSpeed()
  };
}

function counterRate(after = {}, before = {}, key = '', seconds = 1) {
  const delta = Number(after[key]) - Number(before[key]);
  return Number.isFinite(delta) && delta >= 0 ? delta / Math.max(seconds, 0.001) : 0;
}

function parsePingSummary(stdout = '') {
  const loss = stdout.match(/(\d+(?:[.,]\d+)?)%\s*packet loss/i);
  const rtt = stdout.match(/(?:rtt|round-trip).*?=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/i);
  return {
    packetLossPercent: loss ? Number(loss[1].replace(',', '.')) : null,
    latencyMs: rtt ? Number(rtt[2]) : null,
    jitterMs: rtt ? Number(rtt[4]) : null
  };
}

async function pingProbe(target = '') {
  const host = String(target || '').trim();
  if (!host || !(await commandExists('ping'))) return null;
  try {
    const out = await run('ping', ['-c', '3', '-W', '2', host], { timeout: 8000, maxBuffer: 1024 * 64 });
    return { target: host, reachable: true, ...parsePingSummary(out.stdout) };
  } catch (err) {
    return { target: host, reachable: false, ...parsePingSummary(`${err.stdout || ''}\n${err.stderr || ''}`) };
  }
}

async function dnsProbe(hostname = '') {
  const target = String(hostname || '').trim();
  if (!target) return null;
  const startedAt = Date.now();
  try {
    await Promise.race([
      dns.lookup(target),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    return { ok: true, dnsLatencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, dnsLatencyMs: Date.now() - startedAt };
  }
}

async function centralNetworkMetricsPayload() {
  const collectedAt = new Date().toISOString();
  const network = await hostNetworkStatus().catch(() => ({}));
  const interfaceName = network.defaultInterface || network.interfaces?.find(item => item.name && item.name !== 'lo')?.name || null;
  const before = readInterfaceCounters(interfaceName);
  await delay(1000);
  const after = readInterfaceCounters(interfaceName);
  const sampleSeconds = 1;
  const centralHost = (() => {
    try {
      return new URL(centralBaseUrl()).hostname;
    } catch {
      return '';
    }
  })();
  const internetProbeTarget = process.env.TRONSOFTOS_NETWORK_PROBE_HOST || '1.1.1.1';
  const [gatewayProbe, internetProbe, centralProbe, dnsResult] = await Promise.all([
    network.gateway ? pingProbe(network.gateway) : Promise.resolve(null),
    pingProbe(internetProbeTarget),
    centralHost ? pingProbe(centralHost) : Promise.resolve(null),
    dnsProbe(centralHost || 'central.tronsoft.app.br')
  ]);
  const rxBytesPerSecond = before && after ? counterRate(after, before, 'rxBytes', sampleSeconds) : null;
  const txBytesPerSecond = before && after ? counterRate(after, before, 'txBytes', sampleSeconds) : null;
  const rxErrorsPerSecond = before && after ? counterRate(after, before, 'rxErrors', sampleSeconds) : null;
  const txErrorsPerSecond = before && after ? counterRate(after, before, 'txErrors', sampleSeconds) : null;
  const rxDroppedPerSecond = before && after ? counterRate(after, before, 'rxDropped', sampleSeconds) : null;
  const txDroppedPerSecond = before && after ? counterRate(after, before, 'txDropped', sampleSeconds) : null;
  const linkSpeedMbps = after?.linkSpeedMbps || before?.linkSpeedMbps || null;
  const linkUtilizationPercent = linkSpeedMbps && rxBytesPerSecond !== null && txBytesPerSecond !== null
    ? Math.min(100, ((rxBytesPerSecond + txBytesPerSecond) * 8 / (linkSpeedMbps * 1_000_000)) * 100)
    : null;
  return {
    collectedAt,
    interface: interfaceName,
    gateway: network.gateway || null,
    dnsServers: Array.isArray(network.dns) ? network.dns : [],
    rxBytesPerSecond,
    txBytesPerSecond,
    latencyMs: internetProbe?.latencyMs ?? centralProbe?.latencyMs ?? null,
    packetLossPercent: internetProbe?.packetLossPercent ?? centralProbe?.packetLossPercent ?? null,
    jitterMs: internetProbe?.jitterMs ?? centralProbe?.jitterMs ?? null,
    gatewayLatencyMs: gatewayProbe?.latencyMs ?? null,
    gatewayPacketLossPercent: gatewayProbe?.packetLossPercent ?? null,
    dnsLatencyMs: dnsResult?.dnsLatencyMs ?? null,
    centralLatencyMs: centralProbe?.latencyMs ?? null,
    linkSpeedMbps,
    linkUtilizationPercent,
    rxErrorsPerSecond,
    txErrorsPerSecond,
    rxDroppedPerSecond,
    txDroppedPerSecond,
    gatewayReachable: gatewayProbe?.reachable ?? null,
    internetReachable: internetProbe?.reachable ?? null,
    centralReachable: centralProbe?.reachable ?? null
  };
}

async function centralDockerContainersPayload() {
  if (!(await commandExists('docker'))) return [];
  try {
    const out = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 20_000, maxBuffer: 1024 * 1024 * 5 });
    return out.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          const row = JSON.parse(line);
          const image = row.Image || '';
          const imageTag = image.includes(':') ? image.split(':').at(-1) : '';
          return {
            name: row.Names || '',
            status: row.State || 'unknown',
            detail: row.Status || '',
            image,
            imageTag,
            imageId: String(row.ID || '').replace(/^sha256:/, '').slice(0, 12),
            version: imageTag || ''
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function centralServicesPayload(payload = {}) {
  let apps = Array.isArray(payload.apps) ? payload.apps : [];
  let detail = '';
  if (!apps.length) {
    try {
      apps = await appsStatus();
      detail = 'Inventario coletado por fallback direto dos apps gerenciados.';
    } catch (err) {
      detail = `Falha ao coletar apps gerenciados: ${err.message || err}`;
      apps = [];
    }
  }
  const appContainerNames = new Set(apps.flatMap(app => Array.isArray(app.containers) ? app.containers.map(container => container.name || '') : []));
  const containers = (await centralDockerContainersPayload()).filter(container => container.name && !appContainerNames.has(container.name));
  return {
    platform: 'linux-docker',
    collectedAt: new Date().toISOString(),
    detail,
    apps: apps.map(app => ({
      name: app.name || '',
      title: app.title || app.name || '',
      status: app.status || 'unknown',
      enabled: app.enabled !== false,
      version: app.version || app.branch || '',
      branch: app.branch || '',
      health: app.health || null,
      containers: Array.isArray(app.containers)
        ? app.containers.map(container => ({
            name: container.name || '',
            status: container.status || 'unknown',
            detail: container.detail || '',
            image: container.image || '',
            imageTag: container.imageTag || '',
            imageId: container.imageId || '',
            version: container.version || '',
            revision: container.revision || ''
          }))
        : []
    })),
    containers
  };
}

async function centralHeartbeat(token, payload) {
  const networkMetrics = await centralNetworkMetricsPayload();
  return centralRequest('/api/tronsoftos/heartbeat', {
    method: 'POST',
    token,
    body: {
      status: centralStatusFromDashboard(payload),
      tronsoftos: {
        version: payload.build?.version || '',
        build: payload.build?.buildNumber ? String(payload.build.buildNumber) : payload.build?.commit || '',
        channel: payload.build?.branch || ''
      },
      database: await centralDatabasePayload(),
      host: centralHostPayload(),
      cluster: {
        mode: payload.cluster?.mode || '',
        nodeName: payload.cluster?.nodeName || '',
        nodeRole: payload.cluster?.nodeRole || '',
        vip: payload.cluster?.vip || null
      },
      backups: payload.backups || {},
      services: await centralServicesPayload(payload),
      metrics: {
        systemMetrics: centralSystemMetricsPayload(payload),
        firebird: centralFirebirdMetricsPayload(payload),
        network: networkMetrics,
        hostUptimeSeconds: payload.hostUptimeSeconds ?? null
      },
      alerts: (payload.alerts || []).map(alert => {
        const title = alert.title || alert.message || 'Alerta TronSoftOS';
        return {
          severity: alert.severity || 'info',
          title,
          message: alert.message || title,
          code: stableAlertCode(alert),
          source: alert.source || 'TronSoftOS',
          details: alert.details || null
        };
      })
    }
  });
}

function centralAlertKey(alert) {
  return crypto.createHash('sha1')
    .update(`${alert.severity || 'info'}:${alert.message || alert.title || ''}`)
    .digest('hex');
}

function stableAlertCode(alert) {
  return alert.code || alert.type || centralAlertKey(alert);
}

function writeCentralAlertStates() {
  ensureStateDir();
  fs.writeFileSync(centralAlertStatePath, `${JSON.stringify(Object.fromEntries(centralAlertStates), null, 2)}\n`, { mode: 0o600 });
}

async function centralSendAlert(token, alert) {
  const title = alert.title || alert.message || 'Alerta TronSoftOS';
  return centralRequest('/api/tronsoftos/alerts', {
    method: 'POST',
    token,
    body: {
      severity: alert.severity || 'info',
      title,
      message: alert.message || title,
      code: stableAlertCode(alert),
      details: {
        source: 'tronsoftos',
        node: nodeIdentity(),
        alert
      }
    }
  });
}

async function centralSyncAlerts(token, alerts) {
  const activeKeys = new Set();
  for (const alert of alerts || []) {
    const key = stableAlertCode(alert);
    activeKeys.add(key);
    if (centralAlertStates.get(key) === 'active') continue;
    await centralSendAlert(token, alert);
    centralAlertStates.set(key, 'active');
    appendEvent('CENTRAL_ALERT_SENT', { key, severity: alert.severity || 'info', message: alert.message || alert.title || '' });
  }
  for (const [key, state] of centralAlertStates.entries()) {
    if (state === 'active' && !activeKeys.has(key)) {
      centralAlertStates.set(key, 'recovered');
      appendEvent('CENTRAL_ALERT_RECOVERED', { key });
    }
  }
  writeCentralAlertStates();
}

async function centralAgentTick() {
  if (!centralEnabled() || centralAgentInFlight) return;
  centralAgentInFlight = true;
  try {
    let token = centralToken();
    if (!token) {
      appendEvent('CENTRAL_SYNC_SKIPPED', { reason: 'token da instalacao nao configurado' });
      return;
    }
    const payload = await dashboard();
    try {
      await centralHeartbeat(token, payload);
    } catch (err) {
      throw err;
    }
    await centralSyncAlerts(token, payload.alerts || []);
  } catch (err) {
    appendEvent('CENTRAL_SYNC_FAILED', { centralUrl: centralBaseUrl(), error: err.message });
  } finally {
    centralAgentInFlight = false;
  }
}

function startCentralAgent() {
  if (!centralEnabled()) return;
  centralAgentTick();
  centralAgentTimer = setInterval(centralAgentTick, centralHeartbeatMs());
  appendEvent('CENTRAL_AGENT_STARTED', {
    centralUrl: centralBaseUrl(),
    intervalSeconds: Math.round(centralHeartbeatMs() / 1000)
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

function serveStatic(req, reply, basePath = '') {
  const url = new URL(req.url, 'http://localhost');
  const pathname = basePath && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
    ? url.pathname.slice(basePath.length) || '/'
    : url.pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(frontendDist, `.${requested}`);
  const safeRoot = path.resolve(frontendDist);
  const finalPath = filePath.startsWith(safeRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(safeRoot, 'index.html');
  if (!fs.existsSync(finalPath)) return json(reply, 404, { error: 'frontend not built' });
  reply.writeHead(200, { 'content-type': contentTypeFor(finalPath) });
  fs.createReadStream(finalPath).pipe(reply);
}

function isFrontendAssetPath(pathname) {
  return pathname === '/favicon.svg' || pathname === '/manifest.webmanifest' || pathname.startsWith('/assets/');
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

async function verifyTronsoftosCredentials(username, password) {
  const token = internalTokenValue();
  if (!token) throw Object.assign(new Error('Token interno nao configurado'), { statusCode: 503 });
  const target = tronfireProxyTarget();
  const response = await fetch(new URL('/api/internal/auth/verify', target), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tronsoftos-token': token },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Credenciais invalidas');
    error.statusCode = response.status;
    throw error;
  }
  return payload.user;
}

async function handleLogin(req, reply) {
  const body = await readBody(req);
  const username = String(body.username || '').toLowerCase().trim();
  const password = String(body.password || '');
  const retryAfter = loginThrottle(req, username);
  if (retryAfter) {
    reply.setHeader('retry-after', String(retryAfter));
    return json(reply, 429, { error: `Muitas tentativas. Tente novamente em ${retryAfter} segundos.` });
  }
  try {
    const user = await verifyTronsoftosCredentials(username, password);
    clearLoginFailures(req, username);
    const session = {
      username: user.username,
      name: user.name,
      role: user.role,
      expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
      nonce: crypto.randomUUID()
    };
    reply.setHeader('set-cookie', cookieHeader(req, signSession(session)));
    appendEvent('LOGIN_OK', { username: user.username, remoteAddress: req.socket.remoteAddress || null });
    return json(reply, 200, { user });
  } catch (err) {
    if (err.statusCode === 401) {
      recordLoginFailure(req, username);
      appendEvent('LOGIN_FAILED', { username, remoteAddress: req.socket.remoteAddress || null });
      return json(reply, 401, { error: 'Usuario ou senha invalidos' });
    }
    throw err;
  }
}

async function handleApi(req, reply, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(reply, 200, { ok: true, app: 'TronSoftOS', ...buildInfo(), node: nodeIdentity() });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') return handleLogin(req, reply);
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    reply.setHeader('set-cookie', cookieHeader(req, '', 0));
    return json(reply, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const session = sessionFromRequest(req);
    return session
      ? json(reply, 200, { user: { username: session.username, name: session.name, role: session.role } })
      : json(reply, 401, { error: 'UNAUTHORIZED' });
  }
  if (req.method === 'GET' && url.pathname === '/api/cluster/guard') return json(reply, 200, clusterGuard());
  if (!sessionFromRequest(req) && !requestHasInternalToken(req)) {
    return json(reply, 401, { error: 'UNAUTHORIZED' });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(reply, 200, await dashboard());
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') return json(reply, 200, await diagnostics());
  if (req.method === 'GET' && url.pathname === '/api/apps') return json(reply, 200, { apps: await appsStatus() });
  if (req.method === 'GET' && url.pathname === '/api/troncomanda/settings') return json(reply, 200, await troncomandaSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/troncomanda/settings') return json(reply, 200, await writeTroncomandaSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/apps/registry-login') return json(reply, 200, await dockerRegistryLogin(await readBody(req)));
  const actionJobMatch = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (req.method === 'GET' && actionJobMatch) {
    const liveJob = actionJobs.get(actionJobMatch[1]);
    if (liveJob) return json(reply, 200, publicActionJob(liveJob));
    const persistedJob = updateStatusJob(actionJobMatch[1]);
    if (!persistedJob) return json(reply, 404, { error: 'action not found' });
    return json(reply, 200, persistedJob);
  }
  if (req.method === 'GET' && url.pathname === '/api/cluster') return json(reply, 200, clusterStatus());
  if (req.method === 'GET' && url.pathname === '/api/cluster/standby-status') {
    const status = await tronfireHaStatus();
    return status
      ? json(reply, 200, summarizeTronfireHaStatus(status))
      : json(reply, 503, { error: 'status HA do TronFire indisponivel' });
  }
  if (req.method === 'GET' && url.pathname === '/api/cluster/lock') return json(reply, 200, clusterLock());
  if (req.method === 'PATCH' && url.pathname === '/api/cluster/lock') return json(reply, 200, writeClusterLock(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cluster/promotion/block') return json(reply, 200, blockClusterPromotion((await readBody(req).catch(() => ({}))).reason));
  if (req.method === 'POST' && url.pathname === '/api/cluster/activate-local') return json(reply, 200, await activateLocalNode(await readBody(req).catch(() => ({}))));
  if (req.method === 'POST' && url.pathname === '/api/cluster/recovery-local') return json(reply, 200, putLocalNodeInRecovery(await readBody(req).catch(() => ({}))));
  if (req.method === 'GET' && url.pathname === '/api/cluster/network-impact') return json(reply, 200, await clusterNetworkImpact(url.searchParams.get('proposed') || ''));
  if (req.method === 'GET' && url.pathname === '/api/cluster/sync') return json(reply, 200, publicHaSyncSettings());
  if (req.method === 'GET' && url.pathname === '/api/cluster/sync/logs') return json(reply, 200, haSyncLogs(url.searchParams.get('file') || ''));
  if (req.method === 'PATCH' && url.pathname === '/api/cluster/sync') return json(reply, 200, writeHaSyncSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cluster/sync/test-ssh') return json(reply, 200, await testHaSyncSsh(await readBody(req).catch(() => ({}))));
  if (req.method === 'POST' && url.pathname === '/api/cluster/sync/run') return json(reply, 202, { ok: true, job: startHaSync() });
  if (req.method === 'GET' && url.pathname === '/api/cluster/failover') return json(reply, 200, haFailoverStatus());
  if (req.method === 'PATCH' && url.pathname === '/api/cluster/failover') return json(reply, 200, writeHaFailoverSettings(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/node-identity') return json(reply, 200, nodeIdentity());
  if (req.method === 'PATCH' && url.pathname === '/api/node-identity') return json(reply, 200, writeNodeIdentity(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups') return json(reply, 200, await backupStatus());
  if (req.method === 'GET' && url.pathname === '/api/backups/rclone') return json(reply, 200, publicRcloneSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/backups/rclone') return json(reply, 200, writeRcloneSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/test') return json(reply, 200, await rcloneTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/upload-test') return json(reply, 200, await rcloneUploadTest());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/cleanup') return json(reply, 200, await rcloneCleanupRemoteBackups());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/token') return json(reply, 200, saveGoogleDriveToken(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/reset-auth') return json(reply, 200, await resetGoogleDriveAuth());
  if (req.method === 'GET' && url.pathname === '/api/backups/rclone/remote-files') return json(reply, 200, await rcloneRemoteBackups());
  if (req.method === 'POST' && url.pathname === '/api/backups/rclone/download') return json(reply, 202, { ok: true, job: startRcloneRemoteBackupDownload(await readBody(req)) });
  if (req.method === 'GET' && url.pathname === '/api/backups/google/central') return json(reply, 200, await centralGoogleStatus());
  if (req.method === 'POST' && url.pathname === '/api/backups/google/central/start') return json(reply, 200, await centralGoogleStart(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/google/central/apply') return json(reply, 200, await centralGoogleApply(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, publicGoogleCredentials());
  if (req.method === 'POST' && url.pathname === '/api/backups/google/credentials') return json(reply, 200, saveGoogleCredentials(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/backups/google/start') return json(reply, 200, startGoogleDriveOauth(req, await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/backups/google/callback') return await completeGoogleDriveOauth(reply, url);
  if (req.method === 'GET' && url.pathname === '/api/drive') return json(reply, 200, await driveStatus());
  if (req.method === 'PATCH' && url.pathname === '/api/drive') return json(reply, 200, await writeDriveSettings(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/cloudflare') return json(reply, 200, cloudflareStatus());
  if (req.method === 'PATCH' && url.pathname === '/api/cloudflare') return json(reply, 200, await saveCloudflareSettings(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/cloudflare/reset') return json(reply, 200, await resetCloudflareSettings());
  if (req.method === 'POST' && url.pathname === '/api/cloudflare/test') return json(reply, 200, await cloudflareTest());
  if (req.method === 'POST' && url.pathname === '/api/cloudflare/sync') return json(reply, 200, await cloudflareSync());
  if (req.method === 'GET' && url.pathname === '/api/settings/central') return json(reply, 200, publicCentralSettings());
  if (req.method === 'POST' && url.pathname === '/api/settings/central/validate-token') {
    const body = await readBody(req);
    return json(reply, 200, await centralPair(String(body.token || '').trim(), String(body.url || '').trim()));
  }
  if (req.method === 'GET' && url.pathname === '/api/settings/smtp') return json(reply, 200, smtpSettings());
  if (req.method === 'PATCH' && url.pathname === '/api/settings/smtp') return json(reply, 200, writeSmtpSettings(await readBody(req)));
  if (req.method === 'GET' && url.pathname === '/api/events') return json(reply, 200, { events: readEvents(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'GET' && url.pathname === '/api/maintenance') return json(reply, 200, await maintenanceStatus());
  if (req.method === 'POST' && url.pathname === '/api/maintenance/update') return json(reply, 202, { ok: true, job: startTronsoftosUpdate(await readBody(req)) });
  if (req.method === 'POST' && url.pathname === '/api/maintenance/failover-block') return json(reply, 200, writeFailoverMaintenanceBlock(await readBody(req).catch(() => ({}))));
  if (req.method === 'POST' && url.pathname === '/api/maintenance/failover-clear') return json(reply, 200, clearFailoverMaintenanceBlock(await readBody(req).catch(() => ({}))));
  if (req.method === 'GET' && url.pathname === '/api/maintenance/failback') return json(reply, 200, await failbackStatus());
  if (req.method === 'POST' && url.pathname === '/api/maintenance/failback/prepare') return json(reply, 200, await prepareFailback(await readBody(req)));
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
  if (req.method === 'POST' && url.pathname === '/api/host/firebird/script') {
    req.setTimeout?.(14_700_000);
    reply.setTimeout?.(14_700_000);
    return json(reply, 200, await hostFirebirdScript(req));
  }
  if (req.method === 'GET' && url.pathname === '/api/host/network') return json(reply, 200, await hostNetworkStatus());
  if (req.method === 'POST' && url.pathname === '/api/host/network/static') return json(reply, 200, await hostNetworkStatic(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/host/network/vip') return json(reply, 200, await hostNetworkVip(await readBody(req)));
  const hostFirebirdMatch = url.pathname.match(/^\/api\/host\/firebird\/(start|stop|restart)$/);
  if (req.method === 'POST' && hostFirebirdMatch) return json(reply, 200, await hostFirebirdAction(hostFirebirdMatch[1]));
  const actionMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/(up|stop|restart|pull)$/);
  if (req.method === 'POST' && actionMatch) {
    const body = await readBody(req).catch(() => ({}));
    const app = findApp(actionMatch[1]);
    if (!app) return json(reply, 404, { error: 'app not found' });
    return json(reply, 202, { ok: true, job: startAppAction(app, actionMatch[2], body) });
  }
  return json(reply, 404, { error: 'not found' });
}

async function handleHttpRequest(req, reply, options = {}) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (friendlyPath && url.pathname === friendlyPath) {
      reply.writeHead(302, { location: `${friendlyPath}/` });
      return reply.end();
    }
    if (friendlyPath && url.pathname.startsWith(`${friendlyPath}/`)) {
      return serveStatic(req, reply, friendlyPath);
    }
    if (options.friendly && url.pathname === '/') {
      reply.writeHead(302, { location: friendlyPath ? `${friendlyPath}/` : `http://${url.hostname}:${port}/` });
      return reply.end();
    }
    if (options.friendly && isFrontendAssetPath(url.pathname)) {
      return serveStatic(req, reply);
    }
    if (url.pathname === '/tronfire') {
      reply.writeHead(302, { location: '/tronfire/' });
      return reply.end();
    }
    if (url.pathname.startsWith('/tronfire/')) {
      if (!sessionFromRequest(req)) {
        if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
          reply.writeHead(302, { location: friendlyPath && options.friendly ? `${friendlyPath}/` : '/' });
          return reply.end();
        }
        return json(reply, 401, { error: 'UNAUTHORIZED' });
      }
      return proxyTronfire(req, reply);
    }
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      return await handleApi(req, reply, url);
    }
    return serveStatic(req, reply);
  } catch (err) {
    const status = err.statusCode || 500;
    const message = status >= 500 && process.env.NODE_ENV !== 'development'
      ? 'internal error'
      : err.message || 'internal error';
    return json(reply, status, { error: message });
  }
}

const server = http.createServer((req, reply) => handleHttpRequest(req, reply));
server.timeout = 0;
server.requestTimeout = 14_700_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

let friendlyServer = null;
if (friendlyPort && friendlyPort !== port && friendlyPath) {
  friendlyServer = http.createServer((req, reply) => handleHttpRequest(req, reply, { friendly: true }));
  friendlyServer.timeout = 0;
  friendlyServer.requestTimeout = server.requestTimeout;
  friendlyServer.headersTimeout = server.headersTimeout;
  friendlyServer.keepAliveTimeout = server.keepAliveTimeout;
  friendlyServer.on('error', err => {
    const reason = err.code === 'EACCES'
      ? `permissao insuficiente para abrir a porta ${friendlyPort}`
      : err.code === 'EADDRINUSE'
        ? `porta ${friendlyPort} ja esta em uso`
        : err.message;
    appendEvent('TRONSOFTOS_FRIENDLY_PORT_SKIPPED', { port: friendlyPort, path: friendlyPath, reason });
    console.warn(`Acesso amigavel desativado: ${reason}`);
  });
}

server.listen(port, '0.0.0.0', () => {
  ensureStateDir();
  startHaSyncScheduler();
  startHaFailoverWatchdog();
  startCentralAgent();
  appendEvent('TRONSOFTOS_STARTED', { port, friendlyPort, friendlyPath });
  console.log(`TronSoftOS listening on 0.0.0.0:${port}`);
  if (friendlyServer) {
    friendlyServer.listen(friendlyPort, '0.0.0.0', () => {
      appendEvent('TRONSOFTOS_FRIENDLY_PORT_STARTED', { port: friendlyPort, path: friendlyPath });
      console.log(`TronSoftOS friendly access listening on 0.0.0.0:${friendlyPort}${friendlyPath}`);
    });
  }
});
