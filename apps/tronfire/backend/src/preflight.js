import { firebirdExec } from './shell.js';
import { prisma } from './prisma.js';
import fs from 'node:fs';

const FIREBIRD_BIN = process.env.FIREBIRD_BIN || '/usr/local/firebird/bin';
const FIREBIRD_EXEC_MODE = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
const FIREBIRD_HOST = process.env.FIREBIRD_HOST || 'host.docker.internal';
const DEPLOYMENT_MODE = String(process.env.TRONFIRE_DEPLOYMENT_MODE || 'simple').toLowerCase();
const NODE_ROLE = String(process.env.TRONFIRE_NODE_ROLE || 'primary').toLowerCase();
const dirs = ['/firebird/data','/firebird/backups','/firebird/uploads','/firebird/templates','/firebird/restore-work','/firebird/quarantine','/firebird/logs'];
const bins = ['gbak','gfix','gstat','isql'];

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseIsqlValue(stdout) {
  const value = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  return value || null;
}

function standbyPathForAlias(alias) {
  return `/firebird/standby/${String(alias || '').trim().toLowerCase()}_standby.fdb`;
}

function effectiveDatabasePath(db) {
  if (DEPLOYMENT_MODE === 'ha' && ['standby', 'recovery'].includes(NODE_ROLE) && ['READY', 'RESTORING'].includes(String(db.standbyStatus || '').toUpperCase())) {
    return db.standbyPath || standbyPathForAlias(db.alias);
  }
  return db.filePath;
}

function databaseFileSize(db) {
  const databasePath = effectiveDatabasePath(db);
  try {
    return fs.statSync(databasePath).size;
  } catch (_) {
    return null;
  }
}

async function queryDatabaseValue(db, sql) {
  const script = `set heading off;\n${sql}\nquit;\n`;
  const databasePath = effectiveDatabasePath(db);
  const useDirectPath = databasePath !== db.filePath || FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct';
  const connect = FIREBIRD_EXEC_MODE === 'host' || FIREBIRD_EXEC_MODE === 'direct'
    ? `${FIREBIRD_HOST}:${databasePath}`
    : useDirectPath ? `localhost:${databasePath}` : `localhost:${db.alias || databasePath}`;
  const cmd = `printf %s ${shQuote(script)} | ${shQuote(`${FIREBIRD_BIN}/isql`)} -user SYSDBA -password ${shQuote(process.env.FIREBIRD_PASSWORD || 'masterkey')} ${shQuote(connect)}`;
  const { stdout } = await firebirdExec(['sh', '-lc', cmd], { timeout: 120000 });
  return parseIsqlValue(stdout);
}

async function databaseDiagnostics() {
  const dbs = await prisma.managedDatabase.findMany({ where: { type: { not: 'ARQUIVADO' } }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] });
  const diagnostics = [];
  for (const db of dbs) {
    try {
      const [version, licensedUnit] = await Promise.all([
        queryDatabaseValue(db, 'select first 1 VERSAO from VERSAO_BANCO;'),
        queryDatabaseValue(db, 'select first 1 NOME from EMPRESA_SINTEGRA;')
      ]);
      diagnostics.push({
        id: db.id,
        name: db.name,
        alias: db.alias,
        ok: true,
        path: effectiveDatabasePath(db),
        pathRole: effectiveDatabasePath(db) === db.filePath ? 'production' : 'standby_read_only',
        fileSizeBytes: databaseFileSize(db),
        version: version || 'Nao informado',
        licensedUnit: licensedUnit || 'Nao informado'
      });
    } catch (err) {
      diagnostics.push({
        id: db.id,
        name: db.name,
        alias: db.alias,
        ok: false,
        path: effectiveDatabasePath(db),
        pathRole: effectiveDatabasePath(db) === db.filePath ? 'production' : 'standby_read_only',
        fileSizeBytes: databaseFileSize(db),
        version: 'Erro',
        licensedUnit: 'Erro',
        error: err.message
      });
    }
  }
  return diagnostics;
}

export async function runPreflight() {
  const checks = [];
  for (const bin of bins) {
    try {
      await firebirdExec(['test', '-x', `${FIREBIRD_BIN}/${bin}`]);
      checks.push({ key: bin, ok: true, message: `${bin} OK` });
    } catch (err) {
      checks.push({ key: bin, ok: false, message: `${bin} ausente ou sem execucao` });
    }
  }
  for (const dir of dirs) {
    try {
      await firebirdExec(['sh','-lc',`test -d ${dir} && test -w ${dir}`]);
      checks.push({ key: dir, ok: true, message: `${dir} gravavel` });
    } catch {
      checks.push({ key: dir, ok: false, message: `${dir} nao esta gravavel` });
    }
  }

  const storageRoot = process.env.STORAGE_ROOT || '';
  const storageOk = dirs.every(dir => checks.find(c => c.key === dir)?.ok);
  checks.push({
    key: 'storage',
    ok: storageOk,
    message: storageRoot ? `STORAGE_ROOT montado via volumes: ${storageRoot}` : 'STORAGE_ROOT nao informado'
  });

  const databases = await databaseDiagnostics();
  for (const db of databases) {
    if (db.ok) {
      checks.push({ key: `db:${db.alias}:version`, ok: true, message: `${db.name}: versao do banco ${db.version}` });
      checks.push({ key: `db:${db.alias}:licensedUnit`, ok: true, message: `${db.name}: empresa Sintegra ${db.licensedUnit}` });
    } else {
      checks.push({ key: `db:${db.alias}:metadata`, ok: false, message: `${db.name}: erro lendo versao/unidade - ${db.error}` });
    }
  }

  const ok = checks.every(c => c.ok);
  return { ok, checks, databases, generatedAt: new Date().toISOString() };
}
