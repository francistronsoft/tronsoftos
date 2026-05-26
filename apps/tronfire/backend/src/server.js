import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { prisma } from './prisma.js';
import { createSession, makeToken, requireAuth, requireAdmin, requireOperator, verifyPassword, hashPassword, sha256 } from './security.js';
import { audit } from './audit.js';
import { runPreflight } from './preflight.js';
import { docker, dockerExec } from './shell.js';
import {
  readCloudflareTunnelSettings,
  startCloudflareTunnel,
  stopCloudflareTunnel,
  writeCloudflareTunnelSettings
} from './cloudflare-tunnel.js';
import {
  completeGoogleDriveOAuth,
  createGoogleDriveAuthUrl,
  readGoogleDriveSettings,
  testGoogleDriveConnection,
  uploadBackupToGoogleDrive,
  writeGoogleDriveSettings
} from './google-drive-oauth.js';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 1024 });
const storageRoot = process.env.STORAGE_ROOT || '/opt/tronsoftOS/storage/tronfire';
const defaultTemplatePath = process.env.FIREBIRD_TEMPLATE_PATH || '/firebird/templates/template.fdb';
const firebirdPort = process.env.TRONFIRE_FIREBIRD_PORT || '3050';
const firebirdContainer = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
const firebirdLogsDir = '/firebird/logs';
const deploymentMode = String(process.env.TRONFIRE_DEPLOYMENT_MODE || 'simple').toLowerCase();
const nodeRole = String(process.env.TRONFIRE_NODE_ROLE || 'primary').toLowerCase();
const clusterLockPath = process.env.TRONSOFTOS_CLUSTER_LOCK || '/opt/tronsoftos/state/cluster-lock.json';
const internalToken = process.env.TRONSOFTOS_INTERNAL_TOKEN || '';
const firebirdExecMode = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
const tronsoftosApiUrl = String(process.env.TRONSOFTOS_API_URL || 'http://host.docker.internal:8080').replace(/\/+$/, '');
const firebirdInternalHost = process.env.FIREBIRD_HOST || 'host.docker.internal';

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie, { secret: process.env.SESSION_SECRET || 'dev-secret-change-me' });
await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 * 20 } });
await app.register(fastifyStatic, { root: path.resolve('/app/frontend'), prefix: '/' });

function shouldUseSecureCookie() {
  if (String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true') return true;
  if (String(process.env.COOKIE_SECURE || '').toLowerCase() === 'false') return false;
  return String(process.env.PUBLIC_URL || '').toLowerCase().startsWith('https://');
}

function setSessionCookie(reply, token) {
  reply.setCookie('tronfire_session', token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: shouldUseSecureCookie(), maxAge: 60 * 60 * 8
  });
}

function clearSessionCookie(reply) {
  reply.clearCookie('tronfire_session', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookie()
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeAlias(alias) {
  const value = String(alias || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!value) throw new Error('Alias do banco nao informado');
  return value;
}

function normalizeName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('Nome do banco nao informado');
  return value;
}

function databasePathForAlias(alias) {
  return `/firebird/data/${normalizeAlias(alias)}.fdb`;
}

function standbyPathForAlias(alias) {
  return `/firebird/standby/${normalizeAlias(alias)}_standby.fdb`;
}

function firebirdDbConnect(filePath) {
  const value = String(filePath || '').trim();
  if (firebirdExecMode === 'host' || firebirdExecMode === 'direct') return `${firebirdInternalHost}:${value}`;
  return value;
}

function firebirdCreateTarget(filePath) {
  return firebirdDbConnect(filePath);
}

function isHaMode() {
  return deploymentMode === 'ha';
}

function isPrimaryNode() {
  return nodeRole === 'primary';
}

function assertPrimaryWritable() {
  if (isHaMode() && !isPrimaryNode()) {
    const error = new Error(`Operacao bloqueada: no TronFire em modo ${nodeRole}`);
    error.statusCode = 409;
    error.code = 'TRONFIRE_NODE_NOT_PRIMARY';
    throw error;
  }
}

function assertInternalTronsoftos(req) {
  if (!internalToken) {
    const error = new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado');
    error.statusCode = 503;
    throw error;
  }
  const token = String(req.headers['x-tronsoftos-token'] || req.body?.tronsoftosToken || '');
  if (token !== internalToken) {
    const error = new Error('Token interno TronSoftOS invalido');
    error.statusCode = 403;
    throw error;
  }
}

function readClusterLock() {
  if (!fs.existsSync(clusterLockPath)) {
    const error = new Error(`Cluster lock nao encontrado: ${clusterLockPath}`);
    error.statusCode = 409;
    throw error;
  }
  return JSON.parse(fs.readFileSync(clusterLockPath, 'utf8'));
}

async function tronsoftosRequest(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (internalToken) headers['x-tronsoftos-token'] = internalToken;
  const response = await fetch(`${tronsoftosApiUrl}${pathname}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `TronSoftOS HTTP ${response.status}`);
  return body;
}

function timestamp14() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function safeLogToken(value) {
  const token = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{6,32}$/.test(token) ? token : timestamp14();
}

function parseDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(raw.length <= 10 ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createdAtWhere(query = {}) {
  const from = parseDateBoundary(query.from);
  const to = parseDateBoundary(query.to, true);
  const createdAt = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;
  return Object.keys(createdAt).length ? { createdAt } : {};
}

function readTail(filePath, maxBytes = 12000) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function safeFirebirdLogName(name) {
  const value = path.basename(String(name || ''));
  if (!/^[a-zA-Z0-9_.-]+\.log$/i.test(value)) throw new Error('Nome de log invalido');
  return value;
}

function assertUploadedBackupPath(filePath) {
  const value = String(filePath || '').trim();
  if (!value.startsWith('/firebird/uploads/') || !/\.(gbk|fbk|gbk\.gz|fbk\.gz)$/i.test(value)) {
    throw new Error('Arquivo de restore invalido');
  }
  return value;
}

function isManagedBackupPath(filePath) {
  const value = String(filePath || '').trim();
  return value.startsWith('/firebird/backups/') && /\.(gbk|gbk\.gz)$/i.test(value);
}

function isReceivedBackupPath(filePath) {
  const value = String(filePath || '').trim();
  return value.startsWith('/firebird/backups/') && /\.(gbk|fbk|gbk\.gz|fbk\.gz)$/i.test(value);
}

function normalizeBackupCleanupOptions(query = {}) {
  const olderThanDays = Math.max(Number(query.olderThanDays || 7), 0);
  const keepLastPerDatabase = Math.max(Number(query.keepLastPerDatabase || 1), 0);
  const databaseId = String(query.databaseId || '').trim();
  return { olderThanDays, keepLastPerDatabase, databaseId };
}

async function backupCleanupCandidates(options = {}) {
  const { olderThanDays, keepLastPerDatabase, databaseId } = normalizeBackupCleanupOptions(options);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const jobs = await prisma.backupJob.findMany({
    where: {
      status: 'SUCCESS',
      backupPath: { not: null },
      ...(olderThanDays > 0 ? { createdAt: { lt: cutoff } } : {}),
      ...(databaseId ? { databaseId } : {})
    },
    include: { database: true },
    orderBy: [{ databaseId: 'asc' }, { createdAt: 'desc' }]
  });
  const kept = new Map();
  const candidates = [];
  for (const job of jobs) {
    const count = kept.get(job.databaseId) || 0;
    kept.set(job.databaseId, count + 1);
    if (count < keepLastPerDatabase) continue;
    if (!isManagedBackupPath(job.backupPath)) continue;
    const exists = fs.existsSync(job.backupPath);
    const size = exists ? fs.statSync(job.backupPath).size : Number(job.backupSize || 0);
    candidates.push({
      id: job.id,
      databaseId: job.databaseId,
      databaseName: job.database?.name || '',
      alias: job.database?.alias || '',
      backupPath: job.backupPath,
      backupSize: String(size),
      createdAt: job.createdAt,
      exists
    });
  }
  const totalBytes = candidates.reduce((sum, item) => sum + Number(item.backupSize || 0), 0);
  return { olderThanDays, keepLastPerDatabase, databaseId, totalBytes: String(totalBytes), count: candidates.length, candidates };
}

async function syncFirebirdAliases() {
  const dbs = await prisma.managedDatabase.findMany({ where: { type: { not: 'ARQUIVADO' } } });
  const lines = [
    '# ------------------------------',
    '# List of known database aliases',
    '# Managed by TronFire',
    '# ------------------------------',
    ''
  ];
  for (const db of dbs) {
    lines.push(`${db.alias} = ${db.filePath}`);
  }
  const content = `${lines.join('\n')}\n`;
  if (firebirdExecMode !== 'container') {
    await tronsoftosRequest('/api/host/firebird/aliases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content })
    });
    return;
  }
  await dockerExec(['sh', '-lc', `cat > /usr/local/firebird/aliases.conf <<'EOF'\n${content}EOF\n`], { timeout: 120000 });
}

function firebirdHost(req) {
  return String(process.env.TRONFIRE_LAN_HOST || req.hostname || '127.0.0.1').split(':')[0];
}

function connectionInfoForDatabase(db, req) {
  const host = firebirdHost(req);
  const port = String(firebirdPort);
  const path = db.filePath;
  return {
    databaseId: db.id,
    name: db.name,
    alias: db.alias,
    host,
    port,
    path,
    user: 'SYSDBA',
    passwordSource: 'FIREBIRD_PASSWORD',
    aliasConnection: `${host}/${port}:${db.alias}`,
    aliasDefaultPort: `${host}:${db.alias}`,
    withPort: `${host}/${port}:${path}`,
    defaultPort: `${host}:${path}`
  };
}

function metricRangeStart(range) {
  const now = Date.now();
  const hours = {
    day: 24,
    week: 24 * 7,
    month: 24 * 30
  }[range] || 24;
  return new Date(now - hours * 60 * 60 * 1000);
}

function serializeBigInts(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

function metricKey(metric) {
  return `${metric.scope}:${metric.target}`;
}

async function loadDashboardMetrics(range = 'day') {
  const since = metricRangeStart(range);
  const metrics = await prisma.metricSnapshot.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: 5000
  });
  const latest = new Map();
  for (const metric of metrics) latest.set(metricKey(metric), metric);
  return serializeBigInts({
    range,
    since,
    latest: Array.from(latest.values()),
    series: metrics
  });
}

async function createAlertOnce(type, severity, message) {
  const existing = await prisma.alert.findFirst({ where: { type, severity, resolved: false } });
  if (!existing) {
    await prisma.alert.create({ data: { type, severity, message } });
  }
}

function parseJsonSetting(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

async function readJsonSetting(key) {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  return parseJsonSetting(setting?.value);
}

async function writeJsonSetting(key, value) {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) }
  });
}

async function acquireDatabaseOperationLock(req, db, operation, reply) {
  const key = `DATABASE_LOCK_${operation}_${db.id}`;
  const now = new Date();
  const existing = await prisma.systemSetting.findUnique({ where: { key } });
  const current = parseJsonSetting(existing?.value);
  if (current.expiresAt && new Date(current.expiresAt) > now) {
    return reply.code(409).send({
      error: `Ja existe uma ${operation.toLowerCase()} manual em andamento para o banco ${db.name}. Aguarde finalizar antes de iniciar outra operacao.`,
      code: 'DATABASE_OPERATION_IN_PROGRESS',
      databaseId: db.id,
      databaseName: db.name,
      operation,
      startedAt: current.startedAt,
      expiresAt: current.expiresAt,
      user: current.user || null
    });
  }
  const token = makeToken();
  const lock = {
    token,
    operation,
    databaseId: db.id,
    databaseName: db.name,
    user: req.user?.name || req.user?.email || 'desconhecido',
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 1000 * 60 * 60 * 6).toISOString()
  };
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(lock) },
    create: { key, value: JSON.stringify(lock) }
  });
  return {
    lock,
    release: async () => {
      const latest = await prisma.systemSetting.findUnique({ where: { key } });
      if (parseJsonSetting(latest?.value).token === token) {
        await prisma.systemSetting.delete({ where: { key } }).catch(() => {});
      }
    }
  };
}

async function ensureDatabaseFromTemplate(filePath) {
  assertPrimaryWritable();
  const target = String(filePath || '').trim();
  if (!target) throw new Error('Caminho do banco nao informado');
  const cmd = [
    'set -e',
    `target=${shQuote(target)}`,
    `template=${shQuote(defaultTemplatePath)}`,
    `case "$target" in /firebird/data/*.[fF][dD][bB]) ;; *) echo "Use um caminho /firebird/data/*.fdb"; exit 64;; esac`,
    'test -f "$template"',
    'if [ -e "$target" ]; then echo "Arquivo de banco ja existe: $target"; exit 65; fi',
    'mkdir -p "$(dirname "$target")"',
    'cp "$template" "$target"',
    'chmod 0666 "$target"',
    `LD_LIBRARY_PATH="${process.env.FIREBIRD_LIB || '/usr/local/firebird/lib'}:$LD_LIBRARY_PATH" ${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat -h "$target" >/tmp/tronfire_create_check.log 2>&1 || { rc=$?; cat /tmp/tronfire_create_check.log; rm -f "$target"; exit $rc; }`
  ].join('; ');
  await dockerExec(['sh', '-lc', cmd], { timeout: 120000 });
}

function backupManifestFor(db, backupPath, sha) {
  return {
    databaseId: db.id,
    databaseAlias: db.alias,
    databaseName: db.name,
    sourceNode: process.env.TRONSOFTOS_NODE_NAME || process.env.HOSTNAME || 'unknown',
    backupPath,
    backupSha256: sha,
    backupFinishedAt: new Date().toISOString(),
    firebirdVersion: '2.5.9',
    productionPath: db.filePath,
    standbyPath: db.standbyPath || standbyPathForAlias(db.alias)
  };
}

function writeBackupManifest(db, backupPath, sha) {
  const manifestPath = `${backupPath}.manifest.json`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(backupManifestFor(db, backupPath, sha), null, 2)}\n`);
  return manifestPath;
}

function readBackupManifest(manifestPath) {
  const value = String(manifestPath || '').trim();
  if (!value.startsWith('/firebird/backups/') || !value.endsWith('.manifest.json')) {
    throw new Error('Manifesto de backup invalido');
  }
  return JSON.parse(fs.readFileSync(value, 'utf8'));
}

async function uploadBackupJobToExternal(req, db, jobId, backupPath) {
  const settings = await readGoogleDriveSettings(prisma);
  if (!settings.enabled) {
    await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'DISABLED' } });
    return { skipped: true };
  }
  await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'UPLOADING', driveErrorMessage: null } });
  try {
    const uploaded = await uploadBackupToGoogleDrive(prisma, backupPath);
    await prisma.backupJob.update({
      where: { id: jobId },
      data: {
        driveStatus: 'UPLOADED',
        driveFileId: uploaded.fileId || null,
        driveFileName: uploaded.fileName,
        driveWebLink: uploaded.webViewLink || null,
        driveUploadedAt: new Date(),
        driveErrorMessage: null
      }
    });
    await audit(req, 'BACKUP_GOOGLE_DRIVE_UPLOADED', { entityType: 'backup', entityId: jobId, details: { database: db.alias, fileId: uploaded.fileId } });
    return uploaded;
  } catch (err) {
    await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'FAILED', driveErrorMessage: err.message } });
    await createAlertOnce(`BACKUP_EXTERNAL_UPLOAD_FAILED_${db.alias}`, 'WARNING', `Backup local OK, mas envio ao Google Drive falhou: ${db.name}`);
    await audit(req, 'BACKUP_GOOGLE_DRIVE_UPLOAD_FAILED', { entityType: 'backup', entityId: jobId, details: { database: db.alias, error: err.message } });
    return { skipped: false, error: err.message };
  }
}

app.get('/health', async () => ({ ok: true, app: 'TronFire', version: '0.1.0', deploymentMode, nodeRole }));

app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { email: String(email || '').toLowerCase().trim() } });
  if (!user || !user.active || !(await verifyPassword(String(password || ''), user.passwordHash))) {
    await prisma.auditLog.create({ data: { action: 'LOGIN_FAILED', ipAddress: req.ip, userAgent: req.headers['user-agent'] || '', details: { email } } });
    return reply.code(401).send({ error: 'Credenciais inválidas' });
  }
  const operatorRoles = ['ADMIN', 'TECNICO'];
  const singleOperatorSession = process.env.SINGLE_OPERATOR_SESSION !== 'false' && operatorRoles.includes(user.role);
  const activeSession = await prisma.session.findFirst({
    where: {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(singleOperatorSession ? { user: { role: { in: operatorRoles } } } : { userId: user.id })
    },
    orderBy: { createdAt: 'desc' },
    include: { user: true }
  });
  if (activeSession && !req.body?.force) {
    return reply.code(409).send({
      error: singleOperatorSession
        ? `Ja existe um operador conectado: ${activeSession.user?.name || activeSession.user?.email || 'desconhecido'}`
        : 'Usuario ja possui uma sessao ativa',
      code: 'ACTIVE_SESSION',
      activeUser: activeSession.user ? { name: activeSession.user.name, email: activeSession.user.email, role: activeSession.user.role } : null,
      activeSince: activeSession.createdAt,
      lastIp: activeSession.ipAddress
    });
  }
  if (activeSession && req.body?.force && singleOperatorSession) {
    await prisma.session.updateMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() }, user: { role: { in: operatorRoles } } },
      data: { revokedAt: new Date() }
    });
  }
  const token = await createSession(user, req);
  setSessionCookie(reply, token);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ ...req, user }, 'LOGIN_OK');
  return { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies.tronfire_session;
  if (token) {
    const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (session && !session.revokedAt) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await audit({ ...req, user: session.user }, 'LOGOUT');
    }
  }
  clearSessionCookie(reply);
  return { ok: true };
});

app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } }));

app.get('/api/settings/cloudflare-tunnel', { preHandler: requireOperator }, async () => {
  return readCloudflareTunnelSettings(prisma, docker);
});

app.patch('/api/settings/cloudflare-tunnel', { preHandler: requireAdmin }, async (req) => {
  const setting = await writeCloudflareTunnelSettings(prisma, req.body || {}, req.user, docker);
  await audit(req, 'CLOUDFLARE_TUNNEL_UPDATED', {
    entityType: 'setting',
    entityId: 'CLOUDFLARE_TUNNEL',
    details: { enabled: setting.enabled, publicUrl: setting.publicUrl, tokenConfigured: setting.tokenConfigured }
  });
  return setting;
});

app.post('/api/settings/cloudflare-tunnel/:action', { preHandler: requireAdmin }, async (req, reply) => {
  const action = String(req.params.action || '').toLowerCase();
  try {
    if (action === 'start') {
      const out = await startCloudflareTunnel(prisma, docker);
      await audit(req, 'CLOUDFLARE_TUNNEL_STARTED', { entityType: 'container', entityId: out.container, details: { publicUrl: out.publicUrl } });
      return out;
    }
    if (action === 'stop') {
      const out = await stopCloudflareTunnel(prisma, docker);
      await audit(req, 'CLOUDFLARE_TUNNEL_STOPPED', { entityType: 'container', entityId: out.container });
      return out;
    }
    return reply.code(400).send({ error: 'Acao invalida' });
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.get('/api/settings/google-drive', { preHandler: requireOperator }, async (req) => {
  return readGoogleDriveSettings(prisma, req);
});

app.patch('/api/settings/google-drive', { preHandler: requireOperator }, async (req) => {
  const setting = await writeGoogleDriveSettings(prisma, req.body || {}, req.user);
  await audit(req, 'GOOGLE_DRIVE_BACKUP_UPDATED', {
    entityType: 'setting',
    entityId: 'GOOGLE_DRIVE_BACKUP',
    details: { enabled: setting.enabled, folderName: setting.folderName, connected: setting.connected }
  });
  return setting;
});

app.post('/api/settings/google-drive/test', { preHandler: requireOperator }, async (req, reply) => {
  try {
    return await testGoogleDriveConnection(prisma);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.post('/api/settings/google-drive/oauth/start', { preHandler: requireOperator }, async (req, reply) => {
  try {
    const out = await createGoogleDriveAuthUrl(prisma, req);
    await audit(req, 'GOOGLE_DRIVE_OAUTH_STARTED', {
      entityType: 'setting',
      entityId: 'GOOGLE_DRIVE_BACKUP',
      details: { redirectUri: out.redirectUri }
    });
    return out;
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.get('/api/settings/google-drive/oauth/callback', async (req, reply) => {
  try {
    const out = await completeGoogleDriveOAuth(prisma, req.query || {}, req);
    reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>TronFire</title><body style="font-family:Arial,sans-serif;margin:40px"><h2>Google Drive conectado</h2><p>Conta autorizada${out.accountEmail ? `: ${out.accountEmail}` : ''}.</p><p>Volte para o TronFire e clique em Testar envio.</p></body>`);
  } catch (err) {
    reply.code(400).type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>TronFire</title><body style="font-family:Arial,sans-serif;margin:40px"><h2>Falha ao conectar Google Drive</h2><p>${String(err.message || err).replace(/[<>&"]/g, '')}</p></body>`);
  }
});

app.get('/api/preflight', { preHandler: requireAuth }, async () => runPreflight());

app.get('/api/dashboard', { preHandler: requireAuth }, async (req) => {
  const [dbs, alerts, backups, metrics] = await Promise.all([
    prisma.managedDatabase.findMany({ orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] }),
    prisma.alert.findMany({ where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.backupJob.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { database: true } }),
    loadDashboardMetrics(reqQueryRange(req))
  ]);
  return { databases: dbs, alerts, backups: backups.map(j => ({ ...j, backupSize: j.backupSize?.toString() })), metrics };
});

function reqQueryRange(req) {
  return ['day', 'week', 'month'].includes(req?.query?.range) ? req.query.range : 'day';
}

app.get('/api/metrics/dashboard', { preHandler: requireAuth }, async (req) => loadDashboardMetrics(reqQueryRange(req)));

app.get('/api/alerts', { preHandler: requireAuth }, async (req) => {
  const status = String(req.query?.status || 'active');
  const where = {
    ...createdAtWhere(req.query),
    ...(status === 'active' ? { resolved: false } : status === 'resolved' ? { resolved: true } : {})
  };
  return prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, take: 250 });
});

app.patch('/api/alerts/:id/resolve', { preHandler: requireOperator }, async (req) => {
  const alert = await prisma.alert.update({ where: { id: req.params.id }, data: { resolved: true } });
  await audit(req, 'ALERT_RESOLVED', { entityType: 'alert', entityId: alert.id, details: { type: alert.type, severity: alert.severity } });
  return alert;
});

app.get('/api/services/firebird', { preHandler: requireOperator }, async () => {
  if (firebirdExecMode !== 'container') {
    try {
      const info = await tronsoftosRequest('/api/host/firebird');
      return { ...info, container: null, label: 'Servico Firebird no host' };
    } catch (err) {
      return {
        mode: 'host',
        container: null,
        service: process.env.FIREBIRD_SERVICE || 'firebird',
        status: 'unknown',
        details: `Falha consultando TronSoftOS: ${err.message}`,
        logs: '',
        label: 'Servico Firebird no host'
      };
    }
  }
  let status = 'unknown';
  let details = '';
  try {
    const { stdout } = await docker(['inspect', firebirdContainer, '--format', '{{.State.Status}}']);
    status = stdout.trim() || status;
  } catch (err) {
    details = err.message;
  }
  let logs = '';
  try {
    const out = await docker(['logs', '--tail', '120', firebirdContainer], { timeout: 120000, maxBuffer: 1024 * 1024 * 2 });
    logs = `${out.stdout || ''}${out.stderr || ''}`.trim();
  } catch (err) {
    logs = `Nao foi possivel ler logs do container: ${err.message}`;
  }
  return { mode: 'container', container: firebirdContainer, status, details, logs, label: 'Container Firebird geral' };
});

app.post('/api/services/firebird/:action', { preHandler: requireAdmin }, async (req, reply) => {
  const action = String(req.params.action || '').toLowerCase();
  if (!['start', 'stop', 'restart'].includes(action)) return reply.code(400).send({ error: 'Acao invalida' });
  if (firebirdExecMode !== 'container') {
    const result = await tronsoftosRequest(`/api/host/firebird/${action}`, { method: 'POST' });
    await audit(req, `FIREBIRD_HOST_${action.toUpperCase()}`, { entityType: 'service', entityId: result.service || 'firebird' });
    return result;
  }
  await docker([action, firebirdContainer], { timeout: action === 'restart' ? 180000 : 120000, maxBuffer: 1024 * 1024 * 2 });
  await audit(req, `FIREBIRD_CONTAINER_${action.toUpperCase()}`, { entityType: 'container', entityId: firebirdContainer });
  return { ok: true, action, container: firebirdContainer };
});

app.get('/api/logs', { preHandler: requireOperator }, async (req) => {
  const source = String(req.query?.source || 'all');
  const from = parseDateBoundary(req.query?.from);
  const to = parseDateBoundary(req.query?.to, true);
  const logs = [];

  if (['all', 'firebird'].includes(source) && fs.existsSync(firebirdLogsDir)) {
    for (const entry of fs.readdirSync(firebirdLogsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
      const filePath = path.join(firebirdLogsDir, entry.name);
      const stat = fs.statSync(filePath);
      if (from && stat.mtime < from) continue;
      if (to && stat.mtime > to) continue;
      logs.push({
        id: `firebird:${entry.name}`,
        source: 'firebird',
        name: entry.name,
        createdAt: stat.mtime,
        size: stat.size,
        preview: readTail(filePath)
      });
    }
  }

  if (['all', 'audit'].includes(source)) {
    const auditLogs = await prisma.auditLog.findMany({
      where: createdAtWhere(req.query),
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: true }
    });
    logs.push(...auditLogs.map(item => ({
      id: `audit:${item.id}`,
      source: 'audit',
      name: item.action,
      createdAt: item.createdAt,
      user: item.user?.name || null,
      details: item.details,
      preview: JSON.stringify({
        usuario: item.user?.name || 'sistema',
        acao: item.action,
        entidade: item.entityType,
        detalhes: item.details
      }, null, 2)
    })));
  }

  return logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 300);
});

app.get('/api/logs/firebird/:name', { preHandler: requireOperator }, async (req) => {
  const fileName = safeFirebirdLogName(req.params.name);
  const filePath = path.join(firebirdLogsDir, fileName);
  if (!filePath.startsWith(`${firebirdLogsDir}${path.sep}`) || !fs.existsSync(filePath)) throw new Error('Log nao encontrado');
  const stat = fs.statSync(filePath);
  return { name: fileName, size: stat.size, modifiedAt: stat.mtime, content: readTail(filePath, 80000) };
});

app.get('/api/logs/tail', { preHandler: requireOperator }, async (req, reply) => {
  const filePath = String(req.query?.path || '');
  if (!filePath.startsWith('/firebird/logs/') || !/\.log$/i.test(filePath)) {
    return reply.code(400).send({ error: 'Caminho de log invalido' });
  }
  if (!fs.existsSync(filePath)) return { exists: false, content: '' };
  const stat = fs.statSync(filePath);
  return { exists: true, size: stat.size, modifiedAt: stat.mtime, content: readTail(filePath, 80000) };
});

app.get('/api/databases', { preHandler: requireOperator }, async () => prisma.managedDatabase.findMany({ orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] }));

app.get('/api/databases/:id/connection', { preHandler: requireOperator }, async (req) => {
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.id } });
  return connectionInfoForDatabase(db, req);
});

app.post('/api/databases', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const body = req.body || {};
  const name = normalizeName(body.name);
  const alias = normalizeAlias(body.alias);
  const filePath = databasePathForAlias(alias);
  const existing = await prisma.managedDatabase.findFirst({
    where: { OR: [{ alias }, { filePath }] }
  });
  if (existing) {
    return reply.code(409).send({ error: `Banco ja cadastrado para o alias ${alias}` });
  }
  await ensureDatabaseFromTemplate(filePath);
  if (body.isPrimary) {
    await prisma.managedDatabase.updateMany({ where: { isPrimary: true }, data: { isPrimary: false, type: 'LEGADO_CONSULTA', accessMode: 'READ_ONLY' } });
  }
  const db = await prisma.managedDatabase.create({
    data: {
      name,
      alias,
      filePath,
      standbyPath: body.standbyPath || standbyPathForAlias(alias),
      standbyStatus: isHaMode() ? 'PENDING' : 'DISABLED',
      standbyRequiredForPromotion: body.standbyRequiredForPromotion !== false,
      type: body.type || 'HOMOLOGACAO',
      accessMode: body.accessMode || 'READ_WRITE',
      isPrimary: !!body.isPrimary,
      backupEnabled: !!body.backupEnabled,
      backupFrequencyMinutes: Number(body.backupFrequencyMinutes || 60),
      retentionDays: Number(body.retentionDays || 7)
    }
  });
  await syncFirebirdAliases();
  await audit(req, 'DATABASE_CREATED', { entityType: 'database', entityId: db.id, details: db });
  return reply.code(201).send(db);
});

app.post('/api/databases/sync-aliases', { preHandler: requireAdmin }, async () => {
  assertPrimaryWritable();
  await syncFirebirdAliases();
  return { ok: true };
});

app.post('/api/databases/:id/mark-primary', { preHandler: requireAdmin }, async (req) => {
  assertPrimaryWritable();
  const id = req.params.id;
  await prisma.managedDatabase.updateMany({ where: { isPrimary: true }, data: { isPrimary: false, type: 'LEGADO_CONSULTA', accessMode: 'READ_ONLY' } });
  const db = await prisma.managedDatabase.update({ where: { id }, data: { isPrimary: true, type: 'PRODUCAO', accessMode: 'READ_WRITE', backupEnabled: true } });
  await audit(req, 'DATABASE_MARKED_PRIMARY', { entityType: 'database', entityId: id });
  return db;
});

app.patch('/api/databases/:id/backup-settings', { preHandler: requireOperator }, async (req) => {
  const body = req.body || {};
  const backupFrequencyMinutes = Math.max(Number(body.backupFrequencyMinutes || 60), 1);
  const retentionDays = Math.max(Number(body.retentionDays || 7), 1);
  const db = await prisma.managedDatabase.update({
    where: { id: req.params.id },
    data: {
      backupEnabled: !!body.backupEnabled,
      backupFrequencyMinutes,
      retentionDays
    }
  });
  await audit(req, 'BACKUP_SETTINGS_UPDATED', { entityType: 'database', entityId: db.id, details: { backupEnabled: db.backupEnabled, backupFrequencyMinutes, retentionDays } });
  return db;
});

app.post('/api/databases/:id/validate', { preHandler: requireOperator }, async (req) => {
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.id } });
  try {
    await dockerExec(['sh','-lc',`test -f '${db.filePath}' && ${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat -h '${db.filePath}' >/tmp/tronfire_gstat.txt 2>&1`], { timeout: 120000 });
    const updated = await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ONLINE', lastCheckAt: new Date() } });
    await audit(req, 'DATABASE_VALIDATED', { entityType: 'database', entityId: db.id });
    return updated;
  } catch (err) {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
    return { ok: false, error: err.message };
  }
});

app.post('/api/databases/:id/online', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.id } });
  const logPath = `/firebird/logs/gfix_online_${db.alias}_${timestamp14()}.log`;
  try {
    const cmd = [
      'set -e',
      `db_file=${shQuote(db.filePath)}`,
      `db=${shQuote(firebirdDbConnect(db.filePath))}`,
      `log=${shQuote(logPath)}`,
      'test -f "$db_file"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gfix`)} -online -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$db" > "$log" 2>&1`,
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$db_file" >> "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 120000 });
    const updated = await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ONLINE', lastCheckAt: new Date() } });
    await audit(req, 'DATABASE_GFIX_ONLINE', { entityType: 'database', entityId: db.id, details: { logPath } });
    return { ok: true, database: updated, logPath };
  } catch (err) {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
    await audit(req, 'DATABASE_GFIX_ONLINE_FAILED', { entityType: 'database', entityId: db.id, details: { logPath, error: err.message } });
    return reply.code(500).send({ error: `Falha ao executar gfix -online: ${err.message}`, logPath });
  }
});

app.post('/api/databases/:id/integrity-check', { preHandler: requireOperator }, async (req, reply) => {
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.id } });
  const stamp = timestamp14();
  const logPath = `/firebird/logs/integrity_${db.alias}_${stamp}.log`;
  try {
    const cmd = [
      'set -e',
      `db_file=${shQuote(db.filePath)}`,
      `db=${shQuote(firebirdDbConnect(db.filePath))}`,
      `log=${shQuote(logPath)}`,
      'test -f "$db_file"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gfix`)} -v -full -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$db" > "$log" 2>&1`,
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$db_file" >> "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 20 });
    const updated = await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ONLINE', lastCheckAt: new Date() } });
    await audit(req, 'DATABASE_INTEGRITY_OK', { entityType: 'database', entityId: db.id, details: { logPath } });
    return { ok: true, database: updated, logPath };
  } catch (err) {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
    await createAlertOnce(`DATABASE_INTEGRITY_ERROR_${db.alias}`, 'CRITICAL', `Erro de integridade no banco ${db.name}`);
    await audit(req, 'DATABASE_INTEGRITY_ERROR', { entityType: 'database', entityId: db.id, details: { logPath, error: err.message } });
    return reply.code(500).send({ error: `Integridade com erro: ${err.message}`, logPath });
  }
});

app.post('/api/databases/:id/auto-maintenance', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.id } });
  const stamp = timestamp14();
  const rawBackupPath = `/firebird/backups/${db.alias}_maintenance_${stamp}.gbk`;
  const backupPath = `${rawBackupPath}.gz`;
  const manifestPath = `${backupPath}.manifest.json`;
  const safetyCopyPath = `/firebird/restore-work/${db.alias}_before_maintenance_${stamp}.fdb`;
  const repairedPath = `/firebird/restore-work/${db.alias}_repaired_${stamp}.fdb`;
  const logPath = `/firebird/logs/maintenance_${db.alias}_${stamp}.log`;
  const job = await prisma.backupJob.create({
    data: { databaseId: db.id, status: 'RUNNING', startedAt: new Date(), backupPath, manifestPath, sourceNode: process.env.TRONSOFTOS_NODE_NAME || null, targetAlias: db.alias, logPath }
  });

  try {
    const bin = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
    const password = shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey');
    const gfix = shQuote(`${bin}/gfix`);
    const gbak = shQuote(`${bin}/gbak`);
    const gstat = shQuote(`${bin}/gstat`);
    const cmd = [
      'set -e',
      `db_file=${shQuote(db.filePath)}`,
      `db=${shQuote(firebirdDbConnect(db.filePath))}`,
      `raw_backup=${shQuote(rawBackupPath)}`,
      `backup=${shQuote(backupPath)}`,
      `safety=${shQuote(safetyCopyPath)}`,
      `repaired=${shQuote(repairedPath)}`,
      `log=${shQuote(logPath)}`,
      'mkdir -p /firebird/backups /firebird/restore-work /firebird/logs',
      'test -f "$db_file"',
      'rm -f "$raw_backup" "$backup" "$repaired"',
      'echo "[1/7] Copia fisica de seguranca antes da manutencao" > "$log"',
      'cp -p "$db_file" "$safety"',
      'echo "[2/7] Colocando banco em modo manutencao, quando suportado" >> "$log"',
      `${gfix} -shut -force 0 -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      'echo "[3/7] Tentando corrigir paginas danificadas com gfix -mend" >> "$log"',
      `${gfix} -mend -full -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      'echo "[4/7] Gerando backup logico com gbak -g" >> "$log"',
      `${gbak} -b -g -v -user SYSDBA -password ${password} "$db" "$raw_backup" >> "$log" 2>&1`,
      'gzip -f "$raw_backup"',
      'echo "[5/7] Restaurando backup logico em arquivo temporario" >> "$log"',
      'restore_src="/tmp/tronfire_maintenance_${RANDOM}.gbk"',
      'gzip -dc "$backup" > "$restore_src"',
      `${gbak} -c -v -user SYSDBA -password ${password} "$restore_src" ${shQuote(firebirdCreateTarget(repairedPath))} >> "$log" 2>&1 || { cat "$log"; exit 66; }`,
      'rm -f "$restore_src"',
      'chmod 0666 "$repaired"',
      'echo "[6/7] Validando banco restaurado" >> "$log"',
      `${gstat} -h "$repaired" >> "$log" 2>&1 || { cat "$log"; exit 67; }`,
      'echo "[7/7] Substituindo banco original pelo restaurado validado" >> "$log"',
      'mv "$repaired" "$db_file"',
      'chmod 0666 "$db_file"',
      `${gfix} -online -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      `${gstat} -h "$db_file" >> "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const { stdout: sizeOut } = await dockerExec(['stat', '-c', '%s', backupPath]);
    const { stdout: shaOut } = await dockerExec(['sha256sum', backupPath]);
    const sha = shaOut.trim().split(/\s+/)[0];
    writeBackupManifest(db, backupPath, sha);
    await prisma.managedDatabase.update({
      where: { id: db.id },
      data: { status: 'ONLINE', lastCheckAt: new Date(), lastBackupAt: new Date() }
    });
    const done = await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), backupSize: BigInt(sizeOut.trim()), sha256: sha }
    });
    await syncFirebirdAliases();
    await audit(req, 'DATABASE_AUTO_MAINTENANCE_FINISHED', {
      entityType: 'database',
      entityId: db.id,
      details: { backupPath, safetyCopyPath, repairedPath, logPath }
    });
    const drive = await uploadBackupJobToExternal(req, db, job.id, backupPath);
    return {
      ok: true,
      databaseId: db.id,
      backupPath,
      backupSize: done.backupSize?.toString(),
      safetyCopyPath,
      logPath,
      drive
    };
  } catch (err) {
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: err.message }
    });
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
    await createAlertOnce(`DATABASE_AUTO_MAINTENANCE_FAILED_${db.alias}`, 'CRITICAL', `Manutencao automatica falhou: ${db.name}`);
    await audit(req, 'DATABASE_AUTO_MAINTENANCE_FAILED', {
      entityType: 'database',
      entityId: db.id,
      details: { backupPath, safetyCopyPath, repairedPath, logPath, error: err.message }
    });
    return reply.code(500).send({ error: err.message, backupPath, safetyCopyPath, logPath });
  }
});

app.post('/api/backups/:databaseId/run', { preHandler: requireOperator }, async (req) => {
  assertPrimaryWritable();
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.databaseId } });
  const stamp = safeLogToken(req.body?.logToken);
  const rawBackupPath = `/firebird/backups/${db.alias}_${stamp}.gbk`;
  const backupPath = `${rawBackupPath}.gz`;
  const manifestPath = `${backupPath}.manifest.json`;
  const logPath = `/firebird/logs/backup_${db.alias}_${stamp}.log`;
  const job = await prisma.backupJob.create({ data: { databaseId: db.id, status: 'RUNNING', startedAt: new Date(), backupPath, manifestPath, sourceNode: process.env.TRONSOFTOS_NODE_NAME || null, targetAlias: db.alias, logPath } });
  try {
    const cmd = `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gbak`)} -b -v -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} ${shQuote(firebirdDbConnect(db.filePath))} ${shQuote(rawBackupPath)} > ${shQuote(logPath)} 2>&1 && gzip -f ${shQuote(rawBackupPath)}`;
    await dockerExec(['sh','-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const { stdout: sizeOut } = await dockerExec(['stat','-c','%s', backupPath]);
    const { stdout: shaOut } = await dockerExec(['sha256sum', backupPath]);
    const sha = shaOut.trim().split(/\s+/)[0];
    writeBackupManifest(db, backupPath, sha);
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { lastBackupAt: new Date() } });
    const done = await prisma.backupJob.update({ where: { id: job.id }, data: { status: 'SUCCESS', finishedAt: new Date(), backupSize: BigInt(sizeOut.trim()), sha256: sha } });
    await audit(req, 'BACKUP_FINISHED', { entityType: 'backup', entityId: job.id, details: { database: db.alias } });
    const drive = await uploadBackupJobToExternal(req, db, job.id, backupPath);
    const updated = await prisma.backupJob.findUniqueOrThrow({ where: { id: job.id } });
    return { ...updated, backupSize: updated.backupSize?.toString(), drive };
  } catch (err) {
    await prisma.backupJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), errorMessage: err.message } });
    await prisma.alert.create({ data: { type: 'BACKUP_FAILED', severity: 'CRITICAL', message: `Backup falhou: ${db.name}` } });
    await audit(req, 'BACKUP_FAILED', { entityType: 'backup', entityId: job.id, details: { error: err.message } });
    throw err;
  }
});

app.get('/api/backups', { preHandler: requireOperator }, async () => {
  const jobs = await prisma.backupJob.findMany({ include: { database: true }, orderBy: { createdAt: 'desc' }, take: 50 });
  return jobs.map(j => ({ ...j, backupSize: j.backupSize?.toString() }));
});

app.get('/api/backups/cleanup/preview', { preHandler: requireOperator }, async (req) => {
  return backupCleanupCandidates(req.query || {});
});

app.post('/api/backups/cleanup', { preHandler: requireAdmin }, async (req) => {
  const preview = await backupCleanupCandidates(req.body || {});
  const deleted = [];
  const failed = [];
  for (const item of preview.candidates) {
    try {
      if (item.exists) fs.rmSync(item.backupPath, { force: true });
      await prisma.backupJob.delete({ where: { id: item.id } });
      deleted.push(item);
    } catch (err) {
      failed.push({ ...item, error: err.message });
    }
  }
  await audit(req, 'BACKUP_CLEANUP_EXECUTED', {
    entityType: 'backup',
    entityId: 'cleanup',
    details: {
      olderThanDays: preview.olderThanDays,
      keepLastPerDatabase: preview.keepLastPerDatabase,
      deleted: deleted.length,
      failed: failed.length,
      totalBytes: preview.totalBytes
    }
  });
  return { ok: failed.length === 0, deletedCount: deleted.length, failedCount: failed.length, totalBytes: preview.totalBytes, deleted, failed };
});

app.get('/api/backups/:id/download', { preHandler: requireOperator }, async (req, reply) => {
  const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: req.params.id } });
  if (job.status !== 'SUCCESS' || !job.backupPath) return reply.code(404).send({ error: 'Backup nao disponivel para download' });
  if (!job.backupPath.startsWith('/firebird/backups/') || !/\.(gbk|gbk\.gz)$/i.test(job.backupPath)) {
    return reply.code(400).send({ error: 'Caminho de backup invalido' });
  }
  if (!fs.existsSync(job.backupPath)) return reply.code(404).send({ error: 'Arquivo de backup nao encontrado' });
  const filename = path.basename(job.backupPath).replace(/[^a-zA-Z0-9_.-]/g, '_');
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(fs.createReadStream(job.backupPath));
});

app.get('/api/uploads', { preHandler: requireOperator }, async () => {
  const dir = '/firebird/uploads';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(gbk|fbk|gbk\.gz|fbk\.gz)$/i.test(entry.name))
    .map(entry => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime
      };
    })
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
});

app.post('/api/uploads/gbk', { preHandler: requireOperator }, async (req) => {
  const file = await req.file();
  if (!file) throw new Error('Arquivo não enviado');
  if (!/\.(gbk|fbk|gbk\.gz|fbk\.gz)$/i.test(file.filename)) throw new Error('Envie apenas .GBK, .FBK, .GBK.GZ ou .FBK.GZ');
  const safeName = file.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dest = `/firebird/uploads/${Date.now()}_${safeName}`;
  const hash = crypto.createHash('sha256');
  file.file.on('data', chunk => hash.update(chunk));
  await pipeline(file.file, fs.createWriteStream(dest));
  const digest = hash.digest('hex');
  await audit(req, 'GBK_UPLOADED', { details: { filename: file.filename, dest, sha256: digest } });
  return { ok: true, path: dest, sha256: digest };
});

app.post('/api/restores/from-upload', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const body = req.body || {};
  const sourcePath = assertUploadedBackupPath(body.uploadPath);
  const targetDb = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: body.databaseId } });
  const lockHandle = await acquireDatabaseOperationLock(req, targetDb, 'RESTORE', reply);
  if (reply.sent) return;
  const stamp = safeLogToken(body.logToken);
  const tempRestorePath = `/firebird/restore-work/${targetDb.alias}_restore_${stamp}.fdb`;
  const currentBackupPath = `/firebird/restore-work/${targetDb.alias}_before_restore_${stamp}.fdb`;
  const logPath = `/firebird/logs/restore_${targetDb.alias}_${stamp}.log`;

  try {
    const cmd = [
      'set -e',
      `src=${shQuote(sourcePath)}`,
      `temp_dest=${shQuote(tempRestorePath)}`,
      `target=${shQuote(targetDb.filePath)}`,
      `current_backup=${shQuote(currentBackupPath)}`,
      `log=${shQuote(logPath)}`,
      'test -f "$src"',
      'rm -f "$temp_dest"',
      'restore_src="$src"',
      'case "$src" in *.gz) restore_src="/tmp/tronfire_restore_${RANDOM}.gbk"; gzip -dc "$src" > "$restore_src" ;; esac',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gbak`)} -c -v -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$restore_src" ${shQuote(firebirdCreateTarget(tempRestorePath))} > "$log" 2>&1 || { cat "$log"; exit 66; }`,
      'if [ "$restore_src" != "$src" ]; then rm -f "$restore_src"; fi',
      'chmod 0666 "$temp_dest"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$temp_dest" >> "$log" 2>&1 || { cat "$log"; exit 67; }`,
      'test -f "$target" && cp "$target" "$current_backup"',
      'mv "$temp_dest" "$target"',
      'chmod 0666 "$target"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$target" >> "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const db = await prisma.managedDatabase.update({
      where: { id: targetDb.id },
      data: {
        status: 'ONLINE',
        lastCheckAt: new Date()
      }
    });
    await syncFirebirdAliases();
    await audit(req, 'RESTORE_FINISHED', { entityType: 'database', entityId: db.id, details: { targetDatabaseId: targetDb.id, sourcePath, targetPath: targetDb.filePath, currentBackupPath, logPath } });
    return reply.code(200).send({ ok: true, database: db, sourcePath, targetPath: targetDb.filePath, currentBackupPath, logPath });
  } catch (err) {
    await prisma.alert.create({ data: { type: 'RESTORE_FAILED', severity: 'CRITICAL', message: `Restore falhou: ${targetDb.name}` } });
    await audit(req, 'RESTORE_FAILED', { entityType: 'database', entityId: targetDb.id, details: { sourcePath, targetPath: targetDb.filePath, tempRestorePath, logPath, error: err.message } });
    return reply.code(500).send({ error: err.message, logPath });
  } finally {
    await lockHandle.release();
  }
});

app.get('/api/ha/status', async () => {
  const databases = await prisma.managedDatabase.findMany({
    where: { type: { not: 'ARQUIVADO' } },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }]
  });
  let clusterLock = null;
  if (fs.existsSync(clusterLockPath)) {
    try { clusterLock = JSON.parse(fs.readFileSync(clusterLockPath, 'utf8')); }
    catch (err) { clusterLock = { error: err.message }; }
  }
  return {
    ok: true,
    deploymentMode,
    nodeRole,
    firebirdExecMode: process.env.FIREBIRD_EXEC_MODE || 'container',
    clusterLockPath,
    clusterLock,
    databases: databases.map(db => ({
      id: db.id,
      name: db.name,
      alias: db.alias,
      productionPath: db.filePath,
      standbyPath: db.standbyPath || standbyPathForAlias(db.alias),
      standbyStatus: db.standbyStatus,
      standbyRequiredForPromotion: db.standbyRequiredForPromotion,
      lastStandbyBackupAt: db.lastStandbyBackupAt,
      lastStandbyValidatedAt: db.lastStandbyValidatedAt,
      lastStandbyBackupSha256: db.lastStandbyBackupSha256
    }))
  };
});

app.post('/api/ha/standby/restore', async (req, reply) => {
  assertInternalTronsoftos(req);
  if (!isHaMode() || nodeRole === 'primary') {
    return reply.code(409).send({ error: 'Restore standby permitido apenas em no HA standby/recovery' });
  }
  const body = req.body || {};
  const sourcePath = String(body.backupPath || '').trim();
  if (!isReceivedBackupPath(sourcePath)) return reply.code(400).send({ error: 'backupPath invalido' });
  const manifest = body.manifestPath ? readBackupManifest(body.manifestPath) : null;
  const alias = normalizeAlias(body.databaseAlias || manifest?.databaseAlias || path.basename(sourcePath).split('_').slice(0, -1).join('_'));
  const db = await prisma.managedDatabase.findUnique({ where: { alias } });
  if (!db) return reply.code(404).send({ error: `Banco nao cadastrado para alias ${alias}` });

  const stamp = safeLogToken(body.logToken);
  const standbyPath = db.standbyPath || standbyPathForAlias(db.alias);
  const tempRestorePath = `/firebird/restore-work/${db.alias}_standby_restore_${stamp}.fdb`;
  const logPath = `/firebird/logs/standby_restore_${db.alias}_${stamp}.log`;

  try {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { standbyStatus: 'RESTORING' } });
    const cmd = [
      'set -e',
      `src=${shQuote(sourcePath)}`,
      `temp_dest=${shQuote(tempRestorePath)}`,
      `standby=${shQuote(standbyPath)}`,
      `log=${shQuote(logPath)}`,
      'mkdir -p /firebird/standby /firebird/restore-work /firebird/logs',
      'test -f "$src"',
      'rm -f "$temp_dest"',
      'restore_src="$src"',
      'case "$src" in *.gz) restore_src="/tmp/tronfire_standby_restore_${RANDOM}.gbk"; gzip -dc "$src" > "$restore_src" ;; esac',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gbak`)} -c -v -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$restore_src" ${shQuote(firebirdCreateTarget(tempRestorePath))} > "$log" 2>&1 || { cat "$log"; exit 66; }`,
      'if [ "$restore_src" != "$src" ]; then rm -f "$restore_src"; fi',
      'chmod 0666 "$temp_dest"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$temp_dest" >> "$log" 2>&1 || { cat "$log"; exit 67; }`,
      'mv "$temp_dest" "$standby"',
      'chmod 0666 "$standby"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$standby" >> "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const sha = manifest?.backupSha256 || null;
    const updated = await prisma.managedDatabase.update({
      where: { id: db.id },
      data: {
        standbyPath,
        standbyStatus: 'READY',
        lastStandbyBackupAt: manifest?.backupFinishedAt ? new Date(manifest.backupFinishedAt) : new Date(),
        lastStandbyValidatedAt: new Date(),
        lastStandbyBackupSha256: sha
      }
    });
    await audit(req, 'HA_STANDBY_RESTORED', { entityType: 'database', entityId: db.id, details: { sourcePath, manifestPath: body.manifestPath || null, standbyPath, logPath } });
    return { ok: true, database: updated, standbyPath, logPath };
  } catch (err) {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { standbyStatus: 'INVALID' } });
    await audit(req, 'HA_STANDBY_RESTORE_FAILED', { entityType: 'database', entityId: db.id, details: { sourcePath, standbyPath, logPath, error: err.message } });
    return reply.code(500).send({ error: err.message, logPath });
  }
});

app.post('/api/ha/standby/validate', async (req, reply) => {
  assertInternalTronsoftos(req);
  const alias = normalizeAlias(req.body?.databaseAlias);
  const db = await prisma.managedDatabase.findUnique({ where: { alias } });
  if (!db) return reply.code(404).send({ error: `Banco nao cadastrado para alias ${alias}` });
  const standbyPath = db.standbyPath || standbyPathForAlias(db.alias);
  const logPath = `/firebird/logs/standby_validate_${db.alias}_${timestamp14()}.log`;
  try {
    const cmd = [
      'set -e',
      `db=${shQuote(standbyPath)}`,
      `log=${shQuote(logPath)}`,
      'test -f "$db"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$db" > "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 120000 });
    const updated = await prisma.managedDatabase.update({ where: { id: db.id }, data: { standbyStatus: 'READY', lastStandbyValidatedAt: new Date() } });
    await audit(req, 'HA_STANDBY_VALIDATED', { entityType: 'database', entityId: db.id, details: { standbyPath, logPath } });
    return { ok: true, database: updated, standbyPath, logPath };
  } catch (err) {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { standbyStatus: 'INVALID' } });
    return reply.code(500).send({ error: err.message, logPath });
  }
});

app.post('/api/ha/standby/promote', async (req, reply) => {
  assertInternalTronsoftos(req);
  if (!isHaMode() || !['standby', 'recovery'].includes(nodeRole)) {
    return reply.code(409).send({ error: 'Promocao permitida apenas em no HA standby/recovery' });
  }
  if (req.body?.confirmation !== 'PROMOTE_STANDBY') {
    return reply.code(400).send({ error: 'Confirmacao explicita PROMOTE_STANDBY obrigatoria' });
  }
  const lock = readClusterLock();
  if (!lock.allow_promotion) return reply.code(409).send({ error: 'cluster-lock nao permite promocao' });
  if (lock.this_node && process.env.TRONSOFTOS_NODE_NAME && lock.this_node !== process.env.TRONSOFTOS_NODE_NAME) {
    return reply.code(409).send({ error: 'cluster-lock pertence a outro no', lock });
  }

  const dbs = await prisma.managedDatabase.findMany({
    where: { type: { not: 'ARQUIVADO' }, standbyRequiredForPromotion: true },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }]
  });
  const notReady = dbs.filter(db => db.standbyStatus !== 'READY' || !db.standbyPath);
  if (notReady.length) {
    return reply.code(409).send({ error: 'Nem todos os bancos obrigatorios estao prontos para promocao', databases: notReady.map(db => ({ alias: db.alias, standbyStatus: db.standbyStatus })) });
  }

  const stamp = timestamp14();
  const promoted = [];
  for (const db of dbs) {
    const backupCurrent = `/firebird/restore-work/${db.alias}_before_promote_${stamp}.fdb`;
    const logPath = `/firebird/logs/promote_${db.alias}_${stamp}.log`;
    const cmd = [
      'set -e',
      `prod=${shQuote(db.filePath)}`,
      `standby=${shQuote(db.standbyPath)}`,
      `backup_current=${shQuote(backupCurrent)}`,
      `log=${shQuote(logPath)}`,
      'mkdir -p /firebird/data /firebird/restore-work /firebird/logs',
      'test -f "$standby"',
      'if [ -f "$prod" ]; then mv "$prod" "$backup_current"; fi',
      'mv "$standby" "$prod"',
      'chmod 0666 "$prod"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$prod" > "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 20 });
    await prisma.managedDatabase.update({
      where: { id: db.id },
      data: { standbyStatus: 'PROMOTED', status: 'ONLINE', lastCheckAt: new Date(), accessMode: 'READ_WRITE' }
    });
    promoted.push({ alias: db.alias, productionPath: db.filePath, previousProductionBackup: backupCurrent, logPath });
  }
  await syncFirebirdAliases();
  await audit(req, 'HA_STANDBY_PROMOTED', { entityType: 'cluster', entityId: lock.cluster || 'cluster', details: { lock, promoted } });
  return { ok: true, promoted, lock };
});

app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
  const { name, email, password, role } = req.body || {};
  const user = await prisma.user.create({ data: { name, email: String(email).toLowerCase(), passwordHash: await hashPassword(password), role: role || 'TECNICO' } });
  await audit(req, 'USER_CREATED', { entityType: 'user', entityId: user.id });
  return { id: user.id, name: user.name, email: user.email, role: user.role };
});

app.get('/api/audit', { preHandler: requireAdmin }, async () => prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { user: true } }));

app.setErrorHandler((error, req, reply) => {
  req.log.error(error);
  reply.code(error.statusCode || 500).send({ error: error.message || 'Erro interno' });
});

await app.listen({ host: '0.0.0.0', port: 8080 });
