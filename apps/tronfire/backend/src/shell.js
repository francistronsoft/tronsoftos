import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

function postJsonLong(urlString, body, headers = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(data)
      }
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = chunks.join('');
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (err) {
          const error = new Error(`Resposta invalida do TronSystem: ${err.message}`);
          error.statusCode = res.statusCode;
          error.body = text.slice(0, 1000);
          reject(error);
          return;
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, payload });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Tempo limite excedido na chamada HTTP host apos ${Math.round(timeoutMs / 60000)} min`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runHostFirebirdShell(args, timeoutMs = 60_000) {
  const token = internalTokenValue();
  if (!token) throw new Error('TRONSOFTOS_INTERNAL_TOKEN nao configurado');
  const response = await postJsonLong(
    `${TRONSOFTOS_API_URL}/api/host/firebird/script`,
    {
      script: `# TronFire host Firebird script\n${shellCommandFromArgs(args)}\n`,
      timeoutMs
    },
    {
      'content-type': 'application/json',
      'x-tronsoftos-token': token
    },
    timeoutMs + 120_000
  );
  const payload = response.payload || {};
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
