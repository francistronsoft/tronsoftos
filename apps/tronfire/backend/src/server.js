import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
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

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 1024 });
const storageRoot = process.env.STORAGE_ROOT || '/opt/tronsoftOS/storage/tronfire';
const defaultTemplatePath = process.env.FIREBIRD_TEMPLATE_PATH || '/firebird/templates/template.fdb';
const firebirdPort = process.env.TRONFIRE_FIREBIRD_PORT || '3050';
const firebirdContainer = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
const firebirdLogsDir = '/firebird/logs';
const deploymentMode = String(process.env.TRONFIRE_DEPLOYMENT_MODE || 'simple').toLowerCase();
const nodeRole = String(process.env.TRONFIRE_NODE_ROLE || 'primary').toLowerCase();
const clusterLockPath = process.env.TRONSOFTOS_CLUSTER_LOCK || '/opt/tronsoftos/state/cluster-lock.json';
const clusterSecretsPath = process.env.TRONSOFTOS_CLUSTER_SECRETS || path.join(path.dirname(clusterLockPath), 'cluster-secrets.env');
const firebirdExecMode = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
const tronsoftosApiUrl = String(process.env.TRONSOFTOS_API_URL || 'http://host.docker.internal:8080').replace(/\/+$/, '');
const firebirdInternalHost = process.env.FIREBIRD_HOST || 'host.docker.internal';
const defaultProductionAlias = 'erp_tronsoft';

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

function isProductionDatabaseRequest(body = {}) {
  return body.isPrimary === true || String(body.type || '').toUpperCase() === 'PRODUCAO';
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

function backupValidationFor(logPath) {
  return {
    ok: true,
    method: 'gbak-restore-gstat',
    validatedAt: new Date().toISOString(),
    logPath
  };
}

function shellErrorText(err) {
  return [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim() || String(err);
}

function isHaMode() {
  return deploymentMode === 'ha';
}

function isPrimaryNode() {
  return nodeRole === 'primary';
}

function standbyReadPathForDatabase(db) {
  if (!isHaMode() || !['standby', 'recovery'].includes(nodeRole)) return '';
  if (!['READY', 'RESTORING'].includes(String(db.standbyStatus || '').toUpperCase())) return '';
  return db.standbyPath || standbyPathForAlias(db.alias);
}

function effectiveDatabasePath(db) {
  return standbyReadPathForDatabase(db) || db.filePath;
}

function assertPrimaryWritable() {
  if (isHaMode() && !isPrimaryNode()) {
    const error = new Error(`Operacao bloqueada: no TronFire em modo ${nodeRole}`);
    error.statusCode = 409;
    error.code = 'TRONFIRE_NODE_NOT_PRIMARY';
    throw error;
  }
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

function internalTokenValue() {
  return parseEnvFile(clusterSecretsPath).TRONSOFTOS_INTERNAL_TOKEN || process.env.TRONSOFTOS_INTERNAL_TOKEN || '';
}

function assertInternalTronsoftos(req) {
  const internalToken = internalTokenValue();
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
  const internalToken = internalTokenValue();
  const headers = { ...(options.headers || {}) };
  if (internalToken) headers['x-tronsoftos-token'] = internalToken;
  const url = new URL(pathname, `${tronsoftosApiUrl}/`);
  const payload = options.body || null;
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 0
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (err) {
          err.message = `Resposta invalida do TronSoftOS: ${err.message}`;
          return reject(err);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(body.error || `TronSoftOS HTTP ${res.statusCode}`);
          error.payload = body;
          error.status = res.statusCode;
          return reject(error);
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout comunicando com TronSoftOS')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runHostFirebirdScript(script, timeoutMs = 1000 * 60 * 60 * 4) {
  return tronsoftosRequest('/api/host/firebird/script', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script, timeoutMs }),
    timeoutMs: timeoutMs + 60_000
  });
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

function normalizeReceivedBackupPath(filePath) {
  const value = String(filePath || '').trim();
  const storagePrefix = `${storageRoot.replace(/\/+$/, '')}/firebird/backups/`;
  if (value.startsWith(storagePrefix)) return `/firebird/backups/${value.slice(storagePrefix.length)}`;
  return value;
}

function normalizeReceivedManifestPath(filePath) {
  const value = String(filePath || '').trim();
  const storagePrefix = `${storageRoot.replace(/\/+$/, '')}/firebird/backups/`;
  if (value.startsWith(storagePrefix)) return `/firebird/backups/${value.slice(storagePrefix.length)}`;
  return value;
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
    lines.push(`${db.alias} = ${effectiveDatabasePath(db)}`);
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
  const path = effectiveDatabasePath(db);
  const usingStandbyPath = path !== db.filePath;
  return {
    databaseId: db.id,
    name: db.name,
    alias: db.alias,
    nodeRole,
    deploymentMode,
    host,
    port,
    path,
    productionPath: db.filePath,
    standbyPath: db.standbyPath || standbyPathForAlias(db.alias),
    usingStandbyPath,
    pathRole: usingStandbyPath ? 'standby_read_only' : 'production',
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

const databaseOperationTtlMs = 1000 * 60 * 60 * 6;

function databaseOperationActive(db, now = new Date()) {
  if (String(db.operationStatus || 'IDLE').toUpperCase() !== 'RUNNING') return false;
  if (!db.operationExpiresAt) return true;
  return new Date(db.operationExpiresAt) > now;
}

function databaseOperationPayload(db) {
  return {
    databaseId: db.id,
    databaseName: db.name,
    operationStatus: db.operationStatus || 'IDLE',
    operationKind: db.operationKind || null,
    operationToken: db.operationToken || null,
    operationStartedAt: db.operationStartedAt || null,
    operationExpiresAt: db.operationExpiresAt || null,
    operationMessage: db.operationMessage || null
  };
}

async function clearExpiredDatabaseOperation(db) {
  const now = new Date();
  if (!db?.id || !db.operationExpiresAt || String(db.operationStatus || 'IDLE').toUpperCase() !== 'RUNNING') return db;
  if (new Date(db.operationExpiresAt) > now) return db;
  return prisma.managedDatabase.update({
    where: { id: db.id },
    data: {
      operationStatus: 'IDLE',
      operationKind: null,
      operationToken: null,
      operationStartedAt: null,
      operationExpiresAt: null,
      operationMessage: null
    }
  });
}

async function requestHaProtectionForDatabaseOperation(db, operation) {
  if (!isHaMode() || nodeRole !== 'primary') return null;
  const reason = `${operation} em andamento no banco ${db.alias}`;
  const calls = [
    ['block-promotion', '/api/cluster/promotion/block', { reason }],
    ['stop-standby-failover', '/api/maintenance/standby/keepalived/stop', { confirmation: 'SUSPENDER STANDBY', reason }]
  ];
  const results = [];
  for (const [name, endpoint, body] of calls) {
    try {
      const response = await fetch(`${tronsoftosApiUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      });
      results.push({ name, ok: response.ok, status: response.status });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  if (results.some(item => item.ok === false)) {
    await createAlertOnce(`HA_OPERATION_PROTECTION_FAILED_${db.alias}`, 'WARNING', `Nao foi possivel confirmar protecao HA automatica para ${db.name}`);
  }
  return results;
}

async function replyIfDatabaseOperationActive(db, reply, message = null) {
  const fresh = await clearExpiredDatabaseOperation(db);
  if (databaseOperationActive(fresh)) {
    return reply.code(409).send({
      error: message || `Ja existe uma operacao em andamento para o banco ${fresh.name}. Aguarde finalizar antes de iniciar outra operacao.`,
      code: 'DATABASE_OPERATION_IN_PROGRESS',
      operation: databaseOperationPayload(fresh)
    });
  }
  return null;
}

async function acquireDatabaseOperationLock(req, db, operation, reply, options = {}) {
  const fresh = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: db.id } });
  if (databaseOperationActive(await clearExpiredDatabaseOperation(fresh))) {
    const current = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: db.id } });
    if (options.existingToken && current.operationToken === options.existingToken && current.operationKind === operation) {
      const refreshed = await prisma.managedDatabase.update({
        where: { id: current.id },
        data: {
          operationMessage: options.message || current.operationMessage,
          operationExpiresAt: new Date(Date.now() + databaseOperationTtlMs)
        }
      });
      const lock = {
        token: refreshed.operationToken,
        operation,
        databaseId: refreshed.id,
        databaseName: refreshed.name,
        user: req.user?.name || req.user?.email || 'desconhecido',
        startedAt: refreshed.operationStartedAt?.toISOString?.() || null,
        expiresAt: refreshed.operationExpiresAt?.toISOString?.() || null
      };
      return operationLockHandle(current, refreshed, lock, null);
    }
    return reply.code(409).send({
      error: `Ja existe uma operacao em andamento para o banco ${current.name}. Aguarde finalizar antes de iniciar ${operation.toLowerCase()}.`,
      code: 'DATABASE_OPERATION_IN_PROGRESS',
      operation: databaseOperationPayload(current)
    }) && null;
  }
  const runningBackup = await prisma.backupJob.findFirst({
    where: { databaseId: db.id, status: 'RUNNING' },
    orderBy: { startedAt: 'desc' }
  });
  if (runningBackup) {
    reply.code(409).send({
      error: `Existe backup em andamento para o banco ${fresh.name}. Aguarde finalizar antes de iniciar ${operation.toLowerCase()}.`,
      code: 'DATABASE_BACKUP_IN_PROGRESS',
      databaseId: fresh.id,
      databaseName: fresh.name,
      runningBackup: {
        id: runningBackup.id,
        status: runningBackup.status,
        startedAt: runningBackup.startedAt,
        backupPath: runningBackup.backupPath,
        logPath: runningBackup.logPath
      }
    });
    return null;
  }
  const now = new Date();
  const token = options.token || makeToken();
  const lock = {
    token,
    operation,
    databaseId: fresh.id,
    databaseName: fresh.name,
    user: req.user?.name || req.user?.email || 'desconhecido',
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + databaseOperationTtlMs).toISOString()
  };
  const data = {
    operationStatus: 'RUNNING',
    operationKind: operation,
    operationToken: token,
    operationStartedAt: now,
    operationExpiresAt: new Date(now.getTime() + databaseOperationTtlMs),
    operationMessage: options.message || `${operation} em andamento`
  };
  if (options.markStandbyMaintenance !== false && isHaMode() && nodeRole === 'primary') {
    data.standbyStatus = 'MAINTENANCE';
  }
  const lockedDb = await prisma.managedDatabase.update({ where: { id: fresh.id }, data });
  const haProtection = options.markStandbyMaintenance !== false
    ? await requestHaProtectionForDatabaseOperation(fresh, operation)
    : null;
  return operationLockHandle(fresh, lockedDb, lock, haProtection);
}

function operationLockHandle(previousDatabase, database, lock, haProtection) {
  return {
    lock,
    previousDatabase,
    database,
    haProtection,
    release: async () => {
      const latest = await prisma.managedDatabase.findUnique({ where: { id: database.id } });
      if (latest?.operationToken === lock.token) {
        await prisma.managedDatabase.update({
          where: { id: database.id },
          data: {
            operationStatus: 'IDLE',
            operationKind: null,
            operationToken: null,
            operationStartedAt: null,
            operationExpiresAt: null,
            operationMessage: null
          }
        }).catch(() => {});
      }
    },
    releaseWith: async (extraData = {}) => {
      const latest = await prisma.managedDatabase.findUnique({ where: { id: database.id } });
      if (latest?.operationToken === lock.token) {
        await prisma.managedDatabase.update({
          where: { id: database.id },
          data: {
            ...extraData,
            operationStatus: 'IDLE',
            operationKind: null,
            operationToken: null,
            operationStartedAt: null,
            operationExpiresAt: null,
            operationMessage: null
          }
        }).catch(() => {});
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

function backupManifestFor(db, backupPath, sha, validation = null) {
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
    standbyPath: db.standbyPath || standbyPathForAlias(db.alias),
    validation
  };
}

function writeBackupManifest(db, backupPath, sha, validation = null) {
  const manifestPath = `${backupPath}.manifest.json`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(backupManifestFor(db, backupPath, sha, validation), null, 2)}\n`);
  return manifestPath;
}

function readBackupManifest(manifestPath) {
  const value = String(manifestPath || '').trim();
  if (!value.startsWith('/firebird/backups/') || !value.endsWith('.manifest.json')) {
    throw new Error('Manifesto de backup invalido');
  }
  return JSON.parse(fs.readFileSync(value, 'utf8'));
}

function backupValidationStatus(job) {
  try {
    if (!job.manifestPath || !fs.existsSync(job.manifestPath)) return null;
    return readBackupManifest(job.manifestPath).validation || null;
  } catch {
    return null;
  }
}

async function uploadBackupJobToExternal(req, db, jobId, backupPath) {
  await prisma.backupJob.update({
    where: { id: jobId },
    data: { driveStatus: 'TRONSOFTOS', driveErrorMessage: null }
  });
  await audit(req, 'BACKUP_EXTERNAL_MANAGED_BY_TRONSOFTOS', { entityType: 'backup', entityId: jobId, details: { database: db.alias, backupPath } });
  return { skipped: true, managedBy: 'TronSoftOS' };
}

async function validateBackupRestore(db, backupPath, logPath, token = timestamp14()) {
  const bin = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
  const password = shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey');
  const gbak = shQuote(`${bin}/gbak`);
  const gstat = shQuote(`${bin}/gstat`);
  const tempRestorePath = `/firebird/restore-work/${db.alias}_backup_validate_${token}.fdb`;
  const cmd = [
    'set -e',
    `backup=${shQuote(backupPath)}`,
    `restore=${shQuote(tempRestorePath)}`,
    `log=${shQuote(logPath)}`,
    'fail() { code="$1"; shift; echo "$*" >> "$log"; test -f "$log" && cat "$log"; exit "$code"; }',
    'mkdir -p /firebird/restore-work /firebird/logs',
    'test -f "$backup" || fail 80 "Backup nao encontrado para validacao: $backup"',
    'rm -f "$restore"',
    'echo "[validacao] restaurando backup em area temporaria" >> "$log"',
    'restore_src="$backup"',
    'case "$backup" in *.gz) restore_src="/tmp/tronfire_backup_validate_${RANDOM}.gbk"; gzip -dc "$backup" > "$restore_src" || fail 81 "Falha ao descompactar backup para validacao" ;; esac',
    `${gbak} -c -v -user SYSDBA -password ${password} "$restore_src" ${shQuote(firebirdCreateTarget(tempRestorePath))} >> "$log" 2>&1 || fail 82 "Falha ao restaurar backup para validacao"`,
    'if [ "$restore_src" != "$backup" ]; then rm -f "$restore_src" || true; fi',
    'test -f "$restore" || fail 83 "Restore de validacao terminou sem arquivo restaurado"',
    `${gstat} -h "$restore" >> "$log" 2>&1 || fail 84 "Falha no gstat do backup restaurado"`,
    'rm -f "$restore"',
    'echo "[validacao] backup aprovado" >> "$log"'
  ].join('; ');
  await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
  return backupValidationFor(logPath);
}

function quarantineInvalidBackup(backupPath, manifestPath = null) {
  const moved = [];
  try {
    fs.mkdirSync('/firebird/quarantine', { recursive: true });
    for (const filePath of [backupPath, manifestPath].filter(Boolean)) {
      if (!fs.existsSync(filePath)) continue;
      const target = `/firebird/quarantine/${path.basename(filePath)}`;
      fs.renameSync(filePath, target);
      moved.push(target);
    }
  } catch {
    // Keep the original error path; quarantine is best effort.
  }
  return moved;
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
  return {
    enabled: false,
    connected: false,
    managedBy: 'TronSoftOS',
    message: 'Backup em nuvem gerenciado pelo TronSoftOS'
  };
});

app.patch('/api/settings/google-drive', { preHandler: requireOperator }, async () => {
  return {
    enabled: false,
    connected: false,
    managedBy: 'TronSoftOS',
    message: 'Backup em nuvem gerenciado pelo TronSoftOS'
  };
});

app.post('/api/settings/google-drive/test', { preHandler: requireOperator }, async () => {
  return { ok: false, managedBy: 'TronSoftOS', message: 'Teste rclone/Google Drive deve ser feito no TronSoftOS' };
});

app.post('/api/settings/google-drive/oauth/start', { preHandler: requireOperator }, async (req, reply) => {
  return reply.code(410).send({ error: 'Google Drive e rclone agora sao configurados no TronSoftOS' });
});

app.get('/api/settings/google-drive/oauth/callback', async (req, reply) => {
  reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>TronFire</title><body style="font-family:Arial,sans-serif;margin:40px"><h2>Google Drive gerenciado pelo TronSoftOS</h2><p>Configure o backup em nuvem no painel TronSoftOS.</p></body>');
});

app.get('/api/preflight', { preHandler: requireAuth }, async () => runPreflight());

app.get('/api/dashboard', { preHandler: requireAuth }, async (req) => {
  const [dbs, alerts, backups, metrics] = await Promise.all([
    prisma.managedDatabase.findMany({ orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] }),
    prisma.alert.findMany({ where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.backupJob.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { database: true } }),
    loadDashboardMetrics(reqQueryRange(req))
  ]);
  return {
    databases: dbs,
    alerts,
    backups: backups.map(j => ({ ...j, backupSize: j.backupSize?.toString() })),
    metrics,
    ha: { deploymentMode, nodeRole }
  };
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

app.get('/api/internal/alerts', async (req) => {
  assertInternalTronsoftos(req);
  return prisma.alert.findMany({ where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 20 });
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
  const isProduction = isProductionDatabaseRequest(body);
  const productionCount = await prisma.managedDatabase.count({
    where: {
      OR: [
        { isPrimary: true },
        { type: 'PRODUCAO' }
      ]
    }
  });
  const requestedAlias = normalizeAlias(body.alias || (isProduction && productionCount === 0 ? defaultProductionAlias : ''));
  if (isProduction && productionCount === 0 && requestedAlias !== defaultProductionAlias) {
    return reply.code(400).send({ error: `O primeiro banco de producao deve usar obrigatoriamente o alias ${defaultProductionAlias}` });
  }
  const alias = isProduction && productionCount === 0 ? defaultProductionAlias : requestedAlias;
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
      backupFrequencyMinutes: Number(body.backupFrequencyMinutes || 20),
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
  const target = await prisma.managedDatabase.findUniqueOrThrow({ where: { id } });
  const productionCount = await prisma.managedDatabase.count({
    where: {
      id: { not: id },
      OR: [
        { isPrimary: true },
        { type: 'PRODUCAO' }
      ]
    }
  });
  if (productionCount === 0 && target.alias !== defaultProductionAlias) {
    throw new Error(`O primeiro banco de producao deve usar obrigatoriamente o alias ${defaultProductionAlias}`);
  }
  await prisma.managedDatabase.updateMany({ where: { isPrimary: true }, data: { isPrimary: false, type: 'LEGADO_CONSULTA', accessMode: 'READ_ONLY' } });
  const db = await prisma.managedDatabase.update({ where: { id }, data: { isPrimary: true, type: 'PRODUCAO', accessMode: 'READ_WRITE', backupEnabled: true } });
  await audit(req, 'DATABASE_MARKED_PRIMARY', { entityType: 'database', entityId: id });
  return db;
});

app.patch('/api/databases/:id/backup-settings', { preHandler: requireOperator }, async (req) => {
  const body = req.body || {};
  const backupFrequencyMinutes = Math.max(Number(body.backupFrequencyMinutes || 20), 1);
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
  const targetPath = effectiveDatabasePath(db);
  try {
    await dockerExec(['sh','-lc',`test -f ${shQuote(targetPath)} && ${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h ${shQuote(targetPath)} >/tmp/tronfire_gstat.txt 2>&1`], { timeout: 120000 });
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
  const databaseSizeBefore = fs.existsSync(db.filePath) ? fs.statSync(db.filePath).size : null;
  const lockHandle = await acquireDatabaseOperationLock(req, db, 'AUTO_MAINTENANCE', reply, {
    message: 'Manutencao automatica em andamento'
  });
  if (reply.sent) return;
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
      'fail() { code="$1"; shift; echo "$*"; test -f "$log" && cat "$log"; exit "$code"; }',
      'mkdir -p /firebird/backups /firebird/restore-work /firebird/logs',
      'test -f "$db_file" || fail 60 "Banco de origem nao encontrado: $db_file"',
      'rm -f "$raw_backup" "$backup" "$repaired" || fail 61 "Nao foi possivel limpar arquivos temporarios da manutencao"',
      'echo "[1/7] Copia fisica de seguranca antes da manutencao" > "$log"',
      'cp -p "$db_file" "$safety" || fail 62 "Nao foi possivel criar copia fisica de seguranca: $safety"',
      'echo "[2/7] Colocando banco em modo manutencao, quando suportado" >> "$log"',
      `${gfix} -shut -force 0 -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      'echo "[3/7] Tentando corrigir paginas danificadas com gfix -mend" >> "$log"',
      `${gfix} -mend -full -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      'echo "[4/7] Gerando backup logico com gbak -g" >> "$log"',
      `${gbak} -b -g -v -user SYSDBA -password ${password} "$db" "$raw_backup" >> "$log" 2>&1 || fail 63 "Falha ao gerar backup logico de manutencao"`,
      'gzip -f "$raw_backup" || fail 64 "Falha ao compactar backup de manutencao"',
      'echo "[5/7] Restaurando backup logico em arquivo temporario" >> "$log"',
      'restore_src="/tmp/tronfire_maintenance_${RANDOM}.gbk"',
      'gzip -dc "$backup" > "$restore_src" || fail 65 "Falha ao descompactar backup de manutencao"',
      `${gbak} -c -v -user SYSDBA -password ${password} "$restore_src" ${shQuote(firebirdCreateTarget(repairedPath))} >> "$log" 2>&1 || fail 66 "Falha ao restaurar banco reparado"`,
      'rm -f "$restore_src"',
      'test -f "$repaired" || fail 67 "Restore terminou, mas banco reparado nao foi encontrado: $repaired"',
      'chmod 0666 "$repaired" || fail 68 "Nao foi possivel ajustar permissao do banco reparado"',
      'echo "[6/7] Validando banco restaurado" >> "$log"',
      `${gstat} -h "$repaired" >> "$log" 2>&1 || fail 69 "Falha ao validar banco reparado com gstat"`,
      'echo "[7/7] Substituindo banco original pelo restaurado validado" >> "$log"',
      `${gfix} -shut -force 0 -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      'mv -f "$repaired" "$db_file" || fail 70 "Nao foi possivel substituir banco original pelo reparado"',
      'chmod 0666 "$db_file" || fail 71 "Nao foi possivel ajustar permissao do banco reparado final"',
      `${gfix} -online -user SYSDBA -password ${password} "$db" >> "$log" 2>&1 || true`,
      `${gstat} -h "$db_file" >> "$log" 2>&1 || fail 72 "Falha ao validar banco final com gstat"`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const { stdout: sizeOut } = await dockerExec(['stat', '-c', '%s', backupPath]);
    const databaseSizeAfter = fs.existsSync(db.filePath) ? fs.statSync(db.filePath).size : null;
    const { stdout: shaOut } = await dockerExec(['sha256sum', backupPath]);
    const sha = shaOut.trim().split(/\s+/)[0];
    const validation = await validateBackupRestore(db, backupPath, logPath, stamp);
    writeBackupManifest(db, backupPath, sha, validation);
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
      details: { backupPath, safetyCopyPath, repairedPath, logPath, databaseSizeBefore, databaseSizeAfter }
    });
    await lockHandle.releaseWith({ standbyStatus: isHaMode() ? 'PENDING' : lockHandle.previousDatabase.standbyStatus });
    const drive = await uploadBackupJobToExternal(req, db, job.id, backupPath);
    return {
      ok: true,
      databaseId: db.id,
      backupPath,
      backupSize: done.backupSize?.toString(),
      databaseSizeBefore: databaseSizeBefore?.toString?.() ?? null,
      databaseSizeAfter: databaseSizeAfter?.toString?.() ?? null,
      safetyCopyPath,
      logPath,
      drive
    };
  } catch (err) {
    const error = shellErrorText(err);
    const quarantined = quarantineInvalidBackup(backupPath, manifestPath);
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: error }
    });
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
    await createAlertOnce(`DATABASE_AUTO_MAINTENANCE_FAILED_${db.alias}`, 'CRITICAL', `Manutencao automatica falhou: ${db.name}`);
    await audit(req, 'DATABASE_AUTO_MAINTENANCE_FAILED', {
      entityType: 'database',
      entityId: db.id,
      details: { backupPath, safetyCopyPath, repairedPath, logPath, error, quarantined }
    });
    await lockHandle.releaseWith({ standbyStatus: lockHandle.previousDatabase.standbyStatus });
    return reply.code(500).send({ error, backupPath, safetyCopyPath, logPath });
  }
});

app.post('/api/backups/:databaseId/run', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const db = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: req.params.databaseId } });
  if (await replyIfDatabaseOperationActive(db, reply, `Banco ${db.name} esta em manutencao/migracao. Backup manual bloqueado ate finalizar a operacao.`)) return;
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
    const validation = await validateBackupRestore(db, backupPath, logPath, stamp);
    writeBackupManifest(db, backupPath, sha, validation);
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { lastBackupAt: new Date() } });
    const done = await prisma.backupJob.update({ where: { id: job.id }, data: { status: 'SUCCESS', finishedAt: new Date(), backupSize: BigInt(sizeOut.trim()), sha256: sha } });
    await audit(req, 'BACKUP_FINISHED', { entityType: 'backup', entityId: job.id, details: { database: db.alias } });
    const drive = await uploadBackupJobToExternal(req, db, job.id, backupPath);
    const updated = await prisma.backupJob.findUniqueOrThrow({ where: { id: job.id } });
    return { ...updated, backupSize: updated.backupSize?.toString(), drive };
  } catch (err) {
    const quarantined = quarantineInvalidBackup(backupPath, manifestPath);
    await prisma.backupJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), errorMessage: err.message } });
    await prisma.alert.create({ data: { type: 'BACKUP_FAILED', severity: 'CRITICAL', message: `Backup falhou: ${db.name}` } });
    await audit(req, 'BACKUP_FAILED', { entityType: 'backup', entityId: job.id, details: { error: err.message, quarantined } });
    throw err;
  }
});

app.get('/api/backups', { preHandler: requireOperator }, async () => {
  const jobs = await prisma.backupJob.findMany({ include: { database: true }, orderBy: { createdAt: 'desc' }, take: 50 });
  return jobs.map(j => ({ ...j, backupSize: j.backupSize?.toString(), validation: backupValidationStatus(j) }));
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

app.post('/api/restores/prepare', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const body = req.body || {};
  const targetDb = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: body.databaseId } });
  const token = makeToken();
  const lockHandle = await acquireDatabaseOperationLock(req, targetDb, 'RESTORE', reply, {
    token,
    message: 'Restore/migracao manual aguardando upload/execucao'
  });
  if (reply.sent) return;
  await audit(req, 'RESTORE_PREPARED', { entityType: 'database', entityId: targetDb.id, details: { token } });
  return { ok: true, operation: databaseOperationPayload(lockHandle.database) };
});

app.post('/api/restores/release', { preHandler: requireOperator }, async (req) => {
  const body = req.body || {};
  const token = String(body.operationToken || '');
  if (!token) return { ok: true, released: false };
  const db = await prisma.managedDatabase.findFirst({ where: { operationToken: token, operationKind: 'RESTORE' } });
  if (!db) return { ok: true, released: false };
  await prisma.managedDatabase.update({
    where: { id: db.id },
    data: {
      operationStatus: 'IDLE',
      operationKind: null,
      operationToken: null,
      operationStartedAt: null,
      operationExpiresAt: null,
      operationMessage: null
    }
  });
  await audit(req, 'RESTORE_PREPARE_RELEASED', { entityType: 'database', entityId: db.id, details: { token } });
  return { ok: true, released: true };
});

app.post('/api/restores/from-upload', { preHandler: requireOperator }, async (req, reply) => {
  assertPrimaryWritable();
  const body = req.body || {};
  const sourcePath = assertUploadedBackupPath(body.uploadPath);
  const targetDb = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: body.databaseId } });
  const lockHandle = await acquireDatabaseOperationLock(req, targetDb, 'RESTORE', reply, {
    existingToken: body.operationToken ? String(body.operationToken) : null,
    message: 'Restore/migracao manual em andamento'
  });
  if (reply.sent) return;
  const stamp = safeLogToken(body.logToken);
  const tempRestorePath = `/firebird/restore-work/${targetDb.alias}_restore_${stamp}.fdb`;
  const currentBackupPath = `/firebird/restore-work/${targetDb.alias}_before_restore_${stamp}.fdb`;
  const logPath = `/firebird/logs/restore_${targetDb.alias}_${stamp}.log`;

  try {
    const restoreSteps = [
      'set -e',
      `src=${shQuote(sourcePath)}`,
      `temp_dest=${shQuote(tempRestorePath)}`,
      `target=${shQuote(targetDb.filePath)}`,
      `target_conn=${shQuote(firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? `localhost:${targetDb.filePath}` : firebirdDbConnect(targetDb.filePath))}`,
      `current_backup=${shQuote(currentBackupPath)}`,
      `log=${shQuote(logPath)}`,
      'fail() { code="$1"; shift; echo "$*"; test -f "$log" && cat "$log"; exit "$code"; }',
      'test -f "$src" || fail 60 "Arquivo de origem nao encontrado: $src"',
      'rm -f "$temp_dest" || fail 61 "Nao foi possivel remover restore temporario anterior: $temp_dest"',
      'restore_src="$src"',
      `case "$src" in *.gz) restore_src=${shQuote(`/tmp/tronfire_restore_${targetDb.alias}_${stamp}.gbk`)}; gzip -dc "$src" > "$restore_src" || fail 62 "Falha ao descompactar backup: $src" ;; esac`,
      `${shQuote(`${firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? '/usr/local/firebird/bin' : (process.env.FIREBIRD_BIN || '/usr/local/firebird/bin')}/gbak`)} -c -v -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$restore_src" ${shQuote(firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? tempRestorePath : firebirdCreateTarget(tempRestorePath))} > "$log" 2>&1 || fail 66 "Falha no gbak restore"`,
      'if [ "$restore_src" != "$src" ]; then rm -f "$restore_src" || true; fi',
      'test -f "$temp_dest" || fail 63 "Restore terminou, mas o arquivo temporario nao foi encontrado: $temp_dest"',
      'chmod 0666 "$temp_dest" || fail 64 "Nao foi possivel ajustar permissao do banco restaurado: $temp_dest"',
      `${shQuote(`${firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? '/usr/local/firebird/bin' : (process.env.FIREBIRD_BIN || '/usr/local/firebird/bin')}/gstat`)} -h "$temp_dest" >> "$log" 2>&1 || fail 67 "Falha ao validar banco restaurado com gstat"`,
      `${shQuote(`${firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? '/usr/local/firebird/bin' : (process.env.FIREBIRD_BIN || '/usr/local/firebird/bin')}/gfix`)} -shut -force 0 -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$target_conn" >> "$log" 2>&1 || true`,
      'if [ -f "$target" ]; then cp -p "$target" "$current_backup" || fail 68 "Nao foi possivel criar copia de seguranca atual: $current_backup"; fi',
      'mv -f "$temp_dest" "$target" || fail 69 "Nao foi possivel substituir banco de destino: $target"',
      'chmod 0666 "$target" || fail 70 "Nao foi possivel ajustar permissao do banco final: $target"',
      `${shQuote(`${firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? '/usr/local/firebird/bin' : (process.env.FIREBIRD_BIN || '/usr/local/firebird/bin')}/gfix`)} -online -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$target_conn" >> "$log" 2>&1 || true`,
      `${shQuote(`${firebirdExecMode === 'host' || firebirdExecMode === 'direct' ? '/usr/local/firebird/bin' : (process.env.FIREBIRD_BIN || '/usr/local/firebird/bin')}/gstat`)} -h "$target" >> "$log" 2>&1 || fail 71 "Falha ao validar banco final com gstat"`
    ];
    const cmd = restoreSteps.join('; ');
    if (firebirdExecMode === 'host' || firebirdExecMode === 'direct') {
      await runHostFirebirdScript(`# TronFire host Firebird script\n${cmd}\n`, 1000 * 60 * 60 * 4);
    } else {
      await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    }
    const db = await prisma.managedDatabase.update({
      where: { id: targetDb.id },
      data: {
        status: 'ONLINE',
        lastCheckAt: new Date()
      }
    });
    await syncFirebirdAliases();
    await audit(req, 'RESTORE_FINISHED', { entityType: 'database', entityId: db.id, details: { targetDatabaseId: targetDb.id, sourcePath, targetPath: targetDb.filePath, currentBackupPath, logPath } });
    await lockHandle.releaseWith({ standbyStatus: isHaMode() ? 'PENDING' : lockHandle.previousDatabase.standbyStatus });
    return reply.code(200).send({ ok: true, database: db, sourcePath, targetPath: targetDb.filePath, currentBackupPath, logPath });
  } catch (err) {
    const error = shellErrorText(err);
    await prisma.alert.create({ data: { type: 'RESTORE_FAILED', severity: 'CRITICAL', message: `Restore falhou: ${targetDb.name}` } });
    await audit(req, 'RESTORE_FAILED', { entityType: 'database', entityId: targetDb.id, details: { sourcePath, targetPath: targetDb.filePath, tempRestorePath, logPath, error } });
    await lockHandle.releaseWith({ standbyStatus: lockHandle.previousDatabase.standbyStatus });
    return reply.code(500).send({ error, logPath });
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
      lastStandbyBackupSha256: db.lastStandbyBackupSha256,
      operationStatus: db.operationStatus || 'IDLE',
      operationKind: db.operationKind || null,
      operationStartedAt: db.operationStartedAt || null,
      operationExpiresAt: db.operationExpiresAt || null,
      operationMessage: db.operationMessage || null
    }))
  };
});

app.post('/api/ha/standby/restore', async (req, reply) => {
  assertInternalTronsoftos(req);
  if (!isHaMode() || nodeRole === 'primary') {
    return reply.code(409).send({ error: 'Restore standby permitido apenas em no HA standby/recovery' });
  }
  const body = req.body || {};
  const sourcePath = normalizeReceivedBackupPath(body.backupPath);
  if (!isReceivedBackupPath(sourcePath)) return reply.code(400).send({ error: 'backupPath invalido' });
  const manifestPath = body.manifestPath ? normalizeReceivedManifestPath(body.manifestPath) : '';
  const manifest = manifestPath ? readBackupManifest(manifestPath) : null;
  if (!manifest?.validation?.ok) return reply.code(400).send({ error: 'backup sem validacao de restore aprovada' });
  const alias = normalizeAlias(body.databaseAlias || manifest?.databaseAlias || path.basename(sourcePath).split('_').slice(0, -1).join('_'));
  const db = await prisma.managedDatabase.findUnique({ where: { alias } });
  if (!db) return reply.code(404).send({ error: `Banco nao cadastrado para alias ${alias}` });
  const currentDb = await clearExpiredDatabaseOperation(db);
  if (databaseOperationActive(currentDb) || String(currentDb.standbyStatus || '').toUpperCase() === 'MAINTENANCE') {
    await audit(req, 'HA_STANDBY_RESTORE_SKIPPED_MAINTENANCE', { entityType: 'database', entityId: db.id, details: databaseOperationPayload(currentDb) });
    return {
      ok: true,
      skipped: true,
      reason: 'database_operation_in_progress',
      database: databaseOperationPayload(currentDb)
    };
  }
  const lockHandle = await acquireDatabaseOperationLock(req, currentDb, 'HA_STANDBY_RESTORE', reply, { markStandbyMaintenance: false });
  if (reply.sent) return;

  const stamp = safeLogToken(body.logToken);
  const standbyPath = db.standbyPath || standbyPathForAlias(db.alias);
  const tempRestorePath = `/firebird/restore-work/${db.alias}_standby_restore_${stamp}.fdb`;
  const logPath = `/firebird/logs/standby_restore_${db.alias}_${stamp}.log`;
  const previousStandby = {
    standbyPath: db.standbyPath,
    standbyStatus: db.standbyStatus,
    lastStandbyBackupAt: db.lastStandbyBackupAt,
    lastStandbyValidatedAt: db.lastStandbyValidatedAt,
    lastStandbyBackupSha256: db.lastStandbyBackupSha256
  };

  try {
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { standbyStatus: 'RESTORING' } });
    const cmd = [
      'set -e',
      `src=${shQuote(sourcePath)}`,
      `temp_dest=${shQuote(tempRestorePath)}`,
      `standby=${shQuote(standbyPath)}`,
      `standby_conn=${shQuote(firebirdDbConnect(standbyPath))}`,
      `log=${shQuote(logPath)}`,
      `expected_sha=${shQuote(manifest?.backupSha256 || '')}`,
      'fail() { code="$1"; shift; echo "$*"; test -f "$log" && cat "$log"; exit "$code"; }',
      'mkdir -p /firebird/standby /firebird/restore-work /firebird/logs || fail 60 "Nao foi possivel criar diretorios de standby"',
      'test -f "$src" || fail 61 "Arquivo de backup recebido nao encontrado: $src"',
      'if [ -n "$expected_sha" ]; then actual_sha="$(sha256sum "$src" | awk \'{print $1}\')"; [ "$actual_sha" = "$expected_sha" ] || fail 71 "SHA256 do backup recebido nao confere"; fi',
      'rm -f "$temp_dest" || fail 62 "Nao foi possivel remover restore standby temporario anterior: $temp_dest"',
      'restore_src="$src"',
      `case "$src" in *.gz) restore_src=${shQuote(`/tmp/tronfire_standby_restore_${db.alias}_${stamp}.gbk`)}; gzip -dc "$src" > "$restore_src" || fail 63 "Falha ao descompactar backup standby: $src" ;; esac`,
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gbak`)} -c -v -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$restore_src" ${shQuote(firebirdCreateTarget(tempRestorePath))} > "$log" 2>&1 || fail 66 "Falha no gbak restore standby"`,
      'if [ "$restore_src" != "$src" ]; then rm -f "$restore_src" || true; fi',
      'test -f "$temp_dest" || fail 64 "Restore standby terminou, mas arquivo temporario nao foi encontrado: $temp_dest"',
      'chmod 0666 "$temp_dest" || fail 65 "Nao foi possivel ajustar permissao do standby temporario"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$temp_dest" >> "$log" 2>&1 || fail 67 "Falha ao validar standby restaurado com gstat"`,
      'mv -f "$temp_dest" "$standby" || fail 68 "Nao foi possivel substituir banco standby: $standby"',
      'chmod 0666 "$standby" || fail 69 "Nao foi possivel ajustar permissao do standby final"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gfix`)} -mode read_only -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$standby_conn" >> "$log" 2>&1 || true`,
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$standby" >> "$log" 2>&1 || fail 70 "Falha ao validar standby final com gstat"`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 1000 * 60 * 60 * 4 });
    const sha = manifest?.backupSha256 || null;
    await lockHandle.releaseWith({
        standbyPath,
        standbyStatus: 'READY',
        lastStandbyBackupAt: manifest?.backupFinishedAt ? new Date(manifest.backupFinishedAt) : new Date(),
        lastStandbyValidatedAt: new Date(),
        lastStandbyBackupSha256: sha
    });
    const updated = await prisma.managedDatabase.findUniqueOrThrow({ where: { id: db.id } });
    await syncFirebirdAliases();
    await audit(req, 'HA_STANDBY_RESTORED', { entityType: 'database', entityId: db.id, details: { sourcePath, manifestPath: manifestPath || null, standbyPath, logPath } });
    return { ok: true, database: updated, standbyPath, logPath };
  } catch (err) {
    const error = shellErrorText(err);
    const failureData = previousStandby.standbyStatus === 'READY'
      ? previousStandby
      : { standbyStatus: 'INVALID' };
    await lockHandle.releaseWith(failureData);
    await createAlertOnce(`HA_STANDBY_RESTORE_FAILED_${db.alias}`, 'CRITICAL', `Restore HA do standby falhou: ${db.name}`);
    await audit(req, 'HA_STANDBY_RESTORE_FAILED', { entityType: 'database', entityId: db.id, details: { sourcePath, standbyPath, logPath, error } });
    return reply.code(500).send({ error, logPath });
  }
});

app.post('/api/ha/standby/validate', async (req, reply) => {
  assertInternalTronsoftos(req);
  const alias = normalizeAlias(req.body?.databaseAlias);
  const db = await prisma.managedDatabase.findUnique({ where: { alias } });
  if (!db) return reply.code(404).send({ error: `Banco nao cadastrado para alias ${alias}` });
  const standbyPath = db.standbyPath || standbyPathForAlias(db.alias);
  const logPath = `/firebird/logs/standby_validate_${db.alias}_${timestamp14()}.log`;
  const backupSha256 = req.body?.backupSha256 ? String(req.body.backupSha256) : '';
  const backupFinishedAt = req.body?.backupFinishedAt ? new Date(req.body.backupFinishedAt) : null;
  try {
    const cmd = [
      'set -e',
      `db=${shQuote(standbyPath)}`,
      `log=${shQuote(logPath)}`,
      'test -f "$db"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$db" > "$log" 2>&1`
    ].join('; ');
    await dockerExec(['sh', '-lc', cmd], { timeout: 120000 });
    const data = { standbyStatus: 'READY', lastStandbyValidatedAt: new Date() };
    if (backupSha256) data.lastStandbyBackupSha256 = backupSha256;
    if (backupFinishedAt && !Number.isNaN(backupFinishedAt.getTime())) data.lastStandbyBackupAt = backupFinishedAt;
    const updated = await prisma.managedDatabase.update({ where: { id: db.id }, data });
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
  const notReady = dbs.filter(db => db.standbyStatus !== 'READY' || !db.standbyPath || databaseOperationActive(db));
  if (notReady.length) {
    return reply.code(409).send({ error: 'Nem todos os bancos obrigatorios estao prontos para promocao', databases: notReady.map(db => ({ alias: db.alias, standbyStatus: db.standbyStatus, operationStatus: db.operationStatus, operationKind: db.operationKind })) });
  }

  const stamp = timestamp14();
  const promoted = [];
  for (const db of dbs) {
    const backupCurrent = `/firebird/restore-work/${db.alias}_before_promote_${stamp}.fdb`;
    const logPath = `/firebird/logs/promote_${db.alias}_${stamp}.log`;
    const cmd = [
      'set -e',
      `prod=${shQuote(db.filePath)}`,
      `prod_conn=${shQuote(firebirdDbConnect(db.filePath))}`,
      `standby=${shQuote(db.standbyPath)}`,
      `backup_current=${shQuote(backupCurrent)}`,
      `log=${shQuote(logPath)}`,
      'mkdir -p /firebird/data /firebird/restore-work /firebird/logs',
      'test -f "$standby"',
      'if [ -f "$prod" ]; then mv "$prod" "$backup_current"; fi',
      'mv "$standby" "$prod"',
      'chmod 0666 "$prod"',
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gfix`)} -mode read_write -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} "$prod_conn" >> "$log" 2>&1 || true`,
      `${shQuote(`${process.env.FIREBIRD_BIN || '/usr/local/firebird/bin'}/gstat`)} -h "$prod" >> "$log" 2>&1`
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
