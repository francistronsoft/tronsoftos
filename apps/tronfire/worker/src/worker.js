import 'dotenv/config';
import cron from 'node-cron';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadBackupToGoogleDrive } from './google-drive-oauth.js';

const prisma = new PrismaClient();
const execFileAsync = promisify(execFile);
const FIREBIRD_BIN = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
const FIREBIRD_CONTAINER = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
const FIREBIRD_PASSWORD = process.env.FIREBIRD_PASSWORD || 'masterkey';
const FIREBIRD_EXEC_MODE = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
const TRONFIRE_NODE_ROLE = String(process.env.TRONFIRE_NODE_ROLE || 'primary').toLowerCase();
const METRIC_CONTAINERS = [
  'tronfire_firebird25',
  'tronfire_postgres',
  'tronfire_redis',
  'tronfire_backend',
  'tronfire_worker'
].filter(name => FIREBIRD_EXEC_MODE === 'container' || name !== FIREBIRD_CONTAINER);
let backupRunning = false;

async function docker(args, timeout = 60_000) {
  const { stdout, stderr } = await execFileAsync('docker', args, { timeout, maxBuffer: 1024 * 1024 * 10 });
  return { stdout, stderr };
}

async function dockerExec(args, timeout = 60_000) {
  if (FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct') {
    const [command, ...commandArgs] = args;
    const { stdout, stderr } = await execFileAsync(command, commandArgs, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return { stdout, stderr };
  }
  const { stdout, stderr } = await execFileAsync('docker', ['exec', FIREBIRD_CONTAINER, ...args], { timeout, maxBuffer: 1024 * 1024 * 5 });
  return { stdout, stderr };
}

function isPrimaryNode() {
  return TRONFIRE_NODE_ROLE === 'primary';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

async function collectDiskMetrics() {
  try {
    const { stdout } = await dockerExec(['sh', '-lc', "df -PB1 /firebird/data /firebird/backups | awk 'NR>1 {print $6\" \"$2\" \"$3\" \"$4\" \"$5}'"], 60_000);
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
  await collectDiskMetrics();
  await collectUptimeMetric();
  await collectDatabaseFileMetrics();
  await cleanupOldMetrics();
}

async function uploadBackupJobToExternal(db, jobId, backupPath) {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'GOOGLE_DRIVE_BACKUP' } });
  const settings = setting?.value ? JSON.parse(setting.value) : {};
  if (!settings.enabled) {
    await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'DISABLED' } });
    return;
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
    console.log(`[worker] Google Drive upload OK: ${db.alias} ${uploaded.fileId || uploaded.fileName}`);
  } catch (err) {
    await prisma.backupJob.update({ where: { id: jobId }, data: { driveStatus: 'FAILED', driveErrorMessage: err.message } });
    await createAlertOnce(`BACKUP_EXTERNAL_UPLOAD_FAILED_${db.alias}`, 'WARNING', `Backup local OK, mas envio ao Google Drive falhou: ${db.name}`);
    console.error(`[worker] Google Drive upload erro: ${db.alias}`, err.message);
  }
}

async function runBackup(db, reason = 'AUTO') {
  if (!isPrimaryNode()) {
    console.log(`[worker] backup ${reason} ignorado no no ${TRONFIRE_NODE_ROLE}: ${db.alias}`);
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
      shQuote(db.filePath),
      shQuote(rawBackupPath),
      `> ${shQuote(logPath)} 2>&1`,
      `&& gzip -f ${shQuote(rawBackupPath)}`
    ].join(' ');
    await dockerExec(['sh', '-lc', cmd], 1000 * 60 * 60 * 4);
    const { stdout: sizeOut } = await dockerExec(['stat','-c','%s', backupPath]);
    const { stdout: shaOut } = await dockerExec(['sha256sum', backupPath]);
    const sha = shaOut.trim().split(/\s+/)[0];
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
      standbyPath: db.standbyPath || `/firebird/standby/${db.alias}_standby.fdb`
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
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: err.message }
    });
    await prisma.alert.create({ data: { type: 'BACKUP_FAILED', severity: 'CRITICAL', message: `Backup falhou: ${db.name}` } });
    console.error(`[worker] backup ${reason} erro: ${db.alias}`, err.message);
  }
}

async function cleanupRetention(db) {
  const retentionDays = Math.max(Number(db.retentionDays || 7), 1);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const oldJobs = await prisma.backupJob.findMany({
    where: { databaseId: db.id, status: 'SUCCESS', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' }
  });
  for (const job of oldJobs) {
    if (job.backupPath) {
      try { await dockerExec(['rm', '-f', job.backupPath], 60_000); }
      catch (err) { console.error('[worker] retention file error', job.backupPath, err.message); }
    }
    await prisma.backupJob.delete({ where: { id: job.id } });
  }
}

async function runAutomaticBackups() {
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
      const last = db.lastBackupAt ? new Date(db.lastBackupAt).getTime() : 0;
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
  const dbs = await prisma.managedDatabase.findMany({ where: { type: { not: 'ARQUIVADO' } } });
  for (const db of dbs) {
    try {
      const logPath = `/firebird/logs/check_${db.alias}.log`;
      const cmd = [
        'set -e',
        `db=${shQuote(db.filePath)}`,
        `log=${shQuote(logPath)}`,
        'test -f "$db"',
        `${shQuote(`${FIREBIRD_BIN}/gfix`)} -v -full -user SYSDBA -password ${shQuote(FIREBIRD_PASSWORD)} "$db" > "$log" 2>&1`,
        `${shQuote(`${FIREBIRD_BIN}/gstat`)} -h "$db" >> "$log" 2>&1`
      ].join('; ');
      await dockerExec(['sh','-lc', cmd], 120_000);
      await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ONLINE', lastCheckAt: new Date() } });
    } catch (err) {
      await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: 'ERROR', lastCheckAt: new Date() } });
      await createAlertOnce(`DATABASE_INTEGRITY_ERROR_${db.alias}`, 'CRITICAL', `Banco com erro/offline ou integridade comprometida: ${db.name}`);
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
