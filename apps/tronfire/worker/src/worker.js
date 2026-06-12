import 'dotenv/config';
import cron from 'node-cron';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const prisma = new PrismaClient();
const execFileAsync = promisify(execFile);
const FIREBIRD_BIN = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
const FIREBIRD_CONTAINER = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
const FIREBIRD_PASSWORD = process.env.FIREBIRD_PASSWORD || 'masterkey';
const FIREBIRD_EXEC_MODE = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
const TRONFIRE_NODE_ROLE = String(process.env.TRONFIRE_NODE_ROLE || 'primary').toLowerCase();
const FIREBIRD_HOST = process.env.FIREBIRD_HOST || 'host.docker.internal';
const HOST_PROC_ROOT = process.env.HOST_PROC_ROOT || '/host/proc';
const FIREBIRD_HOST_TARGET = 'firebird_host';
const FIREBIRD_PROCESS_NAMES = new Set(['fbguard', 'fbserver', 'fb_inet_server', 'fb_smp_server', 'firebird']);
const METRIC_CONTAINERS = [
  'tronfire_firebird25',
  'tronfire_postgres',
  'tronfire_redis',
  'tronfire_backend',
  'tronfire_worker'
].filter(name => FIREBIRD_EXEC_MODE === 'container' || name !== FIREBIRD_CONTAINER);
let backupRunning = false;

function firebirdExecOptions(timeout = 60_000, maxBuffer = 1024 * 1024 * 5) {
  const firebirdHome = process.env.FIREBIRD || '/usr/local/firebird';
  const firebirdLib = process.env.FIREBIRD_LIB || '/usr/local/firebird/lib';
  const currentLdPath = process.env.LD_LIBRARY_PATH || '';
  return {
    timeout,
    maxBuffer,
    env: {
      ...process.env,
      FIREBIRD: firebirdHome,
      LD_LIBRARY_PATH: [firebirdLib, currentLdPath].filter(Boolean).join(':')
    }
  };
}

async function docker(args, timeout = 60_000) {
  const { stdout, stderr } = await execFileAsync('docker', args, { timeout, maxBuffer: 1024 * 1024 * 10 });
  return { stdout, stderr };
}

async function dockerExec(args, timeout = 60_000) {
  if (FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct') {
    const [command, ...commandArgs] = args;
    const { stdout, stderr } = await execFileAsync(command, commandArgs, firebirdExecOptions(timeout));
    return { stdout, stderr };
  }
  const { stdout, stderr } = await execFileAsync('docker', ['exec', FIREBIRD_CONTAINER, ...args], { timeout, maxBuffer: 1024 * 1024 * 5 });
  return { stdout, stderr };
}

function isPrimaryNode() {
  return TRONFIRE_NODE_ROLE === 'primary';
}

function databaseOperationActive(db, now = new Date()) {
  if (String(db.operationStatus || 'IDLE').toUpperCase() !== 'RUNNING') return false;
  if (!db.operationExpiresAt) return true;
  return new Date(db.operationExpiresAt) > now;
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

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function firebirdDbConnect(filePath) {
  const value = String(filePath || '').trim();
  if (FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct') return `${FIREBIRD_HOST}:${value}`;
  return value;
}

function firebirdCreateTarget(filePath) {
  const value = String(filePath || '').trim();
  if (FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct') return value;
  return firebirdDbConnect(value);
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function parsePercent(value) {
  const parsed = Number(String(value || '').replace('%', '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBytes(value) {
  const text = String(value || '').trim();
  if (!text || text === '0B') return 0n;
  const match = text.match(/^([\d.,]+)\s*([kmgtp]?i?b|b)$/i);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const factors = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    pb: 1000 ** 5,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5
  };
  return BigInt(Math.round(amount * (factors[unit] || 1)));
}

function parsePair(value) {
  const [left, right] = String(value || '').split('/').map(part => part.trim());
  return [parseBytes(left), parseBytes(right)];
}

function bigIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  try { return BigInt(value); } catch { return null; }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function listHostFirebirdPids() {
  if (!fs.existsSync(HOST_PROC_ROOT)) return [];
  const pids = [];
  for (const entry of fs.readdirSync(HOST_PROC_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const comm = readText(`${HOST_PROC_ROOT}/${entry.name}/comm`);
      if (FIREBIRD_PROCESS_NAMES.has(comm)) pids.push(entry.name);
    } catch {
      // Process may have exited between readdir and read.
    }
  }
  return pids;
}

function readHostCpuJiffies() {
  const firstLine = fs.readFileSync(`${HOST_PROC_ROOT}/stat`, 'utf8').split(/\r?\n/)[0] || '';
  return firstLine.split(/\s+/).slice(1).reduce((sum, value) => sum + Number(value || 0), 0);
}

function readProcessJiffies(pid) {
  const stat = fs.readFileSync(`${HOST_PROC_ROOT}/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  return Number(fields[11] || 0) + Number(fields[12] || 0);
}

function readProcessStartJiffies(pid) {
  const stat = fs.readFileSync(`${HOST_PROC_ROOT}/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  return Number(fields[19] || 0);
}

function readHostMemTotalBytes() {
  const meminfo = fs.readFileSync(`${HOST_PROC_ROOT}/meminfo`, 'utf8');
  const match = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
  return match ? BigInt(match[1]) * 1024n : null;
}

function readProcessRssBytes(pid) {
  const status = fs.readFileSync(`${HOST_PROC_ROOT}/${pid}/status`, 'utf8');
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? BigInt(match[1]) * 1024n : 0n;
}

function readProcessIoBytes(pid) {
  try {
    const io = fs.readFileSync(`${HOST_PROC_ROOT}/${pid}/io`, 'utf8');
    const read = io.match(/^read_bytes:\s+(\d+)/m)?.[1] || '0';
    const write = io.match(/^write_bytes:\s+(\d+)/m)?.[1] || '0';
    return { readBytes: BigInt(read), writeBytes: BigInt(write) };
  } catch {
    return { readBytes: 0n, writeBytes: 0n };
  }
}

async function createAlertOnce(type, severity, message) {
  const existing = await prisma.alert.findFirst({ where: { type, severity, resolved: false } });
  if (!existing) {
    await prisma.alert.create({ data: { type, severity, message } });
  }
}

async function collectContainerMetrics() {
  if (!METRIC_CONTAINERS.length) return;
  try {
    const { stdout } = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...METRIC_CONTAINERS], 120_000);
    const rows = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const row of rows) {
      const item = JSON.parse(row);
      const target = item.Name || item.Container || 'unknown';
      const [memoryUsageBytes, memoryLimitBytes] = parsePair(item.MemUsage);
      const [netInputBytes, netOutputBytes] = parsePair(item.NetIO);
      const [blockInputBytes, blockOutputBytes] = parsePair(item.BlockIO);
      await prisma.metricSnapshot.create({
        data: {
          scope: target === FIREBIRD_CONTAINER ? 'FIREBIRD' : 'CONTAINER',
          target,
          cpuPercent: parsePercent(item.CPUPerc),
          memoryUsageBytes,
          memoryLimitBytes,
          memoryPercent: parsePercent(item.MemPerc),
          netInputBytes,
          netOutputBytes,
          blockInputBytes,
          blockOutputBytes
        }
      });
      const mem = parsePercent(item.MemPerc) || 0;
      if (target === FIREBIRD_CONTAINER && mem >= 95) {
        await createAlertOnce('FIREBIRD_MEMORY_CRITICAL', 'CRITICAL', `Firebird com memoria critica: ${mem.toFixed(1)}%`);
      } else if (target === FIREBIRD_CONTAINER && mem >= 85) {
        await createAlertOnce('FIREBIRD_MEMORY_WARNING', 'WARNING', `Firebird com memoria em atencao: ${mem.toFixed(1)}%`);
      }
    }
  } catch (err) {
    console.error('[worker] container metrics error', err.message);
  }
}

async function collectHostFirebirdMetrics() {
  if (FIREBIRD_EXEC_MODE !== 'host' && FIREBIRD_EXEC_MODE !== 'direct') return;
  try {
    const pids = listHostFirebirdPids();
    if (!pids.length) return;

    const firstProc = pids.reduce((sum, pid) => sum + readProcessJiffies(pid), 0);
    const firstHost = readHostCpuJiffies();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const livePids = listHostFirebirdPids();
    const secondProc = livePids.reduce((sum, pid) => sum + readProcessJiffies(pid), 0);
    const secondHost = readHostCpuJiffies();
    const cpuPercent = secondHost > firstHost ? ((secondProc - firstProc) / (secondHost - firstHost)) * 100 : null;

    const memoryUsageBytes = livePids.reduce((sum, pid) => sum + readProcessRssBytes(pid), 0n);
    const memoryLimitBytes = readHostMemTotalBytes();
    const memoryPercent = memoryLimitBytes ? Number(memoryUsageBytes * 10000n / memoryLimitBytes) / 100 : null;
    const io = livePids.reduce((acc, pid) => {
      const item = readProcessIoBytes(pid);
      acc.readBytes += item.readBytes;
      acc.writeBytes += item.writeBytes;
      return acc;
    }, { readBytes: 0n, writeBytes: 0n });

    await prisma.metricSnapshot.create({
      data: {
        scope: 'FIREBIRD',
        target: FIREBIRD_HOST_TARGET,
        cpuPercent,
        memoryUsageBytes,
        memoryLimitBytes,
        memoryPercent,
        blockInputBytes: io.readBytes,
        blockOutputBytes: io.writeBytes
      }
    });

    const oldestStart = livePids
      .map(pid => readProcessStartJiffies(pid))
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0];
    if (oldestStart) {
      const uptimeSeconds = Number(readText(`${HOST_PROC_ROOT}/uptime`).split(/\s+/)[0] || 0);
      const hertz = 100;
      await prisma.metricSnapshot.create({
        data: {
          scope: 'SERVER',
          target: 'firebird_uptime',
          uptimeSeconds: BigInt(Math.max(Math.floor(uptimeSeconds - oldestStart / hertz), 0))
        }
      });
    }

    const mem = memoryPercent || 0;
    if (mem >= 95) {
      await createAlertOnce('FIREBIRD_MEMORY_CRITICAL', 'CRITICAL', `Firebird host com memoria critica: ${mem.toFixed(1)}%`);
    } else if (mem >= 85) {
      await createAlertOnce('FIREBIRD_MEMORY_WARNING', 'WARNING', `Firebird host com memoria em atencao: ${mem.toFixed(1)}%`);
    }
  } catch (err) {
    console.error('[worker] host firebird metrics error', err.message);
  }
}

async function collectDiskMetrics() {
  try {
    const { stdout } = await dockerExec(['sh', '-lc', "mkdir -p /firebird/data /firebird/backups; for p in /firebird/data /firebird/backups; do df -PB1 \"$p\" | awk -v p=\"$p\" 'NR==2 {print p\" \"$2\" \"$3\" \"$4\" \"$5}'; done"], 60_000);
    const seen = new Set();
    for (const line of stdout.split(/\r?\n/).map(row => row.trim()).filter(Boolean)) {
      const [mount, total, used, free, usedPercentText] = line.split(/\s+/);
      if (!mount || seen.has(mount)) continue;
      seen.add(mount);
      const usedPercent = parsePercent(usedPercentText);
      await prisma.metricSnapshot.create({
        data: {
          scope: 'SERVER',
          target: mount,
          diskTotalBytes: bigIntOrNull(total),
          diskUsedBytes: bigIntOrNull(used),
          diskFreeBytes: bigIntOrNull(free),
          diskUsedPercent: usedPercent
        }
      });
      if (usedPercent >= 95) {
        await createAlertOnce(`DISK_CRITICAL_${mount}`, 'CRITICAL', `Disco critico em ${mount}: ${usedPercent}% usado`);
      } else if (usedPercent >= 85) {
        await createAlertOnce(`DISK_WARNING_${mount}`, 'WARNING', `Disco em atencao em ${mount}: ${usedPercent}% usado`);
      }
    }
  } catch (err) {
    console.error('[worker] disk metrics error', err.message);
  }
}

async function collectUptimeMetric() {
  if (FIREBIRD_EXEC_MODE !== 'container') return;
  try {
    const { stdout } = await docker(['inspect', FIREBIRD_CONTAINER, '--format', '{{.State.StartedAt}}'], 60_000);
    const startedAt = new Date(stdout.trim());
    if (!Number.isNaN(startedAt.getTime())) {
      const uptimeSeconds = BigInt(Math.max(Math.floor((Date.now() - startedAt.getTime()) / 1000), 0));
      await prisma.metricSnapshot.create({
        data: { scope: 'SERVER', target: 'firebird_uptime', uptimeSeconds }
      });
    }
  } catch (err) {
    console.error('[worker] uptime metrics error', err.message);
  }
}

async function collectDatabaseFileMetrics() {
  const dbs = await prisma.managedDatabase.findMany({ where: { type: { not: 'ARQUIVADO' } } });
  for (const db of dbs) {
    try {
      const { stdout } = await dockerExec(['stat', '-c', '%s', db.filePath], 60_000);
      await prisma.metricSnapshot.create({
        data: {
          scope: 'DATABASE',
          target: db.alias,
          databaseId: db.id,
          fileSizeBytes: BigInt(stdout.trim())
        }
      });
    } catch (err) {
      console.error('[worker] database file metrics error', db.alias, err.message);
    }
  }
}

async function cleanupOldMetrics() {
  const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  await prisma.metricSnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } });
}

async function collectMetrics() {
  await collectContainerMetrics();
  await collectHostFirebirdMetrics();
  await collectDiskMetrics();
  await collectUptimeMetric();
  await collectDatabaseFileMetrics();
  await cleanupOldMetrics();
}

async function uploadBackupJobToExternal(db, jobId, backupPath) {
  await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'TRONSOFTOS', driveErrorMessage: null } });
  console.log(`[worker] upload externo gerenciado pelo TronSoftOS: ${db.alias} ${backupPath}`);
}

async function validateBackupRestore(db, backupPath, logPath, stamp) {
  const tempRestorePath = `/firebird/restore-work/${db.alias}_backup_validate_${stamp}.fdb`;
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
    `${shQuote(`${FIREBIRD_BIN}/gbak`)} -c -v -user SYSDBA -password ${shQuote(FIREBIRD_PASSWORD)} "$restore_src" ${shQuote(firebirdCreateTarget(tempRestorePath))} >> "$log" 2>&1 || fail 82 "Falha ao restaurar backup para validacao"`,
    'if [ "$restore_src" != "$backup" ]; then rm -f "$restore_src" || true; fi',
    'test -f "$restore" || fail 83 "Restore de validacao terminou sem arquivo restaurado"',
    `${shQuote(`${FIREBIRD_BIN}/gstat`)} -h "$restore" >> "$log" 2>&1 || fail 84 "Falha no gstat do backup restaurado"`,
    'rm -f "$restore"',
    'echo "[validacao] backup aprovado" >> "$log"'
  ].join('; ');
  await dockerExec(['sh', '-lc', cmd], 1000 * 60 * 60 * 4);
  return {
    ok: true,
    method: 'gbak-restore-gstat',
    validatedAt: new Date().toISOString(),
    logPath
  };
}

function quarantineInvalidBackup(backupPath, manifestPath = null) {
  const moved = [];
  try {
    fs.mkdirSync('/firebird/quarantine', { recursive: true });
    for (const filePath of [backupPath, manifestPath].filter(Boolean)) {
      if (!fs.existsSync(filePath)) continue;
      const target = `/firebird/quarantine/${filePath.split('/').pop()}`;
      fs.renameSync(filePath, target);
      moved.push(target);
    }
  } catch {
    // Best effort: the backup job remains FAILED even if quarantine cannot move files.
  }
  return moved;
}

async function runBackup(db, reason = 'AUTO') {
  if (!isPrimaryNode()) {
    console.log(`[worker] backup ${reason} ignorado no no ${TRONFIRE_NODE_ROLE}: ${db.alias}`);
    return;
  }
  const currentDb = await clearExpiredDatabaseOperation(db);
  if (databaseOperationActive(currentDb)) {
    console.log(`[worker] backup ${reason} ignorado: operacao ${currentDb.operationKind || 'desconhecida'} em andamento para ${db.alias}`);
    return;
  }
  const stamp = backupStamp();
  const rawBackupPath = `/firebird/backups/${db.alias}_${stamp}.gbk`;
  const backupPath = `${rawBackupPath}.gz`;
  const manifestPath = `${backupPath}.manifest.json`;
  const logPath = `/firebird/logs/backup_${db.alias}_${stamp}.log`;
  const job = await prisma.backupJob.create({
    data: { databaseId: db.id, status: 'RUNNING', startedAt: new Date(), backupPath, manifestPath, logPath }
  });

  try {
    const cmd = [
      `${shQuote(`${FIREBIRD_BIN}/gbak`)}`,
      '-b -v',
      '-user SYSDBA',
      `-password ${shQuote(FIREBIRD_PASSWORD)}`,
      shQuote(firebirdDbConnect(db.filePath)),
      shQuote(rawBackupPath),
      `> ${shQuote(logPath)} 2>&1`,
      `&& gzip -f ${shQuote(rawBackupPath)}`
    ].join(' ');
    await dockerExec(['sh', '-lc', cmd], 1000 * 60 * 60 * 4);
    const { stdout: sizeOut } = await dockerExec(['stat','-c','%s', backupPath]);
    const { stdout: shaOut } = await dockerExec(['sha256sum', backupPath]);
    const sha = shaOut.trim().split(/\s+/)[0];
    const validation = await validateBackupRestore(db, backupPath, logPath, stamp);
    const manifest = {
      databaseId: db.id,
      databaseAlias: db.alias,
      databaseName: db.name,
      sourceNode: process.env.TRONSOFTOS_NODE_NAME || process.env.HOSTNAME || 'unknown',
      backupPath,
      backupSha256: sha,
      backupFinishedAt: new Date().toISOString(),
      firebirdVersion: '2.5.9',
      productionPath: db.filePath,
      standbyPath: db.standbyPath || `/firebird/standby/${db.alias}_standby.fdb`,
      validation
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await prisma.managedDatabase.update({ where: { id: db.id }, data: { lastBackupAt: new Date() } });
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), backupSize: BigInt(sizeOut.trim()), sha256: sha }
    });
    await uploadBackupJobToExternal(db, job.id, backupPath);
    console.log(`[worker] backup ${reason} OK: ${db.alias}`);
  } catch (err) {
    const quarantined = quarantineInvalidBackup(backupPath, manifestPath);
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: `${err.message}${quarantined.length ? ` | quarentena: ${quarantined.join(', ')}` : ''}` }
    });
    await prisma.alert.create({ data: { type: 'BACKUP_FAILED', severity: 'CRITICAL', message: `Backup falhou: ${db.name}` } });
    console.error(`[worker] backup ${reason} erro: ${db.alias}`, err.message);
  }
}

async function cleanupRetention(db) {
  const retentionDays = Math.max(Number(db.retentionDays || 7), 1);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const latestSuccess = await prisma.backupJob.findFirst({
    where: { databaseId: db.id, status: 'SUCCESS' },
    orderBy: { createdAt: 'desc' }
  });
  const oldJobs = await prisma.backupJob.findMany({
    where: {
      databaseId: db.id,
      status: 'SUCCESS',
      createdAt: { lt: cutoff },
      ...(latestSuccess ? { id: { not: latestSuccess.id } } : {})
    },
    orderBy: { createdAt: 'asc' }
  });
  for (const job of oldJobs) {
    for (const filePath of [job.backupPath, job.manifestPath].filter(Boolean)) {
      try { await dockerExec(['rm', '-f', filePath], 60_000); }
      catch (err) { console.error('[worker] retention file error', filePath, err.message); }
    }
    await prisma.backupJob.delete({ where: { id: job.id } });
  }
}

async function runAutomaticBackups() {
  if (!isPrimaryNode()) return;
  if (backupRunning) return;
  backupRunning = true;
  try {
    const dbs = await prisma.managedDatabase.findMany({
      where: { backupEnabled: true, type: { not: 'ARQUIVADO' } }
    });
    const now = Date.now();
    for (const db of dbs) {
      await cleanupRetention(db);
      const running = await prisma.backupJob.count({ where: { databaseId: db.id, status: 'RUNNING' } });
      if (running > 0) continue;
      const frequencyMs = Math.max(Number(db.backupFrequencyMinutes || 60), 1) * 60 * 1000;
      const lastBackup = db.lastBackupAt ? new Date(db.lastBackupAt).getTime() : 0;
      const scheduleUpdated = db.backupScheduleUpdatedAt ? new Date(db.backupScheduleUpdatedAt).getTime() : 0;
      const last = Math.max(lastBackup || 0, scheduleUpdated || 0);
      if (!last || now - last >= frequencyMs) {
        await runBackup(db);
      }
    }
  } finally {
    backupRunning = false;
  }
}

async function checkDisk() {
  try {
    const { stdout } = await dockerExec(['sh','-lc',"df -P /firebird/data | awk 'NR==2 {print $5}' | tr -d '%'"]);
    const used = Number(stdout.trim());
    if (used >= 95) await createAlertOnce('DISK_CRITICAL', 'CRITICAL', `Disco critico: ${used}% usado`);
    else if (used >= 85) await createAlertOnce('DISK_WARNING', 'WARNING', `Disco em atencao: ${used}% usado`);
  } catch (err) { console.error('[worker] disk check error', err.message); }
}

async function checkDatabases() {
  if (!isPrimaryNode()) return;
  if (backupRunning) return;
  const dbs = await prisma.managedDatabase.findMany({ where: { type: { not: 'ARQUIVADO' } } });
  for (const db of dbs) {
    try {
      const currentDb = await clearExpiredDatabaseOperation(db);
      if (databaseOperationActive(currentDb)) continue;
      const runningBackup = await prisma.backupJob.count({ where: { databaseId: db.id, status: 'RUNNING' } });
      if (runningBackup > 0) continue;
      const logPath = `/firebird/logs/check_${db.alias}.log`;
      const cmd = [
        'set -e',
        `db_file=${shQuote(db.filePath)}`,
        `db=${shQuote(firebirdDbConnect(db.filePath))}`,
        `log=${shQuote(logPath)}`,
        'test -f "$db_file"',
        `printf 'select 1 from rdb$database;\\nquit;\\n' | ${shQuote(`${FIREBIRD_BIN}/isql`)} -user SYSDBA -password ${shQuote(FIREBIRD_PASSWORD)} "$db" > "$log" 2>&1`,
        `${shQuote(`${FIREBIRD_BIN}/gstat`)} -h "$db_file" >> "$log" 2>&1`
      ].join('; ');
      await dockerExec(['sh','-lc', cmd], 120_000);
      await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ONLINE', lastCheckAt: new Date() } });
      await prisma.alert.updateMany({ where: { type: `DATABASE_INTEGRITY_ERROR_${db.alias}`, resolved: false }, data: { resolved: true } });
      await prisma.alert.updateMany({ where: { type: `DATABASE_HEALTH_ERROR_${db.alias}`, resolved: false }, data: { resolved: true } });
    } catch (err) {
      await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
      await createAlertOnce(`DATABASE_HEALTH_ERROR_${db.alias}`, 'CRITICAL', `Banco offline ou sem resposta no check automatico: ${db.name}`);
    }
  }
}

async function checkTools() {
  for (const bin of ['gbak','gfix','gstat','isql']) {
    try { await dockerExec(['test','-x',`${FIREBIRD_BIN}/${bin}`]); }
    catch { await prisma.alert.create({ data: { type: 'FIREBIRD_TOOL_MISSING', severity: 'CRITICAL', message: `Utilitário ausente: ${bin}` } }); }
  }
}

cron.schedule('*/5 * * * *', async () => {
  console.log('[worker] rotina de monitoramento');
  await checkTools();
  await checkDisk();
  await checkDatabases();
  await collectMetrics();
});

cron.schedule('* * * * *', async () => {
  console.log('[worker] rotina de backup automatico');
  await runAutomaticBackups();
});

console.log('[worker] TronFire worker iniciado');
setTimeout(() => {
  collectMetrics().catch(err => console.error('[worker] initial metrics error', err.message));
}, 5000);
