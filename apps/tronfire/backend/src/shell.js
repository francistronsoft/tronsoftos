import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

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
  if (mode === 'host' || mode === 'direct') {
    const [command, ...commandArgs] = args;
    const { stdout, stderr } = await execFileAsync(command, commandArgs, execOptions(options));
    return { stdout, stderr };
  }
  const container = process.env.FIREBIRD_CONTAINER || 'tronfire_firebird25';
  const { stdout, stderr } = await execFileAsync('docker', ['exec', container, ...args], execOptions(options));
  return { stdout, stderr };
}
