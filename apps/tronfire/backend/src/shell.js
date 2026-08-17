import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
const execFileAsync = promisify(execFile);
const TRONSOFTOS_STATE_DIR = process.env.TRONSOFTOS_STATE_DIR || '/opt/tronsoftos/state';
const CLUSTER_SECRETS_FILE = process.env.TRONSOFTOS_CLUSTER_SECRETS || `${TRONSOFTOS_STATE_DIR}/cluster-secrets.env`;
const TRONSOFTOS_API_URL = String(process.env.TRONSOFTOS_API_URL || 'http://host.docker.internal:8080').replace(/\/+$/, '');

function execOptions(options = {}) {
  const firebirdHome = process.env.FIREBIRD || '/usr/local/firebird';
  const firebirdLib = process.env.FIREBIRD_LIB || '/usr/local/firebird/lib';
  const currentLdPath = process.env.LD_LIBRARY_PATH || '';
  return {
    timeout: options.timeout || 60_000,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 5,
    env: {
      ...process.env,
      ...(options.env || {}),
      FIREBIRD: firebirdHome,
      LD_LIBRARY_PATH: [firebirdLib, currentLdPath].filter(Boolean).join(':')
    }
  };
}

export async function docker(args, options = {}) {
  const { stdout, stderr } = await execFileAsync('docker', args, execOptions(options));
  return { stdout, stderr };
}

export async function dockerExec(args, options = {}) {
  return firebirdExec(args, options);
}

export async function firebirdExec(args, options = {}) {
  const mode = String(process.env.FIREBIRD_EXEC_MODE || 'container').toLowerCase();
  if (mode === 'host') {
    return runHostFirebirdShell(args, options.timeout || 60_000);
  }
  if (mode === 'direct') {
    const [command, ...commandArgs] = args;
    const { stdout, stderr } = await execFileAsync(command, commandArgs, execOptions(options));
    return { stdout, stderr };
  }
  const container = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
  const { stdout, stderr } = await execFileAsync('docker', ['exec', container, ...args], execOptions(options));
  return { stdout, stderr };
}

function parseEnvFile(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
        })
    );
  } catch {
    return {};
  }
}

function internalTokenValue() {
  return process.env.TRONSOFTOS_INTERNAL_TOKEN || parseEnvFile(CLUSTER_SECRETS_FILE).TRONSOFTOS_INTERNAL_TOKEN || '';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommandFromArgs(args = []) {
  if (args[0] === 'sh' && args[1] === '-lc') return String(args[2] || '');
  const [command, ...commandArgs] = args;
  return [command, ...commandArgs].map(shQuote).join(' ');
}

function stripHostScriptControlOutput(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return !(parsed?.ok === true && String(parsed?.script || '').includes('tronsoftos-firebird-'));
      } catch {
        return true;
      }
    })
    .join('\n');
}

async function runHostFirebirdShell(args, timeoutMs = 60_000) {
  const token = internalTokenValue();
  if (!token) throw new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado');
  const response = await fetch(`${TRONSOFTOS_API_URL}/api/host/firebird/script`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tronsoftos-token': token
    },
    body: JSON.stringify({
      script: `# TronFire host Firebird script\n${shellCommandFromArgs(args)}\n`,
      timeoutMs
    }),
    signal: AbortSignal.timeout(timeoutMs + 60_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `TronSoftOS HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return {
    stdout: stripHostScriptControlOutput(payload.stdout || ''),
    stderr: payload.stderr || ''
  };
}
